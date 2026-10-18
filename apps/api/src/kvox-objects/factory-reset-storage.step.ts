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

/**
 * Every storage object outside the `survivesFactoryReset` prefixes: the bytes, then the row.
 * See the header for why this app registers it and for its transaction posture.
 */
export const KVOX_STORAGE_STEP: FactoryResetStepDef = {
  id: 'kvox.storage-objects',
  phase: 'deployment',
  description: 'Every stored file outside the surviving prefixes (database backups): bytes, then the row.',
  async run(): Promise<Record<string, number>> {
    const { db, storage } = requireDeps();
    const system = db.system('purge');
    const surviving = survivingKeyPrefixes();
    const notSurviving =
      surviving.length > 0 ? { NOT: { OR: surviving.map((prefix) => ({ storageKey: { startsWith: prefix } })) } } : {};
    let cursor: string | undefined;
    let storageObjectsDeleted = 0;
    let storageObjectsFailed = 0;

    for (;;) {
      const page: { id: string }[] = await system.storageObject.findMany({
        where: { ...notSurviving, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: USER_DATA_CHUNK_SIZE,
      });

      if (page.length === 0) break;

      cursor = page[page.length - 1].id;

      // A few provider round trips at a time: each delete is a network call.
      for (const group of slices(slices(page.map((row) => row.id), SWEEP_SLICE), SWEEP_CONCURRENCY)) {
        const results = await Promise.all(
          group.map((ids) =>
            deleteStorageObjects(system, storage as StorageProvider, logger, 'admin.factory_reset', ids),
          ),
        );

        for (const result of results) {
          storageObjectsDeleted += result.storageObjectsDeleted;
          storageObjectsFailed += result.storageObjectsFailed;
        }
      }
    }

    return { storageObjectsDeleted, storageObjectsFailed };
  },
};
