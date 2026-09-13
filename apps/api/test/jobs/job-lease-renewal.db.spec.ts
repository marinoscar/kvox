// =============================================================================
// Real-Postgres test: renewal and the reaper, against each other (issue #347,
// epic #345)
// =============================================================================
//
// THE TWO HALVES OF #347 ARE ONLY CORRECT TOGETHER, and that is precisely why
// this suite exists as a real-database one. `JobLeaseService` pushes
// `lease_expires_at` out while work is in flight; `stuckRunningWhere` decides
// which rows are abandoned. Each is testable in isolation with a mock — the
// service's predicate shape in `src/jobs/job-lease.service.spec.ts`, the
// reaper's clause list in `src/jobs/job-stuck.service.spec.ts` — and NEITHER
// mocked test can answer the only question that matters here:
//
//     does a row that was just renewed actually fall outside the `where` the
//     reaper is about to run?
//
// A mocked `updateMany` returns whatever the test told it to no matter what
// `where` it was handed, so a predicate that quietly matched nothing (or
// everything) would keep both unit suites green. Issue #346 shipped a claim
// bug that every mocked test in this repository passed; the lesson taken from
// it is this file.
//
// ⚠ THE SUITE DRIVES THE REAL SERVICES OVER REAL ROWS, never a hand-written
// `where`. Every case renews through `JobLeaseService` and sweeps through
// `JobStuckService.resetStuck`, so it is the shipped code path being asked,
// not a transcription of it.
//
// THIS IS A `*.db.spec.ts` FILE — see `db-test-support.ts` and
// `job-claim.db.spec.ts`'s header for the run/skip mechanics.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobLeaseService } from '../../src/jobs/job-lease.service';
import { JobStuckService } from '../../src/jobs/job-stuck.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { createDbClient, resolveDbSuite } from './db-test-support';

const { describeWithDb } = resolveDbSuite('job-lease-renewal.db.spec');

/** The stuck threshold every test in this suite runs with. */
const THRESHOLD_MINUTES = 30;

/** The attempt budget every test in this suite runs with. */
const MAX_ATTEMPTS = 3;

/**
 * The deployment-wide runtime ceiling this suite's config stub reports.
 *
 * IT DETERMINES THE LEASE HORIZON, so it is stated rather than defaulted. No
 * handler is registered, so the longest lease anything could ask for is
 * `JOB_TIMEOUT_MS + 60s grace`, and the horizon is that plus another 60s
 * grace — ten minutes and change. Every fixture below is written against that
 * number: a "live" lease sits well inside it, and the clause-4 fixture sits
 * far outside it.
 */
const JOB_TIMEOUT_MS = 600_000;

/** `resolveJobLeaseMs` with no profile: the ceiling plus one grace. */
const LEASE_MS = JOB_TIMEOUT_MS + 60_000;

/** `resolveLeaseHorizonMs`: the longest lease, plus one more grace. */
const HORIZON_MS = LEASE_MS + 60_000;

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

function stubConfig(): ConfigService {
  return {
    get: (key: string) =>
      key === 'jobs.maxAttempts'
        ? MAX_ATTEMPTS
        : key === 'jobs.jobTimeoutMs'
          ? JOB_TIMEOUT_MS
          : undefined,
  } as unknown as ConfigService;
}

function stubSystemSettings(): SystemSettingsService {
  return {
    getJobsPolicy: async () => ({
      history: { retentionDays: 30, purgeEnabled: true },
      stuckThresholdMinutes: THRESHOLD_MINUTES,
    }),
  } as unknown as SystemSettingsService;
}

