// =============================================================================
// The two fleet crons IN SEQUENCE (issue #270, epic #254)
// =============================================================================
//
// THE REGRESSION THIS FILE EXISTS FOR — the void-retention bug — is invisible
// to any test that exercises one cron at a time. Both pass with the bug
// present:
//
//   * `NodeOfflinePruneTask` selects `status = 'offline'`, and deletes offline
//     rows correctly. Green.
//   * `NodeStaleOfflineTask` marks silent nodes offline. Green.
//   * Drop the sweep, and the prune keeps passing its own tests while doing
//     NOTHING in production, because a crashed node never calls `deregister`
//     and so never reaches `offline` at all. `nodes.offlineRetentionDays`
//     silently applies to exactly the nodes that do not need it.
//
// So the assertion here is a SEQUENCE: crash a node, run the sweep, run the
// prune, expect the row gone. If either half stops feeding the other, this
// fails and nothing else does.
//
// -----------------------------------------------------------------------------
// WHY A NARROW PRISMA EMULATION AND NOT A MOCK
// -----------------------------------------------------------------------------
//
// A `jest.fn()` returning canned rows cannot express "the row the first cron
// wrote is the row the second cron reads" — which is the entire property under
// test. A real Postgres can, and
// `test/nodes/node-fleet-lifecycle.db.spec.ts` does exactly that; but that
// suite is excluded from `npm test` and runs only in CI's smoke job, and this
// regression is too cheap to lose to a database being unavailable.
//
// So `FakeNodeStore` below applies the tasks' OWN `where` objects to
// in-memory rows. It supports precisely the operators these two tasks use and
// throws on anything else, deliberately: the day somebody adds a `NOT` or a
// `gte` to one of those queries, this file fails loudly with "unsupported
// operator" instead of quietly returning the wrong rows and passing. It is a
// test fixture, never an assertion about Prisma's semantics — those belong in
// the `.db.spec.ts`.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import type { Job } from '@prisma/client';

import type { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';

import { NodeFleetPruneHandler } from '../../src/nodes/handlers/node-fleet-prune.handler';
import { NodeFleetSweepHandler } from '../../src/nodes/handlers/node-fleet-sweep.handler';
import type { NodeLifecycleService } from '../../src/nodes/node-lifecycle.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

/** The shipped policy: stale after 90s, offline after 4 x that, forgotten after 30 days. */
const POLICY = { staleHeartbeatSeconds: 90, offlineStaleMultiplier: 4, offlineRetentionDays: 30 };

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

interface FakeNode {
  id: string;
  status: string;
  registeredAt: Date;
  lastHeartbeatAt: Date | null;
  /** #288: the sweep's `updateManyAndReturn` projects this into the notification. */
  name?: string;
}

interface FakeJob {
  claimedByNodeId: string | null;
  status: string;
}

/** Applies one leaf condition. Throws on an operator this fixture does not model. */
function matchesLeaf(value: unknown, condition: unknown): boolean {
  if (condition === null || typeof condition !== 'object') {
    return value === condition;
  }

  for (const [operator, operand] of Object.entries(condition as Record<string, unknown>)) {
    if (operator === 'lt') {
      // `NULL < x` is NULL in SQL — never true. Reproducing that is the whole
      // reason the never-heartbeated arm exists.
      if (!(value instanceof Date) || !(operand instanceof Date) || value >= operand) return false;
    } else if (operator === 'in') {
      if (!Array.isArray(operand) || !operand.includes(value)) return false;
    } else {
      throw new Error(`FakeNodeStore: unsupported operator "${operator}"`);
    }
  }

  return true;
}

/** Applies a `where` (an AND of leaves, with an optional `OR` array). */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (field === 'OR') {
      if (!(condition as Record<string, unknown>[]).some((clause) => matches(row, clause))) {
        return false;
      }
      continue;
    }

    if (!matchesLeaf(row[field], condition)) return false;
  }

  return true;
}

/** The three `worker_node` operations and the one `job` operation the crons use. */
class FakeNodeStore {
  constructor(
    public nodes: FakeNode[],
    public jobs: FakeJob[] = []
  ) {}

