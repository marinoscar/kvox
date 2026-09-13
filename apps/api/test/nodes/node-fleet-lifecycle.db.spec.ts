// =============================================================================
// The fleet lifecycle against real Postgres (issue #270, epic #254)
// =============================================================================
//
// ⚠ REAL POSTGRES ONLY. Excluded from `npm test` by the `\.db\.spec\.ts$`
// ignore pattern and run by `npm run test:db --workspace=api` in CI's smoke
// job; it skips with a warning when nothing is listening.
//
// `node-fleet-lifecycle.spec.ts` proves the same sequence against a narrow
// in-memory emulation, which is what keeps the regression covered on every
// ordinary test run. THREE THINGS CAN ONLY BE PROVEN HERE, because all three
// are properties of the database rather than of the code:
//
//   1. `NULL < cutoff` IS NOT TRUE. The never-heartbeated arm of both `where`
//      clauses exists entirely because of SQL's three-valued logic; a fixture
//      that modelled `null` as "less than everything" would make the arm look
//      redundant and invite its removal.
//
//   2. `Job.claimedByNode` IS `onDelete: SetNull`. Deleting a node must null
//      the pointer and keep the job row. The alternative the schema could
//      have had (`Cascade`) would delete job history when an administrator
//      tidies up a dead machine, and no unit test can tell the difference —
//      the FK is enforced by Postgres, not by Prisma's client.
//
//   3. THE REAPER PICKS UP WHERE THE DELETE LEFT OFF. A job orphaned by a node
//      deletion is requeued by the lease reaper's existing signals, with no
//      node-specific recovery code anywhere.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { PrismaClient, type Job } from '@prisma/client';

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobStuckService } from '../../src/jobs/job-stuck.service';
import { NodeLifecycleService } from '../../src/nodes/node-lifecycle.service';
import { NodeFleetPruneHandler } from '../../src/nodes/handlers/node-fleet-prune.handler';
import { NodeFleetSweepHandler } from '../../src/nodes/handlers/node-fleet-sweep.handler';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('node-fleet-lifecycle.db.spec');

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

/** The shipped policy: offline after 90s x 4, forgotten 30 days after that. */
const POLICY = DEFAULT_SYSTEM_SETTINGS.nodes;

