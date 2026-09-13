// =============================================================================
// Real-Postgres test: the queue's real seam between TWO EXECUTORS and the
// reaper (issue #290, epic #254, Phase 8)
// =============================================================================
//
// EVIDENCE FOR EPIC #254'S SUCCESS CRITERIA 2 AND 3:
//   2. Two claimers racing for the same row never both win it.
//   3. A job whose process dies without a terminal write is eventually failed
//      once its attempt budget is spent, by the lease reaper alone.
//
// WHAT THIS FILE DOES **NOT** RE-PROVE, AND WHY.
// `../jobs/job-claim.db.spec.ts` already drives `JobClaimService.claim` over
// two independent `PrismaClient`s and proves, deterministically over ten
// rounds, that two claimers racing for one row never both win it, and that a
// burst of eight overlapping claims partitions a seeded batch with no
// duplicate and nothing lost. `../nodes/node-claim-contention.db.spec.ts`
// proves the same thing again for the asymmetric node-vs-server pair reached
// through `NodesService.claimJobs`. Restating either here would test the
// test suite's own arrangement a second time, not the code — so this file
// covers the two things those suites do not, on purpose:
//
//   (a) THE CROSS-CLAIMER ORDERING GUARANTEE. Both existing suites prove "no
//       duplicate, nothing lost" for a burst; neither proves that when two
//       claimers draw AT THE SAME INSTANT, the pair they walk away with is
//       always the two most urgent rows left in the queue — i.e. that
//       `priority ASC, created_at ASC` governs the row TWO SIMULTANEOUS
//       transactions receive, not just the row one does. That is the seam
//       this suite closes: a claim service that raced `SKIP LOCKED` against
//       an index that did not actually sort by priority would still pass
//       every existing concurrency test (no id ever repeats) while handing
//       out jobs in the wrong order under real contention, silently, only
//       when two claimers are the ones contending.
//
//   (b) THE FULL CLAIM-THEN-REAP LIFECYCLE, END TO END. `job-stuck-reset
//       .db.spec.ts` proves the reaper's SQL against HAND-SEEDED `attempts`
//       values; it never calls `JobClaimService.claim` itself, so it never
//       proves that the counter the reaper reads is the SAME counter the
//       real claim path charges. This suite claims a row through the real
//       `JobClaimService` (which is what actually increments `attempts`, at
//       claim time — see that service's own header), lets its lease expire
//       for real, and drives the real `JobStuckService` through requeue and
//       then failure. If a future refactor moved the attempt charge to
//       somewhere the reaper's `WHERE attempts >= $maxAttempts` no longer
//       lines up with, both halves would still pass alone; only running them
//       together, against the same row, over real time, can catch it.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test`/`test:unit`/
// `test:cov`/`test:ci` and run by `npm run test:db` (CI's `smoke` job, no
// new service container — see `docs/TESTING.md`). See
// `../jobs/db-test-support.ts` for the reachability probe.
//
// MEASURED WALL CLOCK: ~1.6s for this file alone (dominated by the two real
// sleeps past a short lease in the reap-to-failure test). See
// `docs/TESTING.md` for the whole suite's budget.
// =============================================================================

