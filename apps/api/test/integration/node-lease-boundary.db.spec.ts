// =============================================================================
// Real-Postgres test: the node lease boundary — late submissions, renewal,
// and a persist throw (issue #290, epic #254, Phase 8)
// =============================================================================
//
// EVIDENCE FOR EPIC #254'S SUCCESS CRITERIA 7 AND 8: a job whose lease has
// expired is no longer this node's to speak for, and a straggler that shows
// up anyway must not be able to clobber a run somebody else may already be
// executing.
//
// `nodes/node-data-plane.integration.spec.ts` already proves "409, and signs
// nothing" for the SIGNING endpoints, over a MOCKED `PrismaService` whose
// `job.updateMany` returns whatever the test told it to. What it cannot prove
// is the part that actually matters operationally: that a real, unrelated
// write attempted after the 409 genuinely touches ZERO bytes of the row —
// not "the mock wasn't called", but "Postgres still holds exactly what it
// held before". That is a property of `assertJobHeldByNode`'s guard actually
// running before any statement reaches the database, and only a real
// database can show it. This suite claims a job through the REAL
// `NodesService.claimJobs` (so `attempts`, the lease and the claim are all
// genuine, not hand-seeded), backdates the lease directly — the same
// established fixture technique `job-stuck-reset.db.spec.ts` uses to stand in
// for "time passed" without a real sleep — and then attempts a REAL
// `submitResult`/`renewLease` call, snapshotting the full row before and
// after to prove nothing moved.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test` and run by
// `npm run test:db` (CI's `smoke` job). See `../jobs/db-test-support.ts`.
//
// MEASURED WALL CLOCK: ~1s for this file alone. See `docs/TESTING.md`.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { Job, PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { JobClaimService } from '../../src/jobs/job-claim.service';
import { JobLeaseService } from '../../src/jobs/job-lease.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { NodesService } from '../../src/nodes/nodes.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { ClaimJobsDto, NodeJobResultDto } from '../../src/nodes/dto/node-control-plane.dto';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { NodeOffloadService } from '../../src/jobs/node-offload.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';

const { describeWithDb } = resolveDbSuite('node-lease-boundary.db.spec');

