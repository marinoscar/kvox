import { Logger } from '@nestjs/common';
import { survivingKeyPrefixes, type StorageProvider } from '@marinoscar/platform-api/storage';
import { USER_DATA_CHUNK_SIZE, deleteStorageObjects } from '@marinoscar/platform-api/user-data';
import type { FactoryResetStepDef, UserDataDbPort } from '@marinoscar/platform-api/user-data';

// =============================================================================
// The storage sweep of the admin factory reset (issue #562)
// =============================================================================
//
// The platform's factory reset deletes every storage object outside the
// `survivesFactoryReset` prefixes as its step 7, but only for an app that flags one
// model `storageObjects: true`. This app deliberately does not (a user's deletion must
// not collect objects a transcript or note still owns, see `user-data.manifest.ts`), so
// that step never runs and no byte would leave the bucket. This is the same sweep, as a
// registered step. It lives here, next to the gateway, because only this module may name
// the storage tables (`test/kvox-objects/storage-boundary.spec.ts`);
// `platform/user-data/factory-reset.steps.ts` registers it with the other two and explains
// the whole reset.
//
// It runs AFTER `kvox.content` (no transcript, note or graph export is left to Restrict an
// object row) and after the users are gone, on the bypass client and OUTSIDE the step's
// transaction: the provider is not transactional, and progress must survive a retry. Each
// page selects what is still there. A provider failure keeps the row and is counted in
// `storageObjectsFailed`; it never throws. The rows go with their `kvox_object_ownership`
// marker and multipart chunks by cascade.
//
// The same sweep, filtered to one organization, is the storage step of the organization
// offboarding (`runKvoxOrgStorageObjects`, issue #568); it shares the bound ports below.
// =============================================================================

const logger = new Logger('KvoxFactoryReset');

/** Provider deletes in flight at once while sweeping (each is a network round trip). */
const SWEEP_CONCURRENCY = 8;

/** Ids handed to one `deleteStorageObjects` call. */
const SWEEP_SLICE = 100;

/**
 * What the storage sweep needs from the host, which a plain step function cannot inject.
 *
 * @internal
 */
export interface KvoxFactoryResetDeps {
  /** The bypass client port (`USER_DATA_DB`). */
  readonly db: Pick<UserDataDbPort, 'system'>;
  /** The active storage provider. */
  readonly storage: Pick<StorageProvider, 'delete' | 'abortMultipartUpload'>;
}

let deps: KvoxFactoryResetDeps | undefined;

/**
 * Hands the storage sweep its host ports. Called once at bootstrap by
 * `KvoxFactoryResetBinding` (`platform/user-data/user-data-host.module.ts`); a test calls it with its own.
 *
 * @param next - the ports, or `undefined` to unbind.
 */
export function bindKvoxFactoryResetDeps(next: KvoxFactoryResetDeps | undefined): void {
  deps = next;
}

/** Whether the storage sweep has its ports (the app binds them at bootstrap). */
export function isKvoxFactoryResetBound(): boolean {
  return deps !== undefined;
}

function requireDeps(): KvoxFactoryResetDeps {
  if (!deps) {
    throw new Error(
      'kvox.storage-objects: the factory reset storage sweep has no ports; ' +
        'UserDataHostModule must be mounted (KvoxFactoryResetBinding).',
    );
  }

  return deps;
}

/** Splits a list into slices of at most `size`. */
function slices<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));

  return out;
}

/** The `where` that leaves out every object under a surviving key prefix (database backups). */
function notSurvivingFilter(): Record<string, unknown> {
  const surviving = survivingKeyPrefixes();

  return surviving.length > 0
    ? { NOT: { OR: surviving.map((prefix) => ({ storageKey: { startsWith: prefix } })) } }
    : {};
}

/**
 * Deletes every storage object matching `where` (bytes, then the row), paging by id cursor so
 * a retried call selects what is still there. A provider failure keeps the row and is counted;
 * it never throws. Shared by the factory reset sweep and the organization offboarding sweep.
 *
 * @param where - the base filter; the cursor is added to it on every page.
 * @param label - the caller named in the deletion's log lines (`admin.factory_reset`, ...).
 */
export async function sweepStorageObjects(
  where: Record<string, unknown>,
  label: string,
  sweepLogger: Logger = logger,
): Promise<{ storageObjectsDeleted: number; storageObjectsFailed: number }> {
  const { db, storage } = requireDeps();
  const system = db.system('purge');
  let cursor: string | undefined;
  let storageObjectsDeleted = 0;
  let storageObjectsFailed = 0;

  for (;;) {
    const page: { id: string }[] = await system.storageObject.findMany({
      where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: USER_DATA_CHUNK_SIZE,
    });

    if (page.length === 0) break;

    cursor = page[page.length - 1].id;

    // A few provider round trips at a time: each delete is a network call.
    for (const group of slices(slices(page.map((row) => row.id), SWEEP_SLICE), SWEEP_CONCURRENCY)) {
      const results = await Promise.all(
        group.map((ids) => deleteStorageObjects(system, storage as StorageProvider, sweepLogger, label, ids)),
      );

      for (const result of results) {
        storageObjectsDeleted += result.storageObjectsDeleted;
        storageObjectsFailed += result.storageObjectsFailed;
      }
    }
  }

  return { storageObjectsDeleted, storageObjectsFailed };
}

/**
 * Every storage object outside the `survivesFactoryReset` prefixes: the bytes, then the row.
 * See the header for why this app registers it and for its transaction posture.
 */
export const KVOX_STORAGE_STEP: FactoryResetStepDef = {
  id: 'kvox.storage-objects',
  phase: 'deployment',
  description: 'Every stored file outside the surviving prefixes (database backups): bytes, then the row.',
  async run(): Promise<Record<string, number>> {
    return sweepStorageObjects(notSurvivingFilter(), 'admin.factory_reset');
  },
};

/**
 * The storage step of the organization offboarding (issue #568): every storage object of ONE
 * organization outside the surviving prefixes, bytes then row. The platform's `org.offboard`
 * handler would run `storage_objects.deleteMany({ orgId })` for this app (`StorageObject` is not
 * flagged `storageObjects: true`), which fails on the `Restrict` references and never deletes a
 * byte; `platform/user-data/offboarding.steps.ts` runs this first, after `kvox.org.content`.
 *
 * Retry-safe (each page selects what is left). A provider failure keeps the row and, after the
 * whole sweep, THROWS so the job retries: the organization row cannot go while an object
 * references it.
 *
 * @param input - the organization and the job (for the log lines).
 * @returns the counts, when nothing failed.
 * @throws Error when at least one object could not be deleted.
 */
export async function runKvoxOrgStorageObjects(input: {
  orgId: string;
  jobId: string;
}): Promise<{ storageObjectsDeleted: number; storageObjectsFailed: number }> {
  const counts = await sweepStorageObjects(
    { orgId: input.orgId, ...notSurvivingFilter() },
    `org.offboard job ${input.jobId}`,
  );

  logger.log(
    `org.offboard job ${input.jobId}: organization ${input.orgId} storage objects deleted=${counts.storageObjectsDeleted} failed=${counts.storageObjectsFailed}`,
  );

  if (counts.storageObjectsFailed > 0) {
    throw new Error(
      `kvox.org.storage-objects: org.offboard job ${input.jobId}: ${counts.storageObjectsFailed} storage object(s) ` +
        'could not be deleted; the organization is kept so a retry can finish them',
    );
  }

  return counts;
}
