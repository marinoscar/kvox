import { Test } from '@nestjs/testing';

import { KVOX_JOBS } from '../../../src/ports/index.js';
import { createFakeKvoxJobs } from '../../../src/testing/index.js';
import { TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE } from '../../../src/transcripts/job-types.js';
import { TranscriptsHousekeepingEnqueuer } from '../../../src/transcripts/tasks/transcripts-housekeeping.enqueuer.js';
import { TranscriptsHousekeepingTask } from '../../../src/transcripts/tasks/transcripts-housekeeping.task.js';

// =============================================================================
// The transcript housekeeping cron (issue #25)
// =============================================================================
//
// The `cron-enqueue-only` conformance suite already reads this file's `@Cron` body
// and fails the build if it does work inline. This spec pins the other half:
// that it queues the RIGHT type, at the housekeeping priority, and that a
// sweep already in flight is not queued behind itself.
// =============================================================================

describe('TranscriptsHousekeepingTask', () => {
  async function build() {
    const jobs = createFakeKvoxJobs();
    const module = await Test.createTestingModule({
      providers: [TranscriptsHousekeepingTask, { provide: KVOX_JOBS, useValue: jobs }],
    }).compile();

    return { jobs, task: module.get(TranscriptsHousekeepingTask) };
  }

  it('queues the sweep rather than performing it', async () => {
    const { jobs, task } = await build();

    await task.handleCron();

    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0].input).toMatchObject({
      type: TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE,
      reason: 'backfill',
      priority: 100,
    });
  });

  it('never claims ahead of user-facing work', async () => {
    // The priority is 100 and ascending is more urgent, so this sits behind every
    // default-priority job in the queue.
    const { jobs, task } = await build();

    await task.handleCron();

    expect(jobs.jobs[0].input.priority).toBeGreaterThan(0);
  });

  it('skips the tick when a previous sweep is still in flight', async () => {
    const { jobs, task } = await build();

    await task.handleCron();
    await task.handleCron();

    expect(jobs.jobs).toHaveLength(1);
  });

  it('never throws — an unhandled rejection in a @Cron terminates the process', async () => {
    const { jobs, task } = await build();

    jest.spyOn(jobs, 'findActive').mockRejectedValue(new Error('database blip'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });

  it('is the same tick a host without a scheduler calls itself', async () => {
    const { jobs, task } = await build();

    expect(task).toBeInstanceOf(TranscriptsHousekeepingEnqueuer);
    await expect(task.enqueue()).resolves.toEqual(expect.any(String));
    await expect(task.enqueue()).resolves.toBeNull();
    expect(jobs.jobs).toHaveLength(1);
  });
});
