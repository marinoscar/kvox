import { Inject, Injectable } from '@nestjs/common';

import { KG_LIBRARY_RECONCILE_JOB_TYPE, KG_SUBJECT_USER } from '../../graph/index.js';
import { KVOX_JOBS, type KvoxEnqueueResult, type KvoxJobsPort } from '../../ports/index.js';
import { KG_EXTRACT_BULK_PRIORITY } from '../extraction/graph-extraction.service.js';

/**
 * What a `kg.library_reconcile` job carries: identifiers only.
 *
 * @stability experimental
 */
export interface KgLibraryReconcilePayload {
  /** The owner whose library notes are reconciled. */
  ownerId: string;
  /** Narrow to one library. */
  libraryId?: string;
  /** Narrow to the files of one import batch. */
  batchId?: string;
}

/**
 * Queues `kg.library_reconcile`. The subject is the owner, so the queue collapses a request
 * into the owner's pending run; a request that arrives while a run is working is covered by the
 * next settled batch or scan.
 *
 * @stability experimental
 */
@Injectable()
export class GraphReconcileEnqueuer {
  constructor(@Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort) {}

  /**
   * @param input - the owner, and optionally the library or batch to narrow to.
   * @param options - `continuation` queues a follow-up run despite one working (the cap was hit).
   * @returns the job id and whether it joined an existing job.
   */
  async enqueue(
    input: KgLibraryReconcilePayload,
    options: { continuation?: boolean } = {},
  ): Promise<KvoxEnqueueResult> {
    const payload: KgLibraryReconcilePayload = {
      ownerId: input.ownerId,
      ...(input.libraryId ? { libraryId: input.libraryId } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
    };
    return this.jobs.enqueue({
      type: KG_LIBRARY_RECONCILE_JOB_TYPE,
      reason: 'backfill',
      subjectType: KG_SUBJECT_USER,
      subjectId: input.ownerId,
      payload: payload as unknown as Record<string, unknown>,
      priority: KG_EXTRACT_BULK_PRIORITY,
      ...(options.continuation ? { skipDedup: true, scheduledFor: new Date(Date.now() + 30_000) } : {}),
    });
  }
}
