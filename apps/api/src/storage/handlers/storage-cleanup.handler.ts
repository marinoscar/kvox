// =============================================================================
// `storage.cleanup.stale-uploads` — abandoned uploads, as a queue job
// (issue #353, epic #345)
// =============================================================================
//
// An upload that was initialised and never finished leaves two things behind: a
// `storage_objects` row stuck at `pending`/`uploading`, and — for a multipart
// upload — PARTS ALREADY BILLED IN THE BUCKET that no object references. The
// second is why this sweep is not merely tidiness: S3-compatible providers
// charge for uncompleted multipart parts indefinitely, and nothing else in this
// application ever aborts them.
//
// The logic below is `storage/tasks/storage-cleanup.task.ts`'s, moved verbatim
// apart from its logging. WHAT CHANGED IS THE EXECUTOR. Inline in a 4am cron
// this loop made one network round trip per stale upload, on the scheduler's
// thread, with no timeout and no retry, and a deployment that had accumulated a
// thousand abandoned uploads would spend as long as that took blocking nothing
// visible and appearing nowhere. As a job it holds a worker slot, is bounded by
// `JOBS_JOB_TIMEOUT_MS`, and leaves a row with a duration.
//
// -----------------------------------------------------------------------------
// ⚠ PER-UPLOAD FAILURES ARE COUNTED, NOT THROWN — AND THE JOB STILL FAILS IF
// EVERY ONE OF THEM DID
// -----------------------------------------------------------------------------
//
// The loop swallows one upload's failure and moves to the next, exactly as the
// cron did, because one wedged multipart upload must not stop the other 999
// from being reclaimed. But a handler that ALWAYS returns normally is a handler
// whose `succeeded` row means nothing (`job-handler.interface.ts`: "a job that
// silently reports success is far worse than one that retries something it did
// not need to"). So the two are reconciled: partial failure is reported in the
// log and the job succeeds; TOTAL failure — every candidate errored, which is
// what a misconfigured or unreachable bucket looks like — throws, and the queue
// retries it with backoff.
//
// SERVER-ONLY BY DERIVATION: neither `nodeResultSchema` nor `persistNodeResult`.
// It reads this application's tables and issues deletes against them as it
// goes, which is the shape `job-handler.interface.ts` names as server-only by
// nature — there is no result for a remote machine to compute and post back.
//
// NO PROFILE: the work is idempotent (a row already deleted is simply not found
// next time) and short, so the deployment-wide ceiling and attempt budget are
// right for it.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../providers';

/**
 * The handler key, and therefore the `Job.type` every stale-upload sweep row
 * carries. PERMANENT — rows outlive handlers. Exported so the scheduling task
 * asks about the same string it queues.
 */
export const STORAGE_CLEANUP_TYPE = 'storage.cleanup.stale-uploads';

/**
 * How long an unfinished upload is left alone before it is considered
 * abandoned.
 *
 * TWENTY-FOUR HOURS, carried over from the cron this handler replaces. It is a
 * generous ceiling on a resumable upload rather than a guess: a client
 * genuinely still uploading refreshes the row, and one that stopped a day ago
 * is not coming back.
 */
const CLEANUP_AGE_HOURS = 24;

/** What one sweep did. Returned so a test can assert the split directly. */
export interface StaleUploadCleanupResult {
  /** Rows removed, with any multipart upload aborted first. */
  removed: number;
  /** Candidates that could not be reclaimed. Retried on the next sweep. */
  failed: number;
}

@Injectable()
export class StorageCleanupHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(StorageCleanupHandler.name);

  readonly type = STORAGE_CLEANUP_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Aborts and deletes every upload that has been unfinished for longer than
   * {@link CLEANUP_AGE_HOURS}.
   *
   * Throws only when EVERY candidate failed — see the file header for why that
   * is the line between "one wedged upload" and "the bucket is unreachable".
   */
  async process(job: Job): Promise<void> {
    const { removed, failed } = await this.sweep();

    if (removed === 0 && failed === 0) {
      this.logger.log(`Storage cleanup job ${job.id}: no stale uploads to clean up`);

      return;
    }

    this.logger.log(
      `Storage cleanup job ${job.id}: ${removed} stale upload(s) removed, ${failed} failed`
    );

    if (removed === 0 && failed > 0) {
      // EVERY candidate failed. That is not "a wedged upload", it is a storage
      // provider this process cannot talk to, and the queue's backoff is a
      // better response than waiting until 4am tomorrow.
      throw new Error(
        `Every one of the ${failed} stale upload(s) failed to clean up; the storage ` +
          'provider is most likely unreachable or misconfigured'
      );
    }
  }

  /**
   * The sweep itself.
   *
   * Exposed as its own method so a test can drive it and read the split without
   * going through `process`'s throw rule.
   */
  async sweep(): Promise<StaleUploadCleanupResult> {
    const cleanupBefore = new Date();
    cleanupBefore.setHours(cleanupBefore.getHours() - CLEANUP_AGE_HOURS);

    const staleUploads = await this.prisma.storageObject.findMany({
      where: {
        status: { in: ['pending', 'uploading'] },
        createdAt: { lt: cleanupBefore },
      },
      select: {
        id: true,
        storageKey: true,
        s3UploadId: true,
      },
    });

    let removed = 0;
    let failed = 0;

    for (const upload of staleUploads) {
      try {
        // ⚠ ABORT BEFORE DELETE, NEVER AFTER. The row is the only record of
        // `s3UploadId`, so deleting it first and then failing to abort leaves
        // billed multipart parts that nothing in this application can ever name
        // again. With this order, a failed abort leaves a row an operator (or
        // the next sweep) can retry.
        if (upload.s3UploadId) {
          await this.storageProvider.abortMultipartUpload(
            upload.storageKey,
            upload.s3UploadId
          );
        }

        // Chunks cascade.
        await this.prisma.storageObject.delete({ where: { id: upload.id } });

        removed++;
        this.logger.debug(`Cleaned up stale upload: ${upload.id}`);
      } catch (error) {
        failed++;
        this.logger.error(
          `Failed to clean up upload ${upload.id}: ` +
            `${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    return { removed, failed };
  }
}
