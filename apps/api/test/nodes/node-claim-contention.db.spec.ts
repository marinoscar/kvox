// =============================================================================
// Real-Postgres test: a node and the in-process worker never get the same row
// (issue #268, epic #254)
// =============================================================================
//
// THIS IS THE ACCEPTANCE CRITERION THE NODE PLANE ADDS TO THE ONE #260
// ALREADY PROVED. `job-claim.db.spec.ts` shows that two callers of
// `JobClaimService` never receive the same job; what this file shows is that
// the claimer reached through `NodesService.claimJobs` — with its ownership
// check, its type intersection and its concurrency clamp in front of it — is
// still THAT claimer, and not a second implementation that happens to look
// similar.
//
// It matters because the safety property is not a property of this file's
// arguments; it is a property of the SQL. A node plane that had grown its own
// `SELECT … then UPDATE`, or that wrapped the claim in an in-process mutex,
// would pass every mocked test in this repository and would double-claim the
// first time a node and the API server polled within the same millisecond —
// in production, on someone else's hardware, as duplicated work nobody can
// reproduce.
//
// So the two racers here are deliberately asymmetric and both real:
//
//   * the NODE side: the actual `NodesService`, over its own `PrismaClient`,
//     claiming for a genuine `worker_nodes` row;
//   * the SERVER side: `JobClaimService` called exactly as `JobWorker` calls
//     it (`nodeId: null`, `executor: 'server'`), over a SECOND, independent
//     client with its own connection pool — which is as close to "a second
//     replica" as one process gets.
//
// A mock cannot express any of this: a mocked `$queryRaw` returns whatever
// the test told it to, so a test built on one proves the test's arrangement
// and nothing about row locks. Postgres has to be asked.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test` and run by
// `npm run test:db` (CI's `smoke` job, after `prisma:migrate`). See
// `../jobs/db-test-support.ts`.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { Job, PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { JobClaimService } from '../../src/jobs/job-claim.service';
import { JobLeaseService } from '../../src/jobs/job-lease.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { NodesService } from '../../src/nodes/nodes.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { ClaimJobsDto } from '../../src/nodes/dto/node-control-plane.dto';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { NodeOffloadService } from '../../src/jobs/node-offload.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';

const { describeWithDb } = resolveDbSuite('node-claim-contention.db.spec');

