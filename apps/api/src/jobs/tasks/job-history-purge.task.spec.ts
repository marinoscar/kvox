// =============================================================================
// Unit tests for the nightly history-purge scheduler (issue #263, epic #254)
// =============================================================================
//
// This task's entire job is to decide whether to enqueue, so that decision is
// all this file asserts: the disabled switch, the already-queued guard, and
// the two properties of the row it creates that matter — a LOW priority
// (ascending is more urgent) and no subject, which is what gives the type its
// constant dedup key.
// =============================================================================

import { Job } from '@prisma/client';

import { JobHistoryPurgeTask } from './job-history-purge.task';
import { JOB_HISTORY_PURGE_TYPE } from '../handlers/job-history-purge.handler';
import type { JobsService } from '../jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SystemSettingsService } from '../../settings/system-settings/system-settings.service';

function makeTask(options: { purgeEnabled?: boolean; active?: unknown; enqueue?: jest.Mock }) {
  const findFirst = jest.fn().mockResolvedValue(options.active ?? null);
  const prisma = { job: { findFirst } } as unknown as PrismaService;

  const getJobsPolicy = jest.fn().mockResolvedValue({
    history: { retentionDays: 30, purgeEnabled: options.purgeEnabled ?? true },
    stuckThresholdMinutes: 30,
  });
  const systemSettings = { getJobsPolicy } as unknown as SystemSettingsService;

  const enqueue =
    options.enqueue ?? jest.fn().mockResolvedValue({ id: 'purge-1' } as unknown as Job);
  const jobs = { enqueue } as unknown as JobsService;

  return {
    task: new JobHistoryPurgeTask(prisma, systemSettings, jobs),
    findFirst,
    enqueue,
    getJobsPolicy,
  };
}

describe('JobHistoryPurgeTask', () => {
  it('queues a purge when one is enabled and none is in flight', async () => {
    const { task, enqueue } = makeTask({});

    await task.handleCron();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      type: JOB_HISTORY_PURGE_TYPE,
      reason: 'backfill',
    });
  });

  it('queues it at a LOW priority, since ascending is more urgent', async () => {
    // 100 is the least urgent thing in the queue, not the most: the claim
    // orders by `priority ASC`, so every ordinary job (priority 0) is taken
    // ahead of housekeeping.
    const { task, enqueue } = makeTask({});

    await task.handleCron();

    expect(enqueue.mock.calls[0][0].priority).toBe(100);
    expect(enqueue.mock.calls[0][0].priority).toBeGreaterThan(0);
  });

  it('queues it as a global job with no subject', async () => {
    // Both subject fields absent is what folds into a constant dedup key for
    // this type, which is what makes the active-dedup index guarantee at most
    // one purge in flight.
    const { task, enqueue } = makeTask({});

    await task.handleCron();

    const input = enqueue.mock.calls[0][0] as Record<string, unknown>;

    expect(input.subjectType ?? null).toBeNull();
    expect(input.subjectId ?? null).toBeNull();
    expect(input.skipDedup).toBeUndefined();
  });

  it('queues nothing when the purge is disabled', async () => {
    const { task, enqueue, findFirst } = makeTask({ purgeEnabled: false });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('skips when a purge is already pending', async () => {
    const { task, enqueue } = makeTask({ active: { id: 'purge-0', status: 'pending' } });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips when a purge is still running from a previous night', async () => {
    const { task, enqueue } = makeTask({ active: { id: 'purge-0', status: 'running' } });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('looks for an in-flight purge by type and active status only', async () => {
    const { task, findFirst } = makeTask({});

    await task.handleCron();

    expect(findFirst.mock.calls[0][0].where).toEqual({
      type: JOB_HISTORY_PURGE_TYPE,
      status: { in: ['pending', 'running'] },
    });
  });

  it('swallows an enqueue failure rather than rejecting out of the cron handler', async () => {
    const enqueue = jest.fn().mockRejectedValue(new Error('connection reset'));
    const { task } = makeTask({ enqueue });

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
