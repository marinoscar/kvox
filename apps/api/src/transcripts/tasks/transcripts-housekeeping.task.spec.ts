import { Test } from '@nestjs/testing';

import { JobsService } from '../../jobs/jobs.service';
import { HOUSEKEEPING_PRIORITY } from '../../jobs/housekeeping.enqueue';
import { PrismaService } from '../../prisma/prisma.service';
import { TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE } from '../job-types';
import { TranscriptsHousekeepingTask } from './transcripts-housekeeping.task';

// =============================================================================
// The transcript housekeeping cron (issue #25)
// =============================================================================
//
// `test/jobs/cron-enqueue-only.spec.ts` already reads this file's `@Cron` body
// and fails the build if it does work inline. This spec pins the other half:
// that it queues the RIGHT type, at the housekeeping priority, and that a
// sweep already in flight is not queued behind itself.
// =============================================================================

describe('TranscriptsHousekeepingTask', () => {
  let task: TranscriptsHousekeepingTask;
  let jobs: { enqueue: jest.Mock };
  let prisma: { job: { findFirst: jest.Mock } };

  beforeEach(async () => {
    jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    prisma = { job: { findFirst: jest.fn().mockResolvedValue(null) } };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptsHousekeepingTask,
        { provide: JobsService, useValue: jobs },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    task = module.get(TranscriptsHousekeepingTask);
  });

  it('queues the sweep rather than performing it', async () => {
    await task.handleCron();

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE,
        reason: 'backfill',
        priority: HOUSEKEEPING_PRIORITY,
      }),
    );
  });

  it('never claims ahead of user-facing work', () => {
    // `HOUSEKEEPING_PRIORITY` is 100 and ascending is more urgent, so this
    // sits behind every default-priority job in the queue.
    expect(HOUSEKEEPING_PRIORITY).toBeGreaterThan(0);
  });

  it('skips the tick when a previous sweep is still in flight', async () => {
    prisma.job.findFirst.mockResolvedValue({ id: 'job-0', status: 'running' });

    await task.handleCron();

    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('never throws — an unhandled rejection in a @Cron terminates the process', async () => {
    prisma.job.findFirst.mockRejectedValue(new Error('database blip'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