describeWithDb('Worker-node fleet lifecycle (real Postgres)', () => {
  let prisma: PrismaClient;
  /** The row a worker hands `process`. Only `id` is read, for the log lines. */
  const FLEET_JOB = { id: 'job-fleet' } as Job;

  let sweep: NodeFleetSweepHandler;
  let prune: NodeFleetPruneHandler;
  let reaper: JobStuckService;

  /** Every row this suite creates is prefixed, so cleanup deletes only its own. */
  const PREFIX = `test.fleet-lifecycle.${process.pid}.`;
  const OWNER_EMAIL = `${PREFIX}owner@example.test`;
  const JOB_TYPE = `${PREFIX}job`;

  let ownerId: string;

  /** Both switches unset, so both crons fail open — the shipped behaviour. */
  const config = {
    get: (key: string) => (key === 'jobs.maxAttempts' ? 3 : undefined),
  } as unknown as ConfigService;

  const ago = (ms: number): Date => new Date(Date.now() - ms);

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();

    const owner = await prisma.user.create({
      data: { email: OWNER_EMAIL, displayName: 'fleet lifecycle suite' },
    });
    ownerId = owner.id;

    // The settings row is stubbed rather than written: these suites must not
    // mutate a shared `system_settings` row, and the policy under test is the
    // shipped default anyway.
    const settings = {
      getNodesPolicy: async () => POLICY,
      getJobsPolicy: async () => DEFAULT_SYSTEM_SETTINGS.jobs,
    } as unknown as SystemSettingsService;

    const lifecycle = new NodeLifecycleService(settings);
    const prismaService = prisma as unknown as PrismaService;

    // #288's notifier, stubbed: this suite is about what real Postgres does to
    // the rows, not about what the sweep tells anybody.
    const notifications = {
      notifyPermissionHolders: async () => undefined,
    } as unknown as NotificationsService;

    // ⚠ #353 (epic #345) MOVED BOTH SWEEPS ONTO HANDLERS. This suite is about
    // what real Postgres does to the rows, which is a property of the work and
    // not of what schedules it, so it follows the code: the two tasks now only
    // enqueue.
    const registry = new JobHandlerRegistry();

    sweep = new NodeFleetSweepHandler(registry, prismaService, lifecycle, config, notifications);
    prune = new NodeFleetPruneHandler(registry, prismaService, lifecycle);
    reaper = new JobStuckService(prismaService, config, settings, new JobHandlerRegistry());
  });

  afterEach(async () => {
    await prisma.job.deleteMany({ where: { type: JOB_TYPE } });
    await prisma.workerNode.deleteMany({ where: { name: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma?.job.deleteMany({ where: { type: JOB_TYPE } });
    await prisma?.workerNode.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma?.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await prisma?.$disconnect();
  });

  /** A node row, defaulting to a healthy `online` one. */
  async function makeNode(
    name: string,
    overrides: Partial<{
      status: 'online' | 'draining' | 'offline' | 'disabled';
      registeredAt: Date;
      lastHeartbeatAt: Date | null;
    }> = {}
  ): Promise<string> {
    const node = await prisma.workerNode.create({
      data: {
        name: `${PREFIX}${name}`,
        hostname: `${name}-box`,
        platform: 'linux-x64',
        cliVersion: '0.0.0-test',
        eligibleTypes: [JOB_TYPE],
        concurrency: 1,
        status: overrides.status ?? 'online',
        registeredAt: overrides.registeredAt ?? ago(90 * DAY),
        lastHeartbeatAt:
          overrides.lastHeartbeatAt === undefined ? new Date() : overrides.lastHeartbeatAt,
        createdById: ownerId,
      },
    });

    return node.id;
  }

  const statusOf = async (id: string): Promise<string | undefined> =>
    (await prisma.workerNode.findUnique({ where: { id }, select: { status: true } }))?.status;

  // ===========================================================================
  // The sweep
  // ===========================================================================

  it('marks a silent node offline and leaves a heartbeating one alone', async () => {
    const silent = await makeNode('silent', { lastHeartbeatAt: ago(60 * 60 * SECOND) });
    const alive = await makeNode('alive', { lastHeartbeatAt: ago(5 * SECOND) });

    await sweep.process(FLEET_JOB);

    expect(await statusOf(silent)).toBe('offline');
    expect(await statusOf(alive)).toBe('online');
  });

  it('ages a node that never heartbeated by registeredAt', async () => {
    // The arm that exists because `NULL < cutoff` is NULL in SQL and never
    // true — a fact only a real database can demonstrate.
    const stale = await makeNode('never-pinged', {
      registeredAt: ago(60 * 60 * SECOND),
      lastHeartbeatAt: null,
    });
    const fresh = await makeNode('just-registered', {
      registeredAt: new Date(),
      lastHeartbeatAt: null,
    });

    await sweep.process(FLEET_JOB);

    expect(await statusOf(stale)).toBe('offline');
    expect(await statusOf(fresh)).toBe('online');
  });

  it('never touches a disabled node', async () => {
    const disabled = await makeNode('disabled', {
      status: 'disabled',
      lastHeartbeatAt: ago(60 * DAY),
    });

    await sweep.process(FLEET_JOB);

    expect(await statusOf(disabled)).toBe('disabled');
  });

  // ===========================================================================
  // THE ORDERING: the regression guard for the void-retention bug
  // ===========================================================================

  it('makes a crashed node prunable, which the prune alone never could', async () => {
    const crashed = await makeNode('crashed', { lastHeartbeatAt: ago(45 * DAY) });

    // Without the sweep the row is still `online`, so retention cannot see it
    // however long it has been silent. THIS IS THE BUG.
    await expect(prune.prune()).resolves.toEqual({ deleted: 0, skippedBusy: 0 });
    expect(await statusOf(crashed)).toBe('online');

    await sweep.process(FLEET_JOB);
    expect(await statusOf(crashed)).toBe('offline');

    await expect(prune.prune()).resolves.toEqual({ deleted: 1, skippedBusy: 0 });
    expect(await statusOf(crashed)).toBeUndefined();
  });

  it('keeps a node past retention that still holds a running job, and takes it once it settles', async () => {
    const busy = await makeNode('busy', { status: 'offline', lastHeartbeatAt: ago(45 * DAY) });
    const job = await prisma.job.create({
      data: {
        type: JOB_TYPE,
        reason: 'backfill',
        status: 'running',
        attempts: 1,
        startedAt: ago(60 * SECOND),
        leaseExpiresAt: new Date(Date.now() + 60 * SECOND),
        claimedByNodeId: busy,
        executor: 'node',
      },
    });

    await expect(prune.prune()).resolves.toEqual({ deleted: 0, skippedBusy: 1 });
    expect(await statusOf(busy)).toBe('offline');

    await prisma.job.update({ where: { id: job.id }, data: { status: 'succeeded' } });

    await expect(prune.prune()).resolves.toEqual({ deleted: 1, skippedBusy: 0 });
    expect(await statusOf(busy)).toBeUndefined();
  });

  // ===========================================================================
  // Deletion, the foreign key, and the reaper
  // ===========================================================================

  it('nulls claimedByNodeId rather than deleting the jobs, and the reaper then requeues them', async () => {
    const doomed = await makeNode('doomed', { status: 'offline', lastHeartbeatAt: ago(45 * DAY) });
    const job = await prisma.job.create({
      data: {
        type: JOB_TYPE,
        reason: 'backfill',
        status: 'running',
        attempts: 1,
        startedAt: ago(60 * 60 * SECOND),
        // Expired: the "dead owner" signal the reaper already has. Nothing
        // node-specific is needed to recover a job whose node was deleted.
        leaseExpiresAt: ago(60 * SECOND),
        claimedByNodeId: doomed,
        executor: 'node',
      },
    });

    await prisma.workerNode.delete({ where: { id: doomed } });

    const orphaned = await prisma.job.findUnique({ where: { id: job.id } });

    expect(orphaned).not.toBeNull();
    expect(orphaned?.claimedByNodeId).toBeNull();
    expect(orphaned?.status).toBe('running');

    const { reset } = await reaper.resetStuck();

    expect(reset).toBeGreaterThanOrEqual(1);

    const requeued = await prisma.job.findUnique({ where: { id: job.id } });

    expect(requeued?.status).toBe('pending');
    expect(requeued?.leaseExpiresAt).toBeNull();
    expect(requeued?.executor).toBeNull();
  });
});
