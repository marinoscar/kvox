// =============================================================================
// Unit tests for JobLeaseService (issue #347, epic #345)
// =============================================================================
//
// WHAT A MOCK CAN AND CANNOT PROVE HERE, stated up front because the split
// with `test/jobs/job-lease-renewal.db.spec.ts` depends on it. A mocked
// `updateMany` returns whatever this file told it to no matter what `where` it
// was handed, so nothing below is evidence that Postgres MATCHES the right
// rows. What it is evidence of is the shape of the predicate — every clause
// present, `nodeId` three-valued as documented, `count === 1` and not `> 0` —
// which is exactly the part a real-database test cannot show you, because
// there the predicate is invisible behind the rows it selected.
//
// The row-matching claim is made against a real server in
// `test/jobs/job-lease-renewal.db.spec.ts`.
// =============================================================================

import { JobLeaseService, heldLeaseWhere } from './job-lease.service';
import type { PrismaService } from '../prisma/prisma.service';

const JOB_ID = '3f1a0f4e-0000-4000-8000-000000000001';
const NODE_ID = '3f1a0f4e-0000-4000-8000-0000000000aa';

function makeService(updateMany = jest.fn().mockResolvedValue({ count: 1 })) {
  const prisma = { job: { updateMany } } as unknown as PrismaService;

  return { service: new JobLeaseService(prisma), updateMany };
}

/** The `where` the service handed Prisma on its `n`th call. */
const whereOf = (mock: jest.Mock, index = 0): Record<string, unknown> =>
  mock.mock.calls[index][0].where as Record<string, unknown>;

describe('heldLeaseWhere', () => {
  it('requires the row to be this job, running, and still inside its lease', () => {
    const where = heldLeaseWhere(JOB_ID, null);

    expect(where.id).toBe(JOB_ID);
    expect(where.status).toBe('running');
    expect((where.leaseExpiresAt as { gt: Date }).gt).toBeInstanceOf(Date);
  });

  it('refuses an ALREADY EXPIRED lease — the clause the whole file is for', () => {
    // The predicate is `gt: now`, so a lease that has passed cannot match.
    // This is the guard that stops a straggler renewing a row the reaper has
    // already requeued and another executor has already claimed; relaxing it
    // is how two live executors end up believing they own one job.
    const before = Date.now();
    const gt = (heldLeaseWhere(JOB_ID).leaseExpiresAt as { gt: Date }).gt;

    expect(gt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('pins the row to a node when a node id is given', () => {
    expect(heldLeaseWhere(JOB_ID, NODE_ID).claimedByNodeId).toBe(NODE_ID);
  });

  it('pins the row to NO node when null is given — the in-process worker', () => {
    // `null` is not "unconstrained": the worker claims as `executor: 'server'`
    // with no node, so if the reaper requeued the row and a NODE took it, the
    // worker's renewals must stop landing. `null` is what says so.
    expect(heldLeaseWhere(JOB_ID, null).claimedByNodeId).toBeNull();
  });

  it('omits the ownership clause entirely when the node id is undefined', () => {
    // Three-valued on purpose. `undefined` leaves the column unconstrained for
    // a fork's own executor, which has no node id to state and must not be
    // forced to lie about one to renew.
    expect('claimedByNodeId' in heldLeaseWhere(JOB_ID)).toBe(false);
  });
});

describe('JobLeaseService.renew', () => {
  it('writes a lease leaseMs into the future, guarded by heldLeaseWhere', async () => {
    const { service, updateMany } = makeService();

    const before = Date.now();
    await expect(service.renew(JOB_ID, 60_000, null)).resolves.toBe(true);

    const call = updateMany.mock.calls[0][0] as { data: { leaseExpiresAt: Date } };
    expect(call.data.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);

    // Compared against the exported predicate rather than a literal, so this
    // fails if the guard changes rather than merely if a copy of it does.
    expect(Object.keys(whereOf(updateMany)).sort()).toEqual(
      Object.keys(heldLeaseWhere(JOB_ID, null)).sort()
    );
  });

  it('reports false when the row was not held — reaped, settled, or taken', async () => {
    const { service } = makeService(jest.fn().mockResolvedValue({ count: 0 }));

    await expect(service.renew(JOB_ID, 60_000, null)).resolves.toBe(false);
  });

  it('does not throw on a lost row: false is an answer, not a failure', async () => {
    // Both callers are keep-alive paths with real work in flight. "You no
    // longer own this row" must stop the ticker, never fail the job that is
    // still running.
    const { service } = makeService(jest.fn().mockResolvedValue({ count: 0 }));

    await expect(service.renew(JOB_ID, 1_000)).resolves.toBe(false);
  });

  it('treats a count other than one as not held', async () => {
    // `id` is the primary key so this cannot really happen; the assertion
    // pins the `=== 1` rather than a `> 0` that would quietly accept a
    // predicate someone had widened into matching several rows.
    const { service } = makeService(jest.fn().mockResolvedValue({ count: 2 }));

    await expect(service.renew(JOB_ID, 1_000, null)).resolves.toBe(false);
  });
});

describe('JobLeaseService.renewUntil', () => {
  it('writes the EXACT instant it was given, not one it recomputes', async () => {
    // The reason this overload exists: `NodesService.renewLease` reports the
    // new expiry to the node, and a node told one instant while the row
    // carries another schedules its next renewal against a deadline the
    // reaper does not read.
    const { service, updateMany } = makeService();
    const at = new Date('2026-03-01T00:00:00.000Z');

    await expect(service.renewUntil(JOB_ID, at, NODE_ID)).resolves.toBe(true);

    expect((updateMany.mock.calls[0][0] as { data: { leaseExpiresAt: Date } }).data).toEqual({
      leaseExpiresAt: at,
    });
    expect(whereOf(updateMany).claimedByNodeId).toBe(NODE_ID);
  });
});