  asPrisma(): PrismaService {
    return {
      workerNode: {
        updateMany: async ({ where, data }: any) => {
          const hits = this.nodes.filter((node) => matches(node as never, where));
          hits.forEach((node) => Object.assign(node, data));

          return { count: hits.length };
        },
        // #288: `UPDATE ... RETURNING`. Same statement, same `where`, but it
        // answers "which rows did I change?" — which is what the per-node
        // `nodes.node_offline` notification needs and a count cannot give.
        updateManyAndReturn: async ({ where, data }: any) => {
          const hits = this.nodes.filter((node) => matches(node as never, where));
          hits.forEach((node) => Object.assign(node, data));

          return hits.map((node) => ({
            id: node.id,
            name: node.name ?? node.id,
            lastHeartbeatAt: node.lastHeartbeatAt,
          }));
        },
        findMany: async ({ where }: any) =>
          this.nodes.filter((node) => matches(node as never, where)).map((node) => ({ id: node.id })),
        deleteMany: async ({ where }: any) => {
          const hits = this.nodes.filter((node) => matches(node as never, where));
          this.nodes = this.nodes.filter((node) => !hits.includes(node));

          return { count: hits.length };
        },
      },
      job: {
        findMany: async ({ where }: any) => {
          const hits = this.jobs.filter((job) => matches(job as never, where));

          return [...new Set(hits.map((job) => job.claimedByNodeId))].map((claimedByNodeId) => ({
            claimedByNodeId,
          }));
        },
      },
    } as unknown as PrismaService;
  }
}

const lifecycle = {
  getPolicy: async () => POLICY,
  staleCutoff: (policy: typeof POLICY, now: Date) =>
    new Date(now.getTime() - policy.staleHeartbeatSeconds * policy.offlineStaleMultiplier * SECOND),
  retentionCutoff: (policy: typeof POLICY, now: Date) =>
    new Date(now.getTime() - policy.offlineRetentionDays * DAY),
} as unknown as NodeLifecycleService;

/** Every switch unset, so both crons fail open — the shipped behaviour. */
const config = { get: () => undefined } as unknown as ConfigService;

/**
 * #288's notifier, stubbed. This suite is about the two sweeps' row semantics;
 * what the sweep tells anybody about them is asserted in
 * `src/nodes/handlers/node-fleet-sweep.handler.spec.ts`.
 */
const notifications = {
  notifyPermissionHolders: async () => undefined,
} as unknown as NotificationsService;

/**
 * The registry each handler self-registers into. A stub: this suite constructs
 * the handlers directly, so nothing is ever dispatched through it.
 */
const registry = { register: () => undefined } as unknown as JobHandlerRegistry;

/**
 * ⚠ #353 (epic #345) MOVED BOTH SWEEPS OFF THEIR CRONS AND ONTO HANDLERS, and
 * this suite followed the code rather than the class names: the property it
 * exists to pin — a crashed node is only prunable BECAUSE the sweep ran first —
 * is a property of the two pieces of work, not of what schedules them. The
 * tasks now merely enqueue, which is asserted in their own specs.
 */
function tasks(store: FakeNodeStore) {
  const prisma = store.asPrisma();

  return {
    sweep: new NodeFleetSweepHandler(registry, prisma, lifecycle, config, notifications),
    prune: new NodeFleetPruneHandler(registry, prisma, lifecycle),
  };
}

/** The row a worker hands `process`. Only `id` is read, for the log lines. */
const JOB = { id: 'job-fleet' } as Job;

const ago = (ms: number): Date => new Date(Date.now() - ms);