import { PrismaClient, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

import { JobClaimService } from '../../src/jobs/job-claim.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobStuckService } from '../../src/jobs/job-stuck.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('queue-fleet-concurrency.db.spec');

const LEASE_MS = 60_000;

describeWithDb('Two executors and the reaper, against real Postgres', () => {
  let clientA: PrismaClient;
  let clientB: PrismaClient;
  let claimerA: JobClaimService;
  let claimerB: JobClaimService;

  /** Every row this suite creates carries this prefix, so cleanup is exact. */
  const TYPE_PREFIX = `test.fleet-concurrency.${process.pid}.`;
  let typeCounter = 0;
  const nextType = (): string => `${TYPE_PREFIX}${(typeCounter += 1)}`;

  beforeAll(async () => {
    clientA = createDbClient();
    clientB = createDbClient();
    await Promise.all([clientA.$connect(), clientB.$connect()]);
    claimerA = new JobClaimService(clientA as unknown as PrismaService);
    claimerB = new JobClaimService(clientB as unknown as PrismaService);
  });

  afterEach(async () => {
    await clientA.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
  });

  afterAll(async () => {
    await clientA?.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
    await Promise.all([clientA?.$disconnect(), clientB?.$disconnect()]);
  });

  // ===========================================================================
  // (a) Ordering, across both claimers, under genuine simultaneous contention
  // ===========================================================================

  it('hands two simultaneous claimers exactly the two most urgent remaining rows, every round', async () => {
    const type = nextType();
    const COUNT = 20;

    // Strictly decreasing urgency (priority ASCENDING is MORE urgent — see
    // `Job.priority`'s own comment) with strictly increasing `createdAt`, so
    // there is exactly one correct order and no tie for either claimer to
    // break differently.
    const base = Date.now();
    await clientA.job.createMany({
      data: Array.from({ length: COUNT }, (_unused, index) => ({
        type,
        reason: 'backfill' as const,
        priority: index,
        createdAt: new Date(base + index),
      })),
    });

    const seeded = await clientA.job.findMany({
      where: { type },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    let remaining = seeded.map((row) => row.id);

    const claimOptions = (limit: number) => ({
      nodeId: null,
      executor: 'server' as const,
      eligibleTypes: [type],
      limit,
      leases: [{ type: type, leaseMs: LEASE_MS }],
    });

    // Draw two at a time, ONE FROM EACH CLAIMER, SIMULTANEOUSLY, until the
    // queue is empty. If the claim query's `ORDER BY` genuinely governs which
    // row each of two concurrent transactions locks, the pair returned each
    // round is always exactly `remaining[0..2)` — the two most urgent rows
    // left — regardless of which claimer got which. A claim query that raced
    // `SKIP LOCKED` without the ordering actually reaching the plan could
    // still return two DISTINCT rows (passing every no-duplicate assertion
    // elsewhere in this repository) while handing them out of order; this is
    // the assertion that would catch it.
    while (remaining.length > 0) {
      const expectedPair = remaining.slice(0, 2).sort();

      const [fromA, fromB] = await Promise.all([
        claimerA.claim(claimOptions(1)),
        claimerB.claim(claimOptions(1)),
      ]);

      const gotThisRound = [...fromA, ...fromB].map((job) => job.id).sort();

      expect(gotThisRound).toEqual(expectedPair);

      remaining = remaining.slice(gotThisRound.length);
    }

    expect(remaining).toHaveLength(0);
  });

  // ===========================================================================
  // (b) Claim (real, attempts charged) -> lease expiry -> reap -> ... -> fail
  // ===========================================================================

  it('fails a job the real claimer charged, once the reaper has reclaimed it past the attempt budget', async () => {
    const type = nextType();
    const MAX_ATTEMPTS = 2;
    const SHORT_LEASE_MS = 250;

    const config = {
      get: (key: string) => (key === 'jobs.maxAttempts' ? MAX_ATTEMPTS : undefined),
    } as unknown as ConfigService;

    const settings = {
      getJobsPolicy: async () => ({
        history: { retentionDays: 30, purgeEnabled: true },
        stuckThresholdMinutes: 30,
      }),
    } as unknown as SystemSettingsService;

    const reaper = new JobStuckService(
      clientA as unknown as PrismaService,
      config,
      settings,
      new JobHandlerRegistry()
    );

    await clientA.job.create({ data: { type, reason: 'backfill' } });

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const claimAndAbandon = async (expectedAttempts: number): Promise<void> => {
      // THE REAL CLAIM. This is what actually increments `attempts` — the
      // reaper never touches the counter itself, it only reads what the
      // claim already wrote. See `job-claim.service.ts`'s header.
      const [claimed] = await claimerA.claim({
        nodeId: null,
        executor: 'server',
        eligibleTypes: [type],
        limit: 1,
        leases: [{ type: type, leaseMs: SHORT_LEASE_MS }],
      });

      expect(claimed).toBeDefined();
      expect(claimed.attempts).toBe(expectedAttempts);

      // The "process" now dies: no `completeSucceeded`, no `completeFailed`,
      // nothing. The row is left `running` with a lease that is about to
      // expire for real — not backdated by the fixture, which is the whole
      // point of pairing this with `job-claim.db.spec.ts`'s hand-seeded
      // sibling: TIME actually has to pass here.
      await sleep(SHORT_LEASE_MS + 150);
    };

    // Round 1: charged to attempts=1, abandoned, reaped UNDER the cap ->
    // requeued to `pending` with the claim released.
    await claimAndAbandon(1);

    const firstSweep = await reaper.resetStuck();
    expect(firstSweep).toMatchObject({ reset: 1, failed: 0 });

    const afterFirstSweep = await clientA.job.findUniqueOrThrow({
      where: { id: (await clientA.job.findFirstOrThrow({ where: { type } })).id },
    });
    expect(afterFirstSweep.status).toBe('pending');
    expect(afterFirstSweep.attempts).toBe(1);
    expect(afterFirstSweep.claimedByNodeId).toBeNull();
    expect(afterFirstSweep.leaseExpiresAt).toBeNull();

    // Round 2: claimed again (real claim charges attempts -> 2, AT the cap),
    // abandoned again, and this time the reaper's second phase fires: `failed`,
    // not `pending`.
    await claimAndAbandon(2);

    const secondSweep = await reaper.resetStuck();
    expect(secondSweep).toMatchObject({ reset: 0, failed: 1 });

    const final = await clientA.job.findFirstOrThrow({ where: { type } });
    expect(final.status).toBe('failed');
    expect(final.attempts).toBe(MAX_ATTEMPTS);
    expect(final.finishedAt).not.toBeNull();
    expect(final.lastError).toContain(`after ${MAX_ATTEMPTS} attempt(s)`);

    // A third sweep is a no-op: the row already settled, and the reaper's
    // `WHERE status = 'running'` no longer matches it.
    await expect(reaper.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
  });
});
