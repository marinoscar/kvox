// =============================================================================
// Unit tests for the offline-node prune (issue #270; moved to a handler by #353)
// =============================================================================
//
// ⚠ THESE ARE THE CRON'S TESTS, ADAPTED. #353 (epic #345) moved the prune off
// `NodeOfflinePruneTask`'s `@Cron` body and onto `NodeFleetPruneHandler`, so
// every assertion about the three statements moved with it;
// `tasks/node-offline-prune.task.spec.ts` keeps what belongs to a cron (the
// kill switch, and that it enqueues rather than pruning).
//
// The acceptance criterion this file exists for is the one that is easy to get
// backwards: A NODE PAST RETENTION THAT IS STILL HOLDING A `running` JOB IS
// NOT DELETED, and it becomes deletable the moment that job settles. Deleting
// it would not break anything — `Job.claimedByNode` is `onDelete: SetNull`, so
// the job survives — which is exactly why nothing else would catch it: the
// damage is a `running` row owned by nobody, indistinguishable from the
// corrupt state the lease reaper's zombie signal exists to clean up after.
//
// The sequencing criterion (a crashed node becomes `offline` and is THEN
// prunable) lives in `test/nodes/node-fleet-lifecycle.spec.ts`, because it is
// a property of the pair rather than of this task.
// =============================================================================

import type { Job } from '@prisma/client';

