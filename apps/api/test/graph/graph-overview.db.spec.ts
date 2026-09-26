// =============================================================================
// Real-Postgres test: `kg.graph_layout` and the graph overview (#371)
// =============================================================================
//
// The handler's reads (readable/non-merged filters, `valid @> now()`, the
// sensitive-fact exclusion) and the overview's live label join are SQL, so
// they are proven against Postgres. Excluded from `npm test`; run by
// `npm run test:db` (CI's Smoke job).
//
// What it proves, end to end on a seeded owner:
//   - the handler writes one snapshot of ids and coordinates, keeps at most
//     two rows per owner, and never touches another owner's rows;
//   - the overview's shape, with labels joined live;
//   - merging or forgetting an entity after the snapshot drops its label
//     everywhere (spec §15) — no step of its own needed;
//   - a committed relation flips `stale`, and the GET does NOT enqueue for it;
//   - owner B (no snapshot, non-empty graph) sees `status: 'none'` and exactly
//     one bootstrap job is enqueued, however often B asks;
//   - refresh returns a job and `deduplicated: true` while it is pending;
//   - the listener enqueues one delayed job for a ≥ 20 % change and nothing
//     for a small one;
//   - Danger Zone `purgeAll` deletes the owner's snapshots.
// =============================================================================

import type { PrismaClient } from '@prisma/client';

import { JobsService } from '../../src/jobs/jobs.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { KG_GRAPH_LAYOUT_JOB_TYPE } from '../../src/graph/job-types';
import { GraphLayoutEnqueuer } from '../../src/graph/layout/graph-layout.enqueuer';
import { KgGraphLayoutHandler } from '../../src/graph/layout/graph-layout.handler';
import { GraphLayoutListener } from '../../src/graph/layout/graph-layout.listener';
import { GraphOverviewService } from '../../src/graph/layout/graph-overview.service';
import { KgPurgeService } from '../../src/graph/purge/kg-purge.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from './graph-read.fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('graph-overview.db.spec');

const EMAIL_PREFIX = 'graph-overview-test';

