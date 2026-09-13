// =============================================================================
// NodeSecretBrokerService: the two revocation paths (issue #349, epic #345)
// =============================================================================
//
// `test/nodes/node-job-secret.integration.spec.ts` covers ISSUING end to end —
// the guard order, the four refusals, the lease-bounded expiry, and the
// assertion that the material never reaches a log. What it cannot cover is the
// half of this service that has no HTTP request behind it: the sweep.
//
// THE SWEEP'S PREDICATE IS THE ONLY PLACE IN THE SYSTEM WHERE "IS THIS GRANT
// STILL LEGITIMATE" IS ANSWERED WITHOUT A REQUEST IN HAND, and it is the exact
// complement of `assertJobHeldByNode`'s four conditions plus the grant's own
// clock. Every arm of it is sabotaged individually below, against a grant that
// is otherwise perfectly live, so a failure names which condition regressed —
// the same discipline `nodes.service.spec.ts` applies to the lease guard.
//
// The stakes are not symmetrical with the rest of the queue's tests. A wrong
// arm here does not lose a job: it leaves a live database credential behind,
// forever, with nothing in any log connecting it to the job it came from.
// =============================================================================

import { JobNodeSecret } from '@prisma/client';

import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import type { JobSecretBroker } from '../jobs/job-secret-broker';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { NodeLifecycleService } from './node-lifecycle.service';
import { NodeSecretBrokerService } from './node-secret-broker.service';
import { NodesService } from './nodes.service';