describeWithDb('A node and the in-process worker claiming concurrently (real Postgres)', () => {
  let nodeClient: PrismaClient;
  let serverClient: PrismaClient;
  let nodes: NodesService;
  let serverClaimer: JobClaimService;

  /** Every row this suite creates is prefixed, so cleanup deletes only its own. */
  const PREFIX = `test.node-contention.${process.pid}.`;
  let counter = 0;
  const nextType = (): string => `${PREFIX}${(counter += 1)}`;

  const OWNER_EMAIL = `${PREFIX}owner@example.test`;
  let ownerId: string;
  let nodeId: string;

  /**
   * A registry carrying one node-eligible handler per type this suite uses.
   *
   * `NodesService` drops types no node could run — a type whose handler has no
   * `nodeResultSchema`/`persistNodeResult` pair — so a suite that registered
   * nothing would prove only that an empty type list claims nothing.
   */
  const registry = new JobHandlerRegistry();

  function registerNodeEligible(type: string): void {
    registry.register({
      type,
      process: async () => undefined,
      nodeResultSchema: z.object({}).loose(),
      persistNodeResult: async () => undefined,
    });
  }

  beforeAll(async () => {
    nodeClient = createDbClient();
    serverClient = createDbClient();
    await Promise.all([nodeClient.$connect(), serverClient.$connect()]);

    // A real owner and a real node row: `claimJobs` starts with
    // `assertOwnership`, which is a genuine query, and `claimed_by_node_id`
    // is a real foreign key since #267.
    const owner = await nodeClient.user.create({
      data: { email: OWNER_EMAIL, displayName: 'contention suite' },
    });
    ownerId = owner.id;

    const node = await nodeClient.workerNode.create({
      data: {
        name: `${PREFIX}node`,
        hostname: 'contention-box',
        platform: 'linux-x64',
        cliVersion: '0.0.0-test',
        eligibleTypes: [],
        concurrency: 50,
        status: 'online',
        createdById: ownerId,
      },
    });
    nodeId = node.id;

    nodes = new NodesService(
      nodeClient as unknown as PrismaService,
      { get: () => undefined } as unknown as ConfigService,
      new JobClaimService(nodeClient as unknown as PrismaService),
      // Never reached: this suite claims and never settles. Passing a stub
      // rather than a real one keeps the suite's failure surface to the claim.
      {} as unknown as JobTerminalService,
      // Never reached either: this suite claims and never renews.
      {} as unknown as JobLeaseService,
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

    serverClaimer = new JobClaimService(serverClient as unknown as PrismaService);
  });

  afterEach(async () => {
    await nodeClient.job.deleteMany({ where: { type: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await nodeClient?.job.deleteMany({ where: { type: { startsWith: PREFIX } } });
    await nodeClient?.workerNode.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await nodeClient?.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await Promise.all([nodeClient?.$disconnect(), serverClient?.$disconnect()]);
  });

  /** Seeds `count` immediately-runnable pending jobs, and points the node at their type. */
  async function seed(type: string, count: number): Promise<string[]> {
    registerNodeEligible(type);
    await nodeClient.workerNode.update({
      where: { id: nodeId },
      data: { eligibleTypes: [type] },
    });

    const base = Date.now();
    await nodeClient.job.createMany({
      data: Array.from({ length: count }, (_unused, index) => ({
        type,
        reason: 'backfill' as const,
        createdAt: new Date(base + index),
      })),
    });

    const rows = await nodeClient.job.findMany({
      where: { type },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    return rows.map((row) => row.id);
  }

  /** How the in-process worker claims: no node, `server` executor. */
  const claimAsServer = (type: string, limit: number): Promise<Job[]> =>
    serverClaimer.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: [type],
      limit,
      leases: [{ type: type, leaseMs: 60_000 }],
    });

  const claimAsNode = (limit: number): Promise<Job[]> =>
    nodes.claimJobs(ownerId, nodeId, { limit } as ClaimJobsDto);

  it('never hands one row to both the node and the server', async () => {
    // The DETERMINISTIC form: one row, two simultaneous claimers, repeated.
    // Exactly one side wins every round — no sampling, no "very likely".
    for (let round = 0; round < 10; round += 1) {
      const type = nextType();
      const [onlyId] = await seed(type, 1);

      const [nodeRows, serverRows] = await Promise.all([claimAsNode(1), claimAsServer(type, 1)]);

      expect(nodeRows.length + serverRows.length).toBe(1);
      expect([...nodeRows, ...serverRows][0].id).toBe(onlyId);

      await nodeClient.job.deleteMany({ where: { type } });
    }
  });

  it('partitions a batch between the two claimers with no overlap and nothing lost', async () => {
    const type = nextType();
    const ids = await seed(type, 20);

    const [nodeRows, serverRows] = await Promise.all([claimAsNode(20), claimAsServer(type, 20)]);

    const nodeIds = nodeRows.map((row) => row.id);
    const serverIds = serverRows.map((row) => row.id);

    // Disjoint: not one row was handed out twice.
    expect(nodeIds.filter((id) => serverIds.includes(id))).toEqual([]);
    // Complete: `SKIP LOCKED` steps over contended rows, it does not drop them.
    expect([...nodeIds, ...serverIds].sort()).toEqual([...ids].sort());
  });

  it('stamps the node’s own id and `node` executor on the rows it took', async () => {
    // The other half of "the two claimers are one statement": the parameters
    // this service passes have to reach the row, or job history would record
    // node-executed work as though the server had run it.
    const type = nextType();
    await seed(type, 3);

    const claimed = await claimAsNode(3);
    expect(claimed).toHaveLength(3);

    const rows = await nodeClient.job.findMany({ where: { type } });
    for (const row of rows) {
      expect(row.claimedByNodeId).toBe(nodeId);
      expect(row.executor).toBe('node');
      expect(row.status).toBe('running');
      // Charged at claim time — "attempts started", see `job-claim.service.ts`.
      expect(row.attempts).toBe(1);
      expect(row.leaseExpiresAt).not.toBeNull();
    }
  });

  it('clamps to the node’s live concurrency even when more rows are runnable', async () => {
    // The clamp is read off the row, so this is also the proof that a runtime
    // `set-concurrency` (a heartbeat) governs the very next claim.
    const type = nextType();
    await seed(type, 10);
    await nodeClient.workerNode.update({ where: { id: nodeId }, data: { concurrency: 3 } });

    const claimed = await claimAsNode(10);

    expect(claimed).toHaveLength(3);

    await nodeClient.workerNode.update({ where: { id: nodeId }, data: { concurrency: 50 } });
  });
});