describe('The fleet lifecycle crons, run in sequence', () => {
  it('marks a node that went silent past the threshold offline', async () => {
    const store = new FakeNodeStore([
      { id: 'silent', status: 'online', registeredAt: ago(30 * DAY), lastHeartbeatAt: ago(20 * 60 * SECOND) },
    ]);

    await tasks(store).sweep.process(JOB);

    expect(store.nodes[0].status).toBe('offline');
  });

  it('leaves a node whose heartbeat is inside the threshold alone', async () => {
    // 90s x 4 = six minutes. A node heard from one minute ago is fine, and a
    // sweep that took it would flap the whole fleet offline and back.
    const store = new FakeNodeStore([
      { id: 'healthy', status: 'online', registeredAt: ago(30 * DAY), lastHeartbeatAt: ago(60 * SECOND) },
    ]);

    await tasks(store).sweep.process(JOB);

    expect(store.nodes[0].status).toBe('online');
  });

  it('ages a node that never heartbeated by registeredAt', async () => {
    // `lastHeartbeatAt` is NULL, so the ordinary arm cannot see this row at
    // all. Registered an hour ago and never pinged: a bad credential, a
    // firewall, or a crash during startup.
    const store = new FakeNodeStore([
      { id: 'never-pinged', status: 'online', registeredAt: ago(60 * 60 * SECOND), lastHeartbeatAt: null },
      { id: 'just-registered', status: 'online', registeredAt: ago(10 * SECOND), lastHeartbeatAt: null },
    ]);

    await tasks(store).sweep.process(JOB);

    expect(store.nodes.map((node) => node.status)).toEqual(['offline', 'online']);
  });

  it('never touches a disabled node, however long it has been silent', async () => {
    // An administrator's explicit intent. Swept to `offline`, a later
    // re-registration would bring it back ONLINE AND ENABLED — the kill
    // switch quietly undone by a timer, with nothing recording it.
    const store = new FakeNodeStore([
      { id: 'disabled', status: 'disabled', registeredAt: ago(90 * DAY), lastHeartbeatAt: ago(60 * DAY) },
    ]);

    await tasks(store).sweep.process(JOB);

    expect(store.nodes[0].status).toBe('disabled');
  });

  it('drains a draining node to offline when it stops answering', async () => {
    // `draining` is "finish what you hold" — a live state a node is expected
    // to keep heartbeating through, so a silent one is just as gone as a
    // silent `online` one.
    const store = new FakeNodeStore([
      { id: 'draining', status: 'draining', registeredAt: ago(30 * DAY), lastHeartbeatAt: ago(DAY) },
    ]);

    await tasks(store).sweep.process(JOB);

    expect(store.nodes[0].status).toBe('offline');
  });

  // ===========================================================================
  // THE ORDERING TEST — the regression guard for the void-retention bug
  // ===========================================================================

  it('makes a crashed node prunable, which the prune alone never could', async () => {
    // A node that was healthy 45 days ago and was then OOM-killed. It never
    // called `deregister`, so its row still reads `online`.
    const crashed: FakeNode = {
      id: 'crashed',
      status: 'online',
      registeredAt: ago(90 * DAY),
      lastHeartbeatAt: ago(45 * DAY),
    };
    const store = new FakeNodeStore([crashed]);
    const { sweep, prune } = tasks(store);

    // WITHOUT THE SWEEP: the prune reaches nothing. This is the bug — 45 days
    // of silence against a 30-day retention, and the row is untouchable
    // because its status never changed.
    await expect(prune.prune()).resolves.toEqual({ deleted: 0, skippedBusy: 0 });
    expect(store.nodes).toHaveLength(1);

    // WITH THE SWEEP FIRST: the status becomes `offline`, which is exactly the
    // input the prune selects on, and the row is then forgotten.
    await sweep.process(JOB);
    expect(crashed.status).toBe('offline');

    await expect(prune.prune()).resolves.toEqual({ deleted: 1, skippedBusy: 0 });
    expect(store.nodes).toHaveLength(0);
  });

  it('keeps a node past retention that still holds a running job, and takes it once it settles', async () => {
    const partitioned: FakeNode = {
      id: 'partitioned',
      status: 'online',
      registeredAt: ago(90 * DAY),
      lastHeartbeatAt: ago(40 * DAY),
    };
    const job: FakeJob = { claimedByNodeId: 'partitioned', status: 'running' };
    const store = new FakeNodeStore([partitioned], [job]);
    const { sweep, prune } = tasks(store);

    await sweep.process(JOB);

    // Deleting it would be SAFE — the FK is `SetNull` — and would still be
    // wrong: it manufactures a `running` row owned by nobody, which is the
    // state the reaper's zombie signal exists to recover from.
    await expect(prune.prune()).resolves.toEqual({ deleted: 0, skippedBusy: 1 });
    expect(store.nodes).toHaveLength(1);

    // The reaper settles the job on its own schedule; the next daily tick
    // takes the node. Nothing has to be re-run by hand.
    job.status = 'failed';

    await expect(prune.prune()).resolves.toEqual({ deleted: 1, skippedBusy: 0 });
    expect(store.nodes).toHaveLength(0);
  });

  it('keeps an offline node that is still inside its retention', async () => {
    const store = new FakeNodeStore([
      { id: 'recent', status: 'offline', registeredAt: ago(60 * DAY), lastHeartbeatAt: ago(5 * DAY) },
    ]);

    await expect(tasks(store).prune.prune()).resolves.toEqual({ deleted: 0, skippedBusy: 0 });
    expect(store.nodes).toHaveLength(1);
  });
});