describeWithDb('Lease renewal vs. the lease reaper (real Postgres)', () => {
  let client: PrismaClient;
  let leases: JobLeaseService;
  let stuck: JobStuckService;

  // The same per-process scoping discipline as the other queue suites: every
  // row this file creates carries a type prefixed with this, so cleanup
  // removes exactly this suite's rows from a database it shares with the
  // other `*.db.spec.ts` files (and, locally, with a developer's dev data).
  const TYPE_PREFIX = `test.lease.${process.pid}.`;
  let typeCounter = 0;
  const nextType = (): string => `${TYPE_PREFIX}${(typeCounter += 1)}`;

  // A real `WorkerNode` row, for the same reason `job-stuck-reset.db.spec.ts`
  // creates one: `jobs.claimed_by_node_id` is a real foreign key since #267,
  // and a nullable FK still enforces referential integrity for every non-NULL
  // value. A hand-invented UUID violates the constraint; a real-but-silent
  // node row is the correct fixture for "a node holds this job".
  const OWNER_EMAIL = `${TYPE_PREFIX}owner@example.test`;
  let ownerId: string;
  let nodeId: string;

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();

    leases = new JobLeaseService(client as unknown as PrismaService);
    stuck = new JobStuckService(
      client as unknown as PrismaService,
      stubConfig(),
      stubSystemSettings(),
      // Nothing registered: the single-budget, single-lease shape a
      // deployment with no execution profiles has. See `JOB_TIMEOUT_MS`.
      new JobHandlerRegistry()
    );

    const owner = await client.user.create({
      data: { email: OWNER_EMAIL, displayName: 'job-lease-renewal suite' },
    });
    ownerId = owner.id;

    const node = await client.workerNode.create({
      data: {
        name: `${TYPE_PREFIX}node`,
        hostname: 'job-lease-renewal-suite-box',
        platform: 'linux-x64',
        cliVersion: '0.0.0-test',
        eligibleTypes: [],
        concurrency: 1,
        createdById: ownerId,
      },
    });
    nodeId = node.id;
  });

  afterEach(async () => {
    await client.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
  });

  afterAll(async () => {
    // Jobs before the node before the owner: `jobs.claimed_by_node_id` FKs to
    // `worker_nodes`, which FKs to `users`.
    await client?.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
    await client?.workerNode.deleteMany({ where: { name: { startsWith: TYPE_PREFIX } } });
    await client?.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await client?.$disconnect();
  });

  async function seed(data: Omit<Prisma.JobUncheckedCreateInput, 'reason'>): Promise<string> {
    const row = await client.job.create({
      data: { reason: 'backfill', ...data } as Prisma.JobUncheckedCreateInput,
    });

    return row.id;
  }

  const read = (id: string) => client.job.findUniqueOrThrow({ where: { id } });

  // ===========================================================================
  // The headline claim: renewal keeps a job safe at ANY age
  // ===========================================================================

  it('never requeues a continuously renewed job, however long it has run', async () => {
    // THE WHOLE POINT OF #347. This row started TWO DAYS ago — sixty-odd
    // times the 30-minute stuck threshold — and the only thing keeping it
    // safe is that its executor keeps renewing. Before this issue the age
    // clause matched it outright and a second executor was handed the same
    // work; the database-backup case that motivated the issue is precisely
    // this row.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(48 * 60),
      createdAt: minutesAgo(48 * 60),
      // A live lease, which is the ONLY thing standing between this row and
      // the reaper. That the same shape WITHOUT one is reaped on age is the
      // "still reaps an aged row whose lease was NEVER written" case below —
      // together the two say age still counts, but only where there is no
      // lease to count instead.
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      claimedByNodeId: null,
      executor: 'server',
    });

    // Ten sweeps, each after another renewal — a long job is not one sweep's
    // worth of luck.
    for (let round = 0; round < 10; round += 1) {
      await expect(leases.renew(id, LEASE_MS, null)).resolves.toBe(true);
      await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
    }

    await expect(read(id)).resolves.toMatchObject({ status: 'running', attempts: 1 });
  });

  it('reaps that same job the moment renewal stops', async () => {
    // The other side of the claim above: the row is not immune, it is
    // PROTECTED BY EVIDENCE it keeps producing. Stop producing it and the
    // dead-owner clause takes the row immediately, without waiting out the
    // threshold.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(48 * 60),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });

    // The executor died here: the lease is allowed to lapse.
    await client.job.update({
      where: { id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  // ===========================================================================
  // The signals the narrowing had to preserve
  // ===========================================================================

  it('still reaps an aged row whose lease was NEVER written', async () => {
    // The load-bearing half of the old signal 1: a fork's own claim path, a
    // row hand-inserted by an operator, a migration that pre-dates leases.
    // Nothing renews such a row because nothing leased it, so age is the only
    // evidence available and it must still count.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 5),
      leaseExpiresAt: null,
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('still reaps a zombie: running, never stamped, never leased', async () => {
    // `NULL < threshold` is NULL rather than false, so this row is invisible
    // to every other clause. Without the `createdAt` arm it sits `running`
    // forever and holds its dedup key with it — and no TypeScript type
    // notices, which is why this assertion lives against a real server.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: null,
      leaseExpiresAt: null,
      createdAt: minutesAgo(THRESHOLD_MINUTES + 5),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('reaps an expired lease immediately, without waiting out the threshold', async () => {
    // Seconds old, so no age clause can reach it. The only thing wrong with
    // this row is that whoever claimed it promised to renew and did not —
    // the lid-closing laptop.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() - 1_000),
      claimedByNodeId: nodeId,
      executor: 'node',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('reaps a thirty-day lease by the implausible-lease clause', async () => {
    // Clause 4, and the reason narrowing clauses 1 and 2 did not open a gap.
    // No handler in this process could ask for a lease past `HORIZON_MS`, so
    // a lease a month out is not a live executor's promise however recently
    // the row started. Nothing else can match: the lease is neither absent
    // nor expired, and `startedAt` is now.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('leaves a lease just inside the horizon alone', async () => {
    // The boundary from the safe side, so clause 4 cannot be tightened into
    // reaping ordinary rows without this failing. A lease of exactly
    // `LEASE_MS` is what every claim in this deployment writes.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'running' });
  });

  // ===========================================================================
  // What renewal itself will and will not do
  // ===========================================================================

  it('refuses to renew a lease that has already expired', async () => {
    // THE GUARD THE WHOLE SERVICE EXISTS FOR. Past the expiry the reaper is
    // entitled to requeue the row and another executor to claim it, so a late
    // renewal is a claim about ownership that may already be false.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(5),
      leaseExpiresAt: new Date(Date.now() - 1_000),
      executor: 'server',
    });

    await expect(leases.renew(id, LEASE_MS, null)).resolves.toBe(false);

    const row = await read(id);
    expect(row.leaseExpiresAt?.getTime()).toBeLessThan(Date.now());
  });

  it('refuses to renew a row the reaper has already requeued', async () => {
    // The sequence a slow worker really lives through: it was running, the
    // sweep took the row, and its next tick arrives afterwards. `false` is
    // the answer, and the row must be left exactly as the reaper left it —
    // a renewal landing here would put a `pending` row back under a lease
    // nobody holds.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 5),
      leaseExpiresAt: minutesAgo(1),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1 });
    await expect(leases.renew(id, LEASE_MS, null)).resolves.toBe(false);

    await expect(read(id)).resolves.toMatchObject({
      status: 'pending',
      leaseExpiresAt: null,
    });
  });

  it('refuses a server renewal on a row a NODE now holds', async () => {
    // The in-process worker renews with `nodeId: null`, which is not "no
    // constraint" — it is "this row must be held by no node". If the reaper
    // requeued the row and a node claimed it, the old worker's renewals stop
    // landing, which is exactly right.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      claimedByNodeId: nodeId,
      executor: 'node',
    });

    await expect(leases.renew(id, LEASE_MS, null)).resolves.toBe(false);
    // ...while the node that actually holds it renews fine.
    await expect(leases.renew(id, LEASE_MS, nodeId)).resolves.toBe(true);
  });

  it('refuses to renew a settled row', async () => {
    const id = await seed({
      type: nextType(),
      status: 'succeeded',
      attempts: 1,
      startedAt: minutesAgo(5),
      finishedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      executor: 'server',
    });

    await expect(leases.renew(id, LEASE_MS, null)).resolves.toBe(false);
    await expect(read(id)).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('writes a lease the reaper then reads as live', async () => {
    // The round trip stated as one assertion: the instant `renew` persists is
    // the instant `stuckRunningWhere` compares against. Two `Date`s that
    // agree in TypeScript and disagree after a timezone-naive column write
    // would fail here and nowhere else.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 5),
      // Live, but only just: a renewal must land BEFORE the expiry (see
      // `heldLeaseWhere`), so a row on the brink is the honest fixture for
      // "the ticker got there in time".
      leaseExpiresAt: new Date(Date.now() + 2_000),
      executor: 'server',
    });

    const before = Date.now();
    await expect(leases.renew(id, LEASE_MS, null)).resolves.toBe(true);

    const row = await read(id);
    expect(row.leaseExpiresAt?.getTime()).toBeGreaterThanOrEqual(before + LEASE_MS - 1);
    // ...and strictly inside the horizon, or clause 4 would take it back.
    expect(row.leaseExpiresAt?.getTime()).toBeLessThan(Date.now() + HORIZON_MS);

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
  });
});
