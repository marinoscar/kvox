import type { JobsService } from '../../jobs/jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { KG_GRAPH_LAYOUT_JOB_TYPE } from '../job-types';
import { GRAPH_LAYOUT_COALESCE_MS, GraphLayoutEnqueuer } from './graph-layout.enqueuer';
import { GraphLayoutListener, isMaterialChange } from './graph-layout.listener';

// =============================================================================
// GraphLayoutListener (#371) — the ≥ 20 % material-change trigger, enqueue only
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';

function harness(opts: { snapshot?: number | null; current: number }) {
  const prisma = {
    kgGraphLayout: {
      findFirst: jest.fn(async () => (opts.snapshot === null || opts.snapshot === undefined ? null : { nodeCount: opts.snapshot })),
    },
    kgEntity: { count: jest.fn(async () => opts.current) },
    job: { findFirst: jest.fn(async () => null), updateMany: jest.fn() },
  };
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1', status: 'pending' })) };
  const enqueuer = new GraphLayoutEnqueuer(jobs as unknown as JobsService, prisma as unknown as PrismaService);
  const listener = new GraphLayoutListener(prisma as unknown as PrismaService, enqueuer);
  return { listener, prisma, jobs };
}

describe('isMaterialChange', () => {
  it('uses |now − snap| / max(snap, 50) ≥ 0.2', () => {
    expect(isMaterialChange(100, 119)).toBe(false);
    expect(isMaterialChange(100, 120)).toBe(true);
    expect(isMaterialChange(100, 80)).toBe(true);
    // The floor: 10 → 19 is +90 % but only 9/50.
    expect(isMaterialChange(10, 19)).toBe(false);
    expect(isMaterialChange(10, 20)).toBe(true);
  });
});

describe('GraphLayoutListener', () => {
  it('enqueues nothing for a below-threshold change', async () => {
    const { listener, jobs } = harness({ snapshot: 100, current: 105 });
    await expect(listener.reconcile({ ownerId: OWNER, reason: 'commit' })).resolves.toBe(false);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues one delayed, deduplicated backfill job for a ≥ 20 % change', async () => {
    const { listener, jobs } = harness({ snapshot: 100, current: 130 });
    const before = Date.now();
    await expect(listener.reconcile({ ownerId: OWNER, reason: 'commit' })).resolves.toBe(true);

    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    const input = (jobs.enqueue.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).toMatchObject({
      type: KG_GRAPH_LAYOUT_JOB_TYPE,
      reason: 'backfill',
      subjectType: 'user',
      subjectId: OWNER,
      payload: { ownerId: OWNER },
    });
    expect(input.skipDedup).toBeUndefined();
    const delay = (input.scheduledFor as Date).getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(GRAPH_LAYOUT_COALESCE_MS - 1000);
    expect(delay).toBeLessThanOrEqual(GRAPH_LAYOUT_COALESCE_MS + 5000);
    expect(GRAPH_LAYOUT_COALESCE_MS).toBe(120_000);
  });

  it('enqueues when there is no snapshot yet and the graph is non-empty', async () => {
    const { listener, jobs } = harness({ snapshot: null, current: 3 });
    await expect(listener.reconcile({ ownerId: OWNER, reason: 'commit' })).resolves.toBe(true);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueues nothing when there is no snapshot and nothing to lay out', async () => {
    const { listener, jobs } = harness({ snapshot: null, current: 0 });
    await expect(listener.reconcile({ ownerId: OWNER, reason: 'purge' })).resolves.toBe(false);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('counts only this owner’s readable, non-merged entities', async () => {
    const { listener, prisma } = harness({ snapshot: 100, current: 100 });
    await listener.reconcile({ ownerId: OWNER, reason: 'merge' });
    expect(prisma.kgEntity.count).toHaveBeenCalledWith({
      where: { ownerId: OWNER, reviewStatus: { in: ['accepted', 'edited'] }, mergedIntoId: null },
    });
    expect(prisma.kgGraphLayout.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: OWNER } }));
  });

  it('returns synchronously and never throws from the event body, even when the check fails', async () => {
    const { listener, prisma, jobs } = harness({ snapshot: 100, current: 200 });
    prisma.kgEntity.count.mockRejectedValueOnce(new Error('db down'));
    expect(listener.handleGraphChanged({ ownerId: OWNER, reason: 'commit' })).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
