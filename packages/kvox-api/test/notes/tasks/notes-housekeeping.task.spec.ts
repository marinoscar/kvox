import { Test } from '@nestjs/testing';

import { KVOX_JOBS } from '../../../src/ports/index.js';
import { NOTES_HOUSEKEEPING_JOB_TYPE } from '../../../src/notes/job-types.js';
import { NotesHousekeepingEnqueuer } from '../../../src/notes/tasks/notes-housekeeping.enqueuer.js';
import { NotesHousekeepingTask } from '../../../src/notes/tasks/notes-housekeeping.task.js';

// =============================================================================
// The note housekeeping cron (issue #53, epic #45; the package form of issue #495)
// =============================================================================
//
// The `cron-enqueue-only` conformance suite already reads this file's `@Cron` body and fails the
// build if it does work inline - and it does so WITHOUT a new exemption, which is the acceptance
// criterion. This spec pins the other half: that it queues the RIGHT type, at the housekeeping
// priority, and that a sweep already in flight is not queued behind itself.
// =============================================================================

describe('NotesHousekeepingTask', () => {
  let task: NotesHousekeepingTask;
  let jobs: { enqueue: jest.Mock; findActive: jest.Mock };

  beforeEach(async () => {
    jobs = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-1', deduplicated: false }),
      findActive: jest.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [NotesHousekeepingTask, { provide: KVOX_JOBS, useValue: jobs }],
    }).compile();

    task = module.get(NotesHousekeepingTask);
  });

  it('queues the sweep rather than performing it', async () => {
    await task.handleCron();

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NOTES_HOUSEKEEPING_JOB_TYPE,
        reason: 'backfill',
        priority: 100,
      }),
    );
  });

  it('is the cron form of the enqueuer a host without a scheduler calls itself', async () => {
    expect(task).toBeInstanceOf(NotesHousekeepingEnqueuer);
    await expect(task.enqueue()).resolves.toBe('job-1');
  });

  it('never claims ahead of user-facing work', async () => {
    await task.handleCron();

    // Ascending is more urgent and the default is 0, so 100 sits behind every default-priority job.
    expect(jobs.enqueue.mock.calls[0][0].priority).toBeGreaterThan(0);
  });

  it('skips the tick when a previous sweep is still in flight', async () => {
    jobs.findActive.mockResolvedValue([{ id: 'job-0', type: NOTES_HOUSEKEEPING_JOB_TYPE }]);

    await task.handleCron();

    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('never throws - an unhandled rejection in a @Cron terminates the process', async () => {
    jobs.findActive.mockRejectedValue(new Error('database blip'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
