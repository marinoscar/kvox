import { Inject, Injectable } from '@nestjs/common';

import { KVOX_JOBS, type KvoxJobsPort } from '../../ports/index.js';
import { KG_PURGE_JOB_TYPE, KG_SUBJECT_USER } from '../job-types.js';

/**
 * GraphUserDataService: the graph slice's side of the host's account-data deletion.
 *
 * @extensionPoint
 * @stability experimental
 */
@Injectable()
export class GraphUserDataService {
  constructor(@Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort) {}

  /**
   * Queues the purge of a user's whole graph (`kg.purge`, `{ scope: 'all' }`): entities,
   * relations, items, evidence, proposals, exports and imports. Re-entrant, so a repeat is
   * harmless; the queue's ordinary active dedup collapses a second request into the first.
   *
   * @param userId - the account.
   * @returns the queued job's id.
   */
  async enqueuePurgeAll(userId: string): Promise<string> {
    const job = await this.jobs.enqueue({
      type: KG_PURGE_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_USER,
      subjectId: userId,
      payload: { scope: 'all', userId },
    });

    return job.id;
  }
}
