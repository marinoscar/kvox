// =============================================================================
// Unit tests for the fleet-prune SCHEDULER (issue #270, converted by #353)
// =============================================================================
//
// ⚠ WHAT THIS FILE NO LONGER TESTS IS THE POINT OF IT. Before #353 (epic #345)
// this task pruned. Those assertions did not disappear — they moved, intact, to
// `handlers/node-fleet-prune.handler.spec.ts` beside the code they cover,
// including the one this pair exists for (a node past retention that still
// holds a `running` job is not deleted).
//
// What is left is what genuinely belongs to a cron: it enqueues rather than
// deleting, it stops for its kill switch, and it never rejects.
// =============================================================================

import { ConfigService } from '@nestjs/config';

import { NodeOfflinePruneTask } from './node-offline-prune.task';
import { NODE_FLEET_PRUNE_TYPE } from '../handlers/node-fleet-prune.handler';
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

  return { task: new NodeOfflinePruneTask(jobs, prisma, configService), enqueue, findFirst };
}

describe('NodeOfflinePruneTask', () => {
  it('queues nodes.fleet.prune instead of deleting inline', async () => {
    const { task, enqueue } = makeTask();

    await task.handleCron();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      type: NODE_FLEET_PRUNE_TYPE,
      reason: 'backfill',
      priority: 100,
    });
  });

  it('skips the enqueue when a prune is already pending or running', async () => {
    const { task, enqueue } = makeTask({}, { id: 'job-0', status: 'pending' });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('stops only for nodes.offlinePruneEnabled === false', async () => {
    const { task, enqueue, findFirst } = makeTask({ 'nodes.offlinePruneEnabled': false });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('queues when the switch is unset, so a missing key fails open', async () => {
    const { task, enqueue } = makeTask();

    await task.handleCron();

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed enqueue rather than rejecting out of the cron handler', async () => {
    const { task, enqueue } = makeTask();
    enqueue.mockRejectedValue(new Error('connection reset'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
