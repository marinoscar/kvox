import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { ObjectsService } from '@marinoscar/platform-api/storage';
import type { JobExecutionProfile, JobHandler } from '@marinoscar/platform-api/jobs';
import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { FILES_PURGE_UNMANAGED_JOB_TYPE } from './job-types';
import { KvoxManagedObjectsService } from './kvox-managed-objects.service';

// =============================================================================
// `files.purge_unmanaged` (issue #480) — the `files` category of the Danger Zone
// =============================================================================
//
// Deletes the storage objects ONE user uploaded that no module manages: bytes
// first, then the row, through the platform's `ObjectsService.delete` (the one
// implementation of "remove an object's bytes, its row, its chunks, and write
// the audit event").
//
// -----------------------------------------------------------------------------
// WHY THIS IS A JOB AND NOT THE PLATFORM'S `files` STEP
// -----------------------------------------------------------------------------
//
// The platform's `user.data.purge` would delete EVERY storage object a user
// owns. In this application many objects are owned by a module: a transcript's
// audio and exports, a note's source document, a graph import or export. That
// ownership is the `kvox_object_ownership` side table (#469), and it exists so
// that only the module that understands an object can remove it. Deleting a
// managed object from a generic step would break a `Restrict` foreign key or,
// worse, delete the bytes before the row delete fails. So the `StorageObject`
// model's hint carries this job as its DELEGATE (and does not claim
// `storageObjects: true`), the platform never collects the user's whole object
// list, and the managed objects leave with their transcript or note.
//
// ⚠ `kvoxOwnership: null` (no ownership row) IS PART OF THE QUERY, not a check
// after the fact. `ObjectsService.delete` does NOT refuse a managed object (the
// 409 is a request hook on the generic route), so this filter is the only thing
// that keeps a live transcript's audio safe. `test/user-data/user-data-purge.db.spec.ts`
// pins it against a real database.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, AND RE-ENTRANT
// -----------------------------------------------------------------------------
//
// No `nodeResultSchema`, no `persistNodeResult`: it deletes bytes and rows as it
// goes (rule 2's "writes as it goes"), and a remote machine must never hold the
// authority to delete a user's objects.
//
// Each run selects what is still there, pages by id (a cursor, so an object
// whose bytes the provider would not delete is skipped for this run rather than
// re-read forever), counts provider failures and KEEPS those rows, and never
// throws on one. Asking for the deletion again retries them. Three attempts
// cover a database error mid-run.
// =============================================================================

/** Rows read per page. */
const PAGE = 200;

/** A STOP, NOT A BUDGET: a million objects. */
const MAX_PAGES = 5_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The user inside a payload, or `null` (total over garbage). */
export function readFilesPurgePayload(payload: unknown): { userId: string } | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const userId = (payload as Record<string, unknown>).userId;

  return typeof userId === 'string' && UUID_PATTERN.test(userId) ? { userId } : null;
}

@Injectable()
export class FilesPurgeUnmanagedHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(FilesPurgeUnmanagedHandler.name);

  readonly type = FILES_PURGE_UNMANAGED_JOB_TYPE;

  readonly label = 'Delete unmanaged uploads';

  /** Bounded database work plus one provider call per object; retried on a database error. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 30 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly managedObjects: KvoxManagedObjectsService,
    private readonly objects: ObjectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = readFilesPurgePayload(job.payload);

    if (!payload) {
      // Returns rather than throws: a payload this build cannot read names no
      // user, so there is nothing to delete and nothing a retry could learn.
      this.logger.warn(`Job ${job.id} carries no readable user id; nothing to do`);

      return;
    }

    const { userId } = payload;
    // The platform's delegate enqueue passes `orgId: null`; single-organization
    // mode resolves to the default organization, as the Danger Zone always did.
    const orgId = await this.managedObjects.resolveOrg(job.orgId);

    let deleted = 0;
    let failed = 0;
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await this.managedObjects.findMany(
        {
          where: {
            uploadedById: userId,
            kvoxOwnership: null,
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: PAGE,
        },
        { orgId },
      );

      if (rows.length === 0) {
        await this.finish(userId, deleted, failed);

        return;
      }

      for (const row of rows) {
        try {
          await this.objects.delete(row.id, userId, orgId);
          deleted += 1;
        } catch (error) {
          failed += 1;

          this.logger.warn(
            `Could not delete storage object ${row.id} for user ${userId}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      cursor = rows[rows.length - 1].id;
    }

    throw new Error(
      `Bulk file deletion for user ${userId} did not converge after ${MAX_PAGES} pages`,
    );
  }

  private async finish(userId: string, deleted: number, failed: number): Promise<void> {
    if (deleted > 0 || failed > 0) {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: 'user_data:files_deleted',
          targetType: 'user',
          targetId: userId,
          meta: { count: deleted, failed },
        },
      });
    }

    this.logger.log(`User ${userId}: ${deleted} unmanaged file(s) deleted, ${failed} could not be`);
  }
}