describe('NodeSecretBrokerService', () => {
  const JOB_ID = '22222222-2222-4222-8222-222222222222';
  const NODE_ID = '11111111-1111-4111-8111-111111111111';
  const KIND = 'test.postgres';
  const TYPE = 'test.needs-credential';

  const NOW = new Date('2026-09-07T12:00:00.000Z');

  let prisma: MockPrismaService;
  let registry: JobHandlerRegistry;
  let revoke: jest.Mock;
  let service: NodeSecretBrokerService;

  beforeEach(() => {
    prisma = createMockPrismaService();
    revoke = jest.fn().mockResolvedValue(undefined);

    const broker: JobSecretBroker = {
      kind: KIND,
      usable: jest.fn().mockResolvedValue({ ok: true }),
      issue: jest.fn(),
      revoke,
    };

    registry = new JobHandlerRegistry();
    registry.register({
      type: TYPE,
      process: async () => undefined,
      nodeSecretBroker: broker,
    });

    (prisma.jobNodeSecret.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    service = new NodeSecretBrokerService(
      prisma as unknown as PrismaService,
      // Never reached: nothing here issues, and issuing is covered over real
      // HTTP where the guard's four conditions are what matter.
      {} as unknown as NodesService,
      registry,
      {} as unknown as NodeLifecycleService
    );
  });

  /** A grant row that is, by default, perfectly live. */
  function grant(overrides: Partial<JobNodeSecret> = {}): JobNodeSecret {
    return {
      id: 'grant-1',
      jobId: JOB_ID,
      nodeId: NODE_ID,
      kind: KIND,
      handle: 'job_reader',
      issuedAt: new Date(NOW.getTime() - 1_000),
      expiresAt: new Date(NOW.getTime() + 60_000),
      revokedAt: null,
      ...overrides,
    } as JobNodeSecret;
  }

  /** The job that grant belongs to, held by the same node under a live lease. */
  function heldJob(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB_ID,
      status: 'running',
      claimedByNodeId: NODE_ID,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      ...overrides,
    };
  }

  function givenSweepState(rows: JobNodeSecret[], jobs: unknown[]): void {
    (prisma.jobNodeSecret.findMany as jest.Mock).mockResolvedValue(rows);
    (prisma.job.findMany as jest.Mock).mockResolvedValue(jobs);
  }

  // ===========================================================================
  // couldHoldGrant — the listener's Map lookup
  // ===========================================================================

  describe('couldHoldGrant', () => {
    it('is true for a type declaring a broker and false for everything else', () => {
      // What keeps the settle listener off the database entirely in the ~100%
      // of deployments where no type declares a broker.
      registry.register({ type: 'test.plain', process: async () => undefined });

      expect(service.couldHoldGrant(TYPE)).toBe(true);
      expect(service.couldHoldGrant('test.plain')).toBe(false);
      expect(service.couldHoldGrant('test.not-registered-at-all')).toBe(false);
    });
  });

  // ===========================================================================
  // Path 1 — the settle event
  // ===========================================================================

  describe('revokeForJob', () => {
    it('revokes every unrevoked grant for the job and marks the row', async () => {
      (prisma.jobNodeSecret.findMany as jest.Mock).mockResolvedValue([grant()]);

      await expect(service.revokeForJob(JOB_ID)).resolves.toBe(1);

      expect(revoke).toHaveBeenCalledWith('job_reader');
      // ⚠ THE MARK IS GUARDED ON `revokedAt: null`, so a settle racing a sweep
      // produces one winner and one no-op rather than two writers disagreeing
      // about when the grant ended.
      const write = (prisma.jobNodeSecret.updateMany as jest.Mock).mock.calls[0][0];
      expect(write.where).toEqual({ id: 'grant-1', revokedAt: null });
      expect(write.data.revokedAt).toBeInstanceOf(Date);
    });

    it('only ever looks at grants that are not already revoked', async () => {
      (prisma.jobNodeSecret.findMany as jest.Mock).mockResolvedValue([]);

      await service.revokeForJob(JOB_ID);

      expect((prisma.jobNodeSecret.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        jobId: JOB_ID,
        revokedAt: null,
      });
    });

    it('leaves the row UNREVOKED when the broker throws, so the sweep retries', async () => {
      // The ordering rule stated from the failure side: marking first and
      // revoking second would leave a row that says "revoked" and a credential
      // that still works — the one state nothing would ever clean up, because
      // the sweeper only looks at unmarked rows.
      (prisma.jobNodeSecret.findMany as jest.Mock).mockResolvedValue([grant()]);
      revoke.mockRejectedValue(new Error('database unreachable'));

      await expect(service.revokeForJob(JOB_ID)).resolves.toBe(0);

      expect(prisma.jobNodeSecret.updateMany).not.toHaveBeenCalled();
    });

    it('does not throw when the bookkeeping write fails — the credential IS gone', async () => {
      // The broker said the grant is destroyed. Only the row is stale, and the
      // next sweep will call `revoke` again on a handle that no longer exists,
      // which the contract requires brokers to treat as success.
      (prisma.jobNodeSecret.findMany as jest.Mock).mockResolvedValue([grant()]);
      (prisma.jobNodeSecret.updateMany as jest.Mock).mockRejectedValue(new Error('deadlock'));

      await expect(service.revokeForJob(JOB_ID)).resolves.toBe(1);
    });
  });

  // ===========================================================================
  // Path 2 — the sweep, and its predicate arm by arm
  // ===========================================================================

  describe('sweep', () => {
    it('leaves a grant alone while its job is still held by the same node', async () => {
      givenSweepState([grant()], [heldJob()]);

      await expect(service.sweep(NOW)).resolves.toEqual({
        examined: 1,
        revoked: 0,
        failed: 0,
      });
      expect(revoke).not.toHaveBeenCalled();
    });

    it.each([
      // 1. THE REAPER CASE — a job it requeued is `pending` again, and its
      //    `updateMany` emitted no settle event at all, so the fast path never
      //    ran. This is the case where an outstanding credential is MOST
      //    likely: the executor died holding it.
      ['the job was requeued by the reaper', () => heldJob({ status: 'pending' })],
      // 2. THE REPLICA-DIED CASE — the terminal row was written, the emit ran,
      //    and the process was gone before `revoke` returned.
      ['the job succeeded and nothing revoked it', () => heldJob({ status: 'succeeded' })],
      ['the job failed and nothing revoked it', () => heldJob({ status: 'failed' })],
      // 3. THE HANDOVER CASE — another executor now owns the row.
      ['another node now holds the job', () => heldJob({ claimedByNodeId: 'other-node' })],
      ['the server reclaimed it', () => heldJob({ claimedByNodeId: null })],
      // 4. THE `write-failed` CASE — `safeTerminalUpdate` gave up, left the row
      //    `running` for the reaper and never reached `emitSettled`; the lease
      //    is what lapses.
      ['the lease expired', () => heldJob({ leaseExpiresAt: new Date(NOW.getTime() - 1) })],
      ['the lease was cleared', () => heldJob({ leaseExpiresAt: null })],
    ])('revokes when %s', async (_label, buildJob) => {
      givenSweepState([grant()], [buildJob()]);

      await expect(service.sweep(NOW)).resolves.toEqual({
        examined: 1,
        revoked: 1,
        failed: 0,
      });
      expect(revoke).toHaveBeenCalledWith('job_reader');
    });

    it('revokes when the JOB ROW IS GONE — the strongest evidence of an orphan', async () => {
      // The history purge deletes `jobs` on a retention schedule that has
      // nothing to do with a grant's lifetime. There is no FK, so the grant
      // survives; the sweep is what stops it surviving forever.
      givenSweepState([grant()], []);

      await expect(service.sweep(NOW)).resolves.toMatchObject({ revoked: 1 });
    });

    it('revokes a grant past its OWN expiry even while the job is still held', async () => {
      // The fifth condition, and it is not redundant: a credential past its
      // expiry no longer works anyway, so leaving its role in place buys
      // nothing and costs a role.
      givenSweepState([grant({ expiresAt: new Date(NOW.getTime() - 1) })], [heldJob()]);

      await expect(service.sweep(NOW)).resolves.toMatchObject({ revoked: 1 });
    });

    it('reports a broker failure as `failed` and leaves the row for the next tick', async () => {
      givenSweepState([grant()], [heldJob({ status: 'succeeded' })]);
      revoke.mockRejectedValue(new Error('connection refused'));

      await expect(service.sweep(NOW)).resolves.toEqual({
        examined: 1,
        revoked: 0,
        failed: 1,
      });
      expect(prisma.jobNodeSecret.updateMany).not.toHaveBeenCalled();
    });

    it('counts a grant whose kind matches NO registered broker as failed, not revoked', async () => {
      // A fork removed the broker, or a rolling deploy is mid-flight. Nothing
      // in this process can destroy the grant, so it is reported loudly and the
      // row stays as it is — the grant's own expiry is what bounds it.
      givenSweepState([grant({ kind: 'gone.away' })], [heldJob({ status: 'succeeded' })]);

      await expect(service.sweep(NOW)).resolves.toEqual({
        examined: 1,
        revoked: 0,
        failed: 1,
      });
      expect(revoke).not.toHaveBeenCalled();
    });

    it('does no work at all when there is nothing unrevoked', async () => {
      (prisma.jobNodeSecret.findMany as jest.Mock).mockResolvedValue([]);

      await expect(service.sweep(NOW)).resolves.toEqual({
        examined: 0,
        revoked: 0,
        failed: 0,
      });
      // The second query is skipped entirely — 144 ticks a day on a healthy
      // deployment should cost exactly one indexed read.
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });

    it('reads jobs in ONE query, oldest expiry first, bounded', async () => {
      const rows = [grant(), grant({ id: 'grant-2', handle: 'other_reader' })];
      givenSweepState(rows, [heldJob()]);

      await service.sweep(NOW);

      const read = (prisma.jobNodeSecret.findMany as jest.Mock).mock.calls[0][0];
      expect(read.where).toEqual({ revokedAt: null });
      expect(read.orderBy).toEqual({ expiresAt: 'asc' });
      expect(read.take).toBeGreaterThan(0);

      // One `job.findMany` for the whole batch, de-duplicated by job id — not
      // one query per grant.
      expect(prisma.job.findMany).toHaveBeenCalledTimes(1);
      expect((prisma.job.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        id: { in: [JOB_ID] },
      });
    });

    it('keeps going after one grant fails, rather than abandoning the batch', async () => {
      const rows = [grant(), grant({ id: 'grant-2', jobId: 'other-job', handle: 'second' })];
      givenSweepState(rows, []);
      revoke.mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);

      await expect(service.sweep(NOW)).resolves.toEqual({
        examined: 2,
        revoked: 1,
        failed: 1,
      });
    });
  });
});