describeWithDb('kg.graph_layout and GET /api/graph/overview (real Postgres)', () => {
  let prisma: PrismaClient;
  let handler: KgGraphLayoutHandler;
  let enqueuer: GraphLayoutEnqueuer;
  let overview: GraphOverviewService;
  let listener: GraphLayoutListener;
  let purge: KgPurgeService;
  const owners: string[] = [];

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    handler = new KgGraphLayoutHandler(new JobHandlerRegistry(), p);
    enqueuer = new GraphLayoutEnqueuer(new JobsService(p), p);
    overview = new GraphOverviewService(p, enqueuer);
    listener = new GraphLayoutListener(p, enqueuer);
    purge = new KgPurgeService(p);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await prisma.job.deleteMany({ where: { type: KG_GRAPH_LAYOUT_JOB_TYPE, subjectId: { in: owners } } });
    owners.length = 0;
    // kg_graph_layouts rows go with their owner (owner_id Cascade).
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function owner(suffix: string) {
    const user = await createUser(prisma, EMAIL_PREFIX, suffix);
    owners.push(user.id);
    return { user, g: new GraphFixture(prisma, user.id) };
  }

  const run = (ownerId: string) => handler.process({ id: `job-${ownerId}`, payload: { ownerId } } as never);
  const layoutJobs = (ownerId: string) =>
    prisma.job.findMany({ where: { type: KG_GRAPH_LAYOUT_JOB_TYPE, subjectType: 'user', subjectId: ownerId } });

  /** Two people who met, a project, and an isolated organization. */
  async function seedSmallGraph(g: GraphFixture) {
    const sarah = await g.entity('Person', 'Sarah Chen');
    const tom = await g.entity('Person', 'Tom Diaz');
    const meeting = await g.entity('Meeting', 'Weekly sync');
    const project = await g.entity('Project', 'Atlas');
    const lonely = await g.entity('Organization', 'Nowhere Inc');
    await g.relation('ATTENDED', sarah, meeting);
    await g.relation('ATTENDED', tom, meeting);
    await g.relation('WORKS_ON', sarah, project);
    return { sarah, tom, meeting, project, lonely };
  }

  it('writes one snapshot and the overview joins labels live', async () => {
    const { user, g } = await owner('shape');
    const ids = await seedSmallGraph(g);

    await run(user.id);

    const rows = await prisma.kgGraphLayout.findMany({ where: { ownerId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeCount: 5, edgeCount: 3 });
    expect(JSON.stringify(rows[0].positions)).not.toContain('Sarah');
    expect(JSON.stringify(rows[0].clusters)).not.toContain('Sarah');

    const view = await overview.overview(user.id);
    expect(view).toMatchObject({ status: 'ready', pending: false, stale: false, tooLarge: false, nodeCount: 5 });
    expect(view.nodes).toHaveLength(5);
    expect(view.nodesTruncated).toBe(false);
    const byId = Object.fromEntries(view.nodes.map((n) => [n.id, n]));
    expect(byId[ids.sarah]).toMatchObject({ label: 'Sarah Chen', type: 'Person' });
    const unconnected = view.clusters.find((c) => c.id === -1);
    expect(unconnected).toMatchObject({ label: 'Unconnected', labelEntityId: null, size: 1 });
    expect(unconnected?.memberSample.map((m) => m.label)).toEqual(['Nowhere Inc']);
    const main = view.clusters.find((c) => c.id >= 0 && c.labelEntityId === ids.sarah);
    expect(main?.label).toBe('Sarah Chen');
    expect(await layoutJobs(user.id)).toHaveLength(0);
  });

  it('keeps at most two rows per owner and never touches another owner', async () => {
    const a = await owner('keep-a');
    const b = await owner('keep-b');
    await seedSmallGraph(a.g);
    await seedSmallGraph(b.g);
    await run(b.user.id);
    const bRow = await prisma.kgGraphLayout.findFirstOrThrow({ where: { ownerId: b.user.id } });

    for (let i = 0; i < 3; i += 1) await run(a.user.id);

    expect(await prisma.kgGraphLayout.count({ where: { ownerId: a.user.id } })).toBe(2);
    await expect(prisma.kgGraphLayout.findMany({ where: { ownerId: b.user.id } })).resolves.toEqual([bRow]);
  });

  it('never shows a label for an entity merged or forgotten after the snapshot', async () => {
    const { user, g } = await owner('privacy');
    const ids = await seedSmallGraph(g);
    await run(user.id);

    // Merge Tom into Sarah (a tombstone), then forget Sarah — which takes
    // Tom's tombstone with her. Sarah is also the main cluster's label source.
    await prisma.kgEntity.update({
      where: { id: ids.tom },
      data: { reviewStatus: 'merged', mergedIntoId: ids.sarah },
    });
    const forgotten = await purge.purgePerson(user.id, ids.sarah);
    expect(forgotten?.entityIds).toEqual(expect.arrayContaining([ids.sarah, ids.tom]));

    const view = await overview.overview(user.id);
    const text = JSON.stringify(view);
    expect(text).not.toContain('Sarah Chen');
    expect(text).not.toContain('Tom Diaz');
    expect(view.nodes.map((n) => n.id)).not.toContain(ids.sarah);
    expect(view.nodes.map((n) => n.id)).not.toContain(ids.tom);
    // The cluster Sarah named falls back to its number.
    const formerlySarah = view.clusters.find((c) => c.id >= 0 && c.label.startsWith('Cluster '));
    expect(formerlySarah?.labelEntityId).toBeNull();
    // The snapshot itself is untouched; only the read filters.
    expect(view.nodeCount).toBe(5);
  });

  it('reports stale after a relation is committed, without enqueueing', async () => {
    const { user, g } = await owner('stale');
    const ids = await seedSmallGraph(g);
    await run(user.id);
    expect((await overview.overview(user.id)).stale).toBe(false);

    await g.relation('WORKS_ON', ids.tom, ids.project);

    const view = await overview.overview(user.id);
    expect(view.stale).toBe(true);
    expect(view.pending).toBe(false);
    expect(await layoutJobs(user.id)).toHaveLength(0);
  });

  it('bootstraps exactly one delayed job for a non-empty graph with no snapshot, and none for an empty one', async () => {
    const empty = await owner('boot-empty');
    await expect(overview.overview(empty.user.id)).resolves.toMatchObject({ status: 'none', pending: false });
    expect(await layoutJobs(empty.user.id)).toHaveLength(0);

    const b = await owner('boot-b');
    await seedSmallGraph(b.g);
    const first = await overview.overview(b.user.id);
    expect(first).toMatchObject({ status: 'none', pending: true, nodes: [], clusters: [] });
    await overview.overview(b.user.id);

    const jobs = await layoutJobs(b.user.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ reason: 'backfill', status: 'pending', payload: { ownerId: b.user.id } });
    expect(jobs[0].scheduledFor!.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('refresh queues a rerun job and deduplicates while it is pending, pulling a delayed job forward', async () => {
    const { user, g } = await owner('refresh');
    await seedSmallGraph(g);
    await enqueuer.scheduleAutomatic(user.id);

    const first = await overview.refresh(user.id);
    const second = await overview.refresh(user.id);
    expect(first.deduplicated).toBe(true);
    expect(second).toEqual({ jobId: first.jobId, deduplicated: true });

    const jobs = await layoutJobs(user.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].scheduledFor).toBeNull();

    await prisma.job.deleteMany({ where: { id: first.jobId } });
    const fresh = await overview.refresh(user.id);
    expect(fresh.deduplicated).toBe(false);
    expect((await layoutJobs(user.id))[0]).toMatchObject({ reason: 'rerun', scheduledFor: null });
  });

  it('the listener enqueues one delayed job for a >= 20 % change and nothing for a small one', async () => {
    const { user, g } = await owner('listener');
    for (let i = 0; i < 50; i += 1) await g.entity('Person', `P${i}`);
    await run(user.id);

    await g.entity('Person', 'One more');
    await expect(listener.reconcile({ ownerId: user.id, reason: 'commit' })).resolves.toBe(false);
    expect(await layoutJobs(user.id)).toHaveLength(0);

    for (let i = 0; i < 10; i += 1) await g.entity('Person', `Q${i}`);
    await listener.reconcile({ ownerId: user.id, reason: 'commit' });
    await listener.reconcile({ ownerId: user.id, reason: 'commit' });
    const jobs = await layoutJobs(user.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ reason: 'backfill' });
  });

  it('excludes sensitive person facts and relations not valid now from the edges', async () => {
    const { user, g } = await owner('edges');
    const a = await g.entity('Person', 'A');
    const b = await g.entity('Person', 'B');
    const c = await g.entity('Person', 'C');
    await g.item('person_fact', { subjectId: a, counterpartyId: b, sensitivity: 'sensitive' });
    await g.relation('KNOWS', a, c, { valid: '[2019-01-01,2020-01-01)', precision: 'day' });
    await g.item('commitment', { subjectId: b, ownerPersonId: c });

    await run(user.id);
    const row = await prisma.kgGraphLayout.findFirstOrThrow({ where: { ownerId: user.id } });
    // Only the commitment's b–c edge survives.
    expect(row.edgeCount).toBe(1);
  });

  it('Danger Zone purgeAll deletes the owner snapshots', async () => {
    const { user, g } = await owner('purge');
    await seedSmallGraph(g);
    await run(user.id);
    const counts = await purge.purgeAll(user.id);
    expect(counts.graphLayouts).toBe(1);
    expect(await prisma.kgGraphLayout.count({ where: { ownerId: user.id } })).toBe(0);
    await expect(overview.overview(user.id)).resolves.toMatchObject({ status: 'none', pending: false });
  });
});