import { NodeFleetPruneHandler, prunableOfflineNodeWhere } from './node-fleet-prune.handler';
import type { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { NodeLifecycleService } from '../node-lifecycle.service';
import type { PrismaService } from '../../prisma/prisma.service';

/** The row the worker hands `process`. Only `id` is read, for the log line. */
const JOB = { id: 'job-1' } as Job;

const POLICY = { staleHeartbeatSeconds: 90, offlineStaleMultiplier: 4, offlineRetentionDays: 30 };

interface FakeOptions {
  /** Candidate node ids the retention select returns. */
  candidates?: string[];

  /** Node ids that still hold a `running` job. */
  busy?: string[];

  /**
   * Kept so the kill-switch case below can pass one and prove it is IGNORED.
   * The handler takes no `ConfigService` at all since #353 — the switch lives
   * on the task that enqueues.
   */
  config?: Record<string, unknown>;
}

function makeHandler({ candidates = [], busy = [], config = {} }: FakeOptions = {}) {
  const findManyNodes = jest.fn().mockResolvedValue(candidates.map((id) => ({ id })));
  const findManyJobs = jest
    .fn()
    .mockResolvedValue(busy.map((claimedByNodeId) => ({ claimedByNodeId })));
  const deleteMany = jest.fn().mockImplementation(async ({ where }: any) => ({
    count: where.id.in.length,
  }));

  const prisma = {
    workerNode: { findMany: findManyNodes, deleteMany },
    job: { findMany: findManyJobs },
  } as unknown as PrismaService;

  const lifecycle = {
    getPolicy: jest.fn().mockResolvedValue(POLICY),
    retentionCutoff: (policy: typeof POLICY, now: Date) =>
      new Date(now.getTime() - policy.offlineRetentionDays * 86_400_000),
  } as unknown as NodeLifecycleService;

  // Kept so the "does not re-ask the kill switch" case below can pass one.
  void config;

  const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

  return {
    handler: new NodeFleetPruneHandler(registry, prisma, lifecycle),
    findManyNodes,
    findManyJobs,
    deleteMany,
  };
}

describe('NodeFleetPruneHandler', () => {
  it('selects only offline rows, aged by heartbeat or by registration', async () => {
    // Pruning by age alone would reach a `disabled` node — an administrator's
    // explicit intent, recorded nowhere else — and a `draining` node still
    // finishing a long job.
    const { handler, findManyNodes } = makeHandler();

    await handler.process(JOB);

    const { where } = findManyNodes.mock.calls[0][0];

    expect(where.status).toBe('offline');
    expect(where.OR).toEqual([
      { lastHeartbeatAt: { lt: expect.any(Date) } },
      { lastHeartbeatAt: null, registeredAt: { lt: expect.any(Date) } },
    ]);
  });

  it('does not delete a node that still holds a running job', async () => {
    const { handler, deleteMany } = makeHandler({ candidates: ['busy-node'], busy: ['busy-node'] });

    const result = await handler.prune();

    expect(deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, skippedBusy: 1 });
  });

  it('deletes that same node once its job has settled', async () => {
    // The skip is a deferral, not a refusal: the reaper settles or requeues
    // the job on its own schedule and the next daily tick takes the node.
    // Nothing has to be re-run by hand.
    const { handler, deleteMany } = makeHandler({ candidates: ['busy-node'], busy: [] });

    const result = await handler.prune();

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where.id).toEqual({ in: ['busy-node'] });
    expect(result).toEqual({ deleted: 1, skippedBusy: 0 });
  });

  it('deletes the idle candidates while skipping the busy one', async () => {
    const { handler, deleteMany } = makeHandler({
      candidates: ['idle-a', 'busy', 'idle-b'],
      busy: ['busy'],
    });

    const result = await handler.prune();

    expect(deleteMany.mock.calls[0][0].where.id).toEqual({ in: ['idle-a', 'idle-b'] });
    expect(result).toEqual({ deleted: 2, skippedBusy: 1 });
  });

  it('asks which nodes are busy in one query for the whole candidate set', async () => {
    const { handler, findManyJobs } = makeHandler({ candidates: ['a', 'b', 'c'] });

    await handler.prune();

    expect(findManyJobs).toHaveBeenCalledTimes(1);
    expect(findManyJobs.mock.calls[0][0]).toMatchObject({
      where: { status: 'running', claimedByNodeId: { in: ['a', 'b', 'c'] } },
      distinct: ['claimedByNodeId'],
    });
  });

  it('re-asserts the retention predicate on the delete, not just the ids', async () => {
    // Between the select and the delete a node may have re-registered, which
    // clears `offline` and stamps a fresh heartbeat. Deleting by id alone
    // would destroy a registration a worker is actively using.
    const { handler, deleteMany } = makeHandler({ candidates: ['a'] });

    await handler.prune();

    const { where } = deleteMany.mock.calls[0][0];

    expect(where.status).toBe('offline');
    expect(where.OR).toHaveLength(2);
  });

  it('asks nothing further when no node is past retention', async () => {
    const { handler, findManyJobs, deleteMany } = makeHandler({ candidates: [] });

    await expect(handler.prune()).resolves.toEqual({ deleted: 0, skippedBusy: 0 });
    expect(findManyJobs).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('does not re-ask the kill switch: a queued prune was already decided on', async () => {
    // ⚠ INVERTED BY #353. `NODE_OFFLINE_PRUNE_ENABLED` gates the ENQUEUE now
    // (`NodeOfflinePruneTask`), because a prune row that reached a worker was
    // queued by a process that had already decided to prune.
    const { handler, findManyNodes } = makeHandler({
      config: { 'nodes.offlinePruneEnabled': false },
    });

    await handler.process(JOB);

    expect(findManyNodes).toHaveBeenCalledTimes(1);
  });

  it('THROWS a failed prune rather than swallowing it', async () => {
    // ⚠ ALSO INVERTED BY #353: a cron had to swallow (an unhandled rejection
    // takes the process down); a handler must not, or a prune that never ran is
    // recorded as `succeeded`.
    const { handler, findManyNodes } = makeHandler();
    findManyNodes.mockRejectedValue(new Error('connection reset'));

    await expect(handler.process(JOB)).rejects.toThrow('connection reset');
  });
});

describe('prunableOfflineNodeWhere', () => {
  it('mirrors the stale sweep arm for arm', () => {
    // The two predicates are two halves of one lifecycle: ageing a
    // never-heartbeated node by `registeredAt` in the sweep and by
    // `lastHeartbeatAt` here would sweep it to `offline` and then never
    // delete it.
    const cutoff = new Date('2026-08-01T00:00:00.000Z');

    expect(prunableOfflineNodeWhere(cutoff)).toEqual({
      status: 'offline',
      OR: [
        { lastHeartbeatAt: { lt: cutoff } },
        { lastHeartbeatAt: null, registeredAt: { lt: cutoff } },
      ],
    });
  });
});
