// =============================================================================
// Unit tests for the fleet-sweep SCHEDULER (issue #270, converted by #353)
// =============================================================================
//
// ⚠ WHAT THIS FILE NO LONGER TESTS IS THE POINT OF IT. Before #353 (epic #345)
// this task swept: it sent the `updateManyAndReturn` and raised
// `nodes.node_offline`. Those assertions did not disappear — they moved, intact,
// to `handlers/node-fleet-sweep.handler.spec.ts` beside the code they cover.
//
// What is left here is everything that genuinely belongs to a cron, and the one
// property #353 introduced:
//
//   - IT ENQUEUES AND DOES NOT SWEEP. The regression this guards is a future
//     change quietly putting the work back inline, which would make the sweep
//     invisible in the admin job list again.
//   - IT STOPS FOR ITS KILL SWITCH, which stayed with the scheduling decision.
//   - IT NEVER REJECTS out of the `@Cron` handler.
// =============================================================================

import { ConfigService } from '@nestjs/config';

import { NodeStaleOfflineTask } from './node-stale-offline.task';
import { NODE_FLEET_SWEEP_TYPE } from '../handlers/node-fleet-sweep.handler';
import type { JobsService } from '../../jobs/jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makeTask(config: Record<string, unknown> = {}, active: unknown = null) {
  const findFirst = jest.fn().mockResolvedValue(active);
  const prisma = { job: { findFirst } } as unknown as PrismaService;
  const enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
  const jobs = { enqueue } as unknown as JobsService;
  const configService = {
    get: jest.fn((key: string) => config[key]),
  } as unknown as ConfigService;

  return {
    task: new NodeStaleOfflineTask(jobs, prisma, configService),
    enqueue,
    findFirst,
  };
}

describe('NodeStaleOfflineTask', () => {
  it('queues nodes.fleet.sweep instead of sweeping inline', async () => {
    const { task, enqueue } = makeTask();

    await task.handleCron();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      type: NODE_FLEET_SWEEP_TYPE,
      reason: 'backfill',
    });
  });

  it('queues it as low priority, so housekeeping never outranks real work', async () => {
    // ⚠ ASCENDING IS MORE URGENT: 100 is LOW. Every ordinary job takes the
    // column default (0) and therefore beats this one to a slot.
    const { task, enqueue } = makeTask();

    await task.handleCron();

    expect(enqueue.mock.calls[0][0].priority).toBe(100);
  });

  it('queues it GLOBAL, so its dedup key is constant and one is ever active', async () => {
    const { task, enqueue } = makeTask();

    await task.handleCron();

    const input = enqueue.mock.calls[0][0];

    expect(input.subjectType).toBeUndefined();
    expect(input.subjectId).toBeUndefined();
    expect(input.skipDedup).toBeUndefined();
  });

  it('skips the enqueue when a sweep is already pending or running', async () => {
    // The cheap guard in front of the dedup index — it exists to keep the log
    // honest, not to close the race (the index does that).
    const { task, enqueue, findFirst } = makeTask({}, { id: 'job-0', status: 'running' });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
    expect(findFirst.mock.calls[0][0].where).toEqual({
      type: NODE_FLEET_SWEEP_TYPE,
      status: { in: ['pending', 'running'] },
    });
  });

  it('stops only for nodes.staleOfflineEnabled === false', async () => {
    const { task, enqueue, findFirst } = makeTask({ 'nodes.staleOfflineEnabled': false });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('queues when the switch is unset, so a missing key fails open', async () => {
    // A fleet whose liveness tracking silently stopped because of a typo looks
    // exactly like a perfectly healthy fleet.
    const { task, enqueue } = makeTask({});

    await task.handleCron();

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed enqueue rather than rejecting out of the cron handler', async () => {
    const { task, enqueue } = makeTask();
    enqueue.mockRejectedValue(new Error('connection reset'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