describeWithDb('The node lease boundary (real Postgres)', () => {
  let prisma: PrismaClient;
  let nodes: NodesService;

  const PREFIX = `test.lease-boundary.${process.pid}.`;
  const OWNER_EMAIL = `${PREFIX}owner@example.test`;
  const OK_TYPE = `${PREFIX}ok`;
  const THROWS_TYPE = `${PREFIX}throws`;

  let ownerId: string;
  let nodeId: string;

  /**
   * A generous lease (the default `jobs.jobTimeoutMs`, undefined here) — long
   * enough nothing expires by accident — and `maxAttempts: 1`, so a single
   * `persistNodeResult` throw settles the job TERMINALLY rather than
   * scheduling a retry: the row this suite reads back is `failed`, not
   * `pending` with a backoff, which is the state the "not retriable by the
   * node" assertion below is actually about.
   */
  const config = {
    get: (key: string) => (key === 'jobs.maxAttempts' ? 1 : undefined),
  } as unknown as ConfigService;

  /** How many times the always-throwing handler's `persistNodeResult` ran. */
  let throwingPersistCalls = 0;

  const registry = new JobHandlerRegistry();
  registry.register({
    type: OK_TYPE,
    process: async () => undefined,
    nodeResultSchema: z.object({ ok: z.boolean() }).loose(),
    persistNodeResult: async () => undefined,
  });
  registry.register({
    type: THROWS_TYPE,
    process: async () => undefined,
    nodeResultSchema: z.object({ ok: z.boolean() }).loose(),
    persistNodeResult: async () => {
      throwingPersistCalls += 1;
      throw new Error('simulated storage failure while persisting the node result');
    },
  });

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();

    const owner = await prisma.user.create({
      data: { email: OWNER_EMAIL, displayName: 'lease-boundary suite' },
    });
    ownerId = owner.id;

    const node = await prisma.workerNode.create({
      data: {
        name: `${PREFIX}node`,
        hostname: 'lease-boundary-box',
        platform: 'linux-x64',
        cliVersion: '0.0.0-test',
        eligibleTypes: [OK_TYPE, THROWS_TYPE],
        concurrency: 10,
        status: 'online',
        createdById: ownerId,
      },
    });
    nodeId = node.id;

    const prismaService = prisma as unknown as PrismaService;
    const claims = new JobClaimService(prismaService);
    // REAL terminal service, over the REAL client: the persist-throw test
    // needs `completeFailed` to actually reach the row, not a stub.
    const terminal = new JobTerminalService(
      prismaService,
      config,
      new ProviderThrottleService(config),
      new EventEmitter2(),
      registry
    );

    nodes = new NodesService(
      prismaService,
      config,
      claims,
      terminal,
      // THE REAL SERVICE (#347). This suite is about the lease boundary
      // itself, so the renewal write must be the shipped one — the guard it
      // carries is exactly what these cases probe.
      new JobLeaseService(prismaService),
      registry,
      // WHAT A NODE MAY CLAIM HERE, RIGHT NOW (#349, #352) — the REAL service
      // over this suite's own registry, with only its settings read stubbed to
      // the shipped default (`jobSecretBrokerEnabled: false`). No handler here
      // declares a broker or an offload gate, so the three filters it applies
      // are a no-op — but the claim reads it, and stubbing the service itself
      // would hide a drift between what a node is offered and what the
      // in-process worker's `system` mode claims as the complement.
      new NodeOffloadService(registry, {
        getNodesPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.nodes }),
      } as unknown as SystemSettingsService)
    );
  });

  afterEach(async () => {
    await prisma.job.deleteMany({ where: { type: { in: [OK_TYPE, THROWS_TYPE] } } });
    throwingPersistCalls = 0;
  });

  afterAll(async () => {
    await prisma?.job.deleteMany({ where: { type: { in: [OK_TYPE, THROWS_TYPE] } } });
    await prisma?.workerNode.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma?.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await prisma?.$disconnect();
  });

  /** Claims one job of `type` as this suite's node, through the real service. */
  async function claimOne(type: string): Promise<Job> {
    await prisma.job.create({ data: { type, reason: 'backfill' } });
    const [claimed] = await nodes.claimJobs(ownerId, nodeId, { types: [type] } as ClaimJobsDto);
    expect(claimed).toBeDefined();
    expect(claimed.status).toBe('running');
    expect(claimed.leaseExpiresAt).not.toBeNull();
    return claimed;
  }

  /** Backdates a row's lease into the past — real time need not actually pass. */
  async function expireLease(jobId: string): Promise<void> {
    await prisma.job.update({
      where: { id: jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
  }

  // ===========================================================================
  // 409, and nothing written — proved by a real row snapshot, not a mock call
  // ===========================================================================

  it('409s a late submitResult once the lease has expired, and writes ZERO bytes of the row', async () => {
    const claimed = await claimOne(OK_TYPE);
    await expireLease(claimed.id);

    const before = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });

    await expect(
      nodes.submitResult(ownerId, nodeId, claimed.id, {
        type: OK_TYPE,
        result: { ok: true },
      } as NodeJobResultDto)
    ).rejects.toBeInstanceOf(ConflictException);

    // The handler was never reached — the guard threw before persistence.
    expect(throwingPersistCalls).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });

    // BYTE-EQUALITY of the whole row, not a spot check on `status`: a
    // straggler must not be able to move `attempts`, `lastError`,
    // `providerKey` or any other field a settlement would have written
    // either. `Job` carries no `updatedAt`, so nothing here is expected to
    // drift on its own.
    expect(after).toEqual(before);
  });

  it('409s a late renewLease too, and leaves the lease exactly as expired as it found it', async () => {
    const claimed = await claimOne(OK_TYPE);
    await expireLease(claimed.id);

    const before = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });

    await expect(nodes.renewLease(ownerId, nodeId, claimed.id)).rejects.toBeInstanceOf(
      ConflictException
    );

    const after = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(after).toEqual(before);
  });

  it('renews cleanly BEFORE expiry, extending the lease into the future', async () => {
    const claimed = await claimOne(OK_TYPE);
    const originalLease = claimed.leaseExpiresAt as Date;

    const { leaseExpiresAt } = await nodes.renewLease(ownerId, nodeId, claimed.id);

    expect(leaseExpiresAt.getTime()).toBeGreaterThan(originalLease.getTime());

    const row = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(row.leaseExpiresAt?.getTime()).toBe(leaseExpiresAt.getTime());
    expect(row.status).toBe('running');
  });

  // ===========================================================================
  // A `persistNodeResult` throw settles the job through the ordinary failure
  // path — never a 4xx the node might retry
  // ===========================================================================

  it('routes a persistNodeResult throw through completeFailed, not back to the node as retriable', async () => {
    const claimed = await claimOne(THROWS_TYPE);

    let caught: unknown;
    try {
      await nodes.submitResult(ownerId, nodeId, claimed.id, {
        type: THROWS_TYPE,
        result: { ok: true },
      } as NodeJobResultDto);
    } catch (error) {
      caught = error;
    }

    // 500, not 4xx: the file header's whole argument is that a node must not
    // be told this is retriable-by-it, and `resubmit: false` says so in the
    // body too.
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    expect((caught as InternalServerErrorException).getResponse()).toMatchObject({
      details: { jobId: claimed.id, resubmit: false },
    });

    expect(throwingPersistCalls).toBe(1);

    // The REAL settlement, written by the REAL `JobTerminalService`: the row
    // is not left `running` for the reaper to eventually find — it is
    // already `failed`, right now, with the thrown message on it.
    const row = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(row.status).toBe('failed');
    expect(row.finishedAt).not.toBeNull();
    expect(row.lastError).toContain('simulated storage failure');
    // The claim is released exactly as any other terminal write releases it.
    expect(row.claimedByNodeId).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
  });
});
