// =============================================================================
// Real-Postgres test: GET /api/graph/insights (GIC-16, #677, epic #661)
// =============================================================================
//
// The window queries (rising, fading ties, open risks) and the snapshot read are
// SQL, so they are proven against Postgres, on time-shifted fixtures: windows end
// at a fixed `now`, notes and evidence are dated relative to it. Excluded from
// `npm test`; run by `npm run test:db`.
//
// What it proves:
//   - rising: >= 3 conversations in the window AND >= 2x the window before (0 before
//     qualifies); steady, too-few and Meeting entities do not; another owner's mentions
//     do not count; a longer window reaches older mentions;
//   - fading ties: People/Organizations only, >= 3 evidence rows before and none in
//     the window, parallel relation types merge into one pair, newest silence first;
//   - open risks: status `open` only, readable only, high severity first, a merged
//     subject is dropped (not the risk), and a sensitive person fact never appears;
//   - themes and connectors come from the `kg.graph_layout` snapshot: the bridge between
//     two groups is the first connector, labels are live (a merged entity drops out),
//     `stale` is propagated, an old snapshot reports `connectorsReady: false`, and no
//     snapshot reads `none` without enqueueing anything.
// =============================================================================

import type { PrismaClient } from '@prisma/client';

import { GraphLayoutEnqueuer, GraphOntologyService, GraphPreferencesService, KG_GRAPH_LAYOUT_JOB_TYPE } from '@marinoscar/kvox-api/graph';
import { GraphInsightsService, KgGraphLayoutHandler } from './package-internals';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from './graph-read.fixtures';
import { createDbJobs, createDbSettings } from '../helpers/graph-ports.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('graph-insights.db.spec');

const EMAIL_PREFIX = 'graph-insights-test';
const NOW = new Date('2026-06-30T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describeWithDb('GET /api/graph/insights (real Postgres)', () => {
  let prisma: PrismaClient;
  let insights: GraphInsightsService;
  let handler: KgGraphLayoutHandler;
  const owners: string[] = [];

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    const { port } = createDbJobs(prisma);
    const enqueuer = new GraphLayoutEnqueuer(port);
    handler = new KgGraphLayoutHandler(port, p);
    insights = new GraphInsightsService(p, enqueuer, new GraphOntologyService(p, new GraphPreferencesService(createDbSettings(prisma))));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await prisma.job.deleteMany({ where: { type: KG_GRAPH_LAYOUT_JOB_TYPE, subjectId: { in: owners } } });
    owners.length = 0;
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function owner(suffix: string) {
    const user = await createUser(prisma, EMAIL_PREFIX, suffix);
    owners.push(user.id);
    return { user, g: new GraphFixture(prisma, user.id) };
  }

  const get = (ownerId: string, window: '30d' | '90d' | '365d' = '30d') => insights.insights(ownerId, window, { now: NOW });

  /** `n` notes created `days` days before NOW, each mentioning `entityId`. */
  async function mentions(ownerId: string, entityId: string, days: number[]) {
    for (const d of days) {
      const note = await prisma.note.create({
        data: { ownerId, title: 'n', body: 'b', status: 'ready', sourceType: 'document', currentVersion: 1, createdAt: daysAgo(d) },
      });
      await prisma.kgMention.create({ data: { ownerId, entityId, noteId: note.id, status: 'linked' } });
    }
  }

  /** Re-date every evidence row of a relation, then add `dates.length - 1` more so there are `dates.length`. */
  async function relationEvidenceAt(g: GraphFixture, ownerId: string, relationId: string, dates: number[]) {
    // Add first: the no-orphans trigger refuses a relation with no evidence at COMMIT.
    const old = await prisma.kgEvidence.findMany({ where: { ownerId, subjectKind: 'relation', subjectId: relationId }, select: { id: true } });
    for (const d of dates) await g.evidence('relation', relationId, { createdAt: daysAgo(d) });
    await prisma.kgEvidence.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  it('rising: needs 3 conversations in the window and twice the window before; leaves out meetings and other owners', async () => {
    const { user, g } = await owner('rising');
    const other = await owner('rising-other');
    const hot = await g.entity('Project', 'Copilot rollout');
    const fresh = await g.entity('Topic', 'Pricing');
    const steady = await g.entity('Person', 'Steady Sam');
    const few = await g.entity('Person', 'Few Fiona');
    const meeting = await g.entity('Meeting', 'Standup');
    const foreign = await other.g.entity('Person', 'Not mine');

    await mentions(user.id, hot, [1, 3, 5, 9, 40]); // 4 in the window, 1 before
    await mentions(user.id, fresh, [2, 4, 6]); // 3, none before
    await mentions(user.id, steady, [1, 2, 3, 35, 40, 45]); // 3 / 3: not 2x
    await mentions(user.id, few, [1, 2]); // below the minimum
    await mentions(user.id, meeting, [1, 2, 3, 4, 5]);
    await mentions(other.user.id, foreign, [1, 2, 3, 4]);

    const res = await get(user.id);
    expect(res.rising.map((r) => r.entity.label)).toEqual(['Copilot rollout', 'Pricing']);
    expect(res.rising[0]).toMatchObject({ count: 4, previous: 1 });
    expect(res.rising[0].reason).toBe('Came up in 4 conversations in the last 30 days, up from 1 before.');
    expect(res.rising[1]).toMatchObject({ count: 3, previous: 0 });
    expect(res.rising[1].reason).toContain('and not before');
    expect(res.window).toMatchObject({ key: '30d', days: 30 });
  });

  it('rising: a longer window reaches older mentions', async () => {
    const { user, g } = await owner('rising-long');
    const e = await g.entity('Person', 'Old Olga');
    await mentions(user.id, e, [60, 70, 80, 100]); // 3 in the 90d window... and 1 before it
    expect((await get(user.id, '30d')).rising).toEqual([]);
    const res = await get(user.id, '90d');
    expect(res.rising.map((r) => r.entity.label)).toEqual(['Old Olga']);
    expect(res.rising[0]).toMatchObject({ count: 3, previous: 1 });
  });

  it('fading ties: people and organizations with >= 3 evidence before the window and none in it', async () => {
    const { user, g } = await owner('fading');
    const joe = await g.entity('Person', 'Joe');
    const ann = await g.entity('Person', 'Ann');
    const bob = await g.entity('Person', 'Bob');
    const cara = await g.entity('Person', 'Cara');
    const acme = await g.entity('Organization', 'Acme');
    const atlas = await g.entity('Project', 'Atlas');

    const cold = await g.relation('KNOWS', joe, ann);
    await relationEvidenceAt(g, user.id, cold, [100, 120, 150]);
    const warm = await g.relation('KNOWS', joe, bob);
    await relationEvidenceAt(g, user.id, warm, [100, 120, 150, 5]); // one in the window
    const thin = await g.relation('KNOWS', joe, cara);
    await relationEvidenceAt(g, user.id, thin, [100, 120]); // too little before
    const org = await g.relation('WORKS_AT', ann, acme);
    await relationEvidenceAt(g, user.id, org, [60, 61, 62]); // newer silence
    const project = await g.relation('WORKS_ON', joe, atlas);
    await relationEvidenceAt(g, user.id, project, [100, 120, 150]); // not People/Organizations
    // A second relation type between Joe and Ann merges into the same pair.
    const colleague = await g.relation('COLLEAGUE_OF', ann, joe);
    await relationEvidenceAt(g, user.id, colleague, [90]);

    const res = await get(user.id);
    expect(res.fadingTies.map((f) => [f.from.label, f.to.label].sort().join('+'))).toEqual(['Acme+Ann', 'Ann+Joe']);
    const annJoe = res.fadingTies[1];
    expect(annJoe.relationTypes).toEqual(['COLLEAGUE_OF', 'KNOWS']);
    expect(annJoe.evidenceBefore).toBe(4);
    expect(annJoe.lastEvidenceAt).toBe(daysAgo(90).toISOString());
    expect(annJoe.reason).toMatch(/^You haven't discussed (Ann|Joe) with (Ann|Joe) since Apr 1, 2026\.$/);
  });

  it('open risks: open and readable only, high severity first, merged subject dropped, sensitive facts never shown', async () => {
    const { user, g } = await owner('risks');
    const project = await g.entity('Project', 'Copilot rollout');
    const gone = await g.entity('Project', 'Merged away', { reviewStatus: 'merged', mergedIntoId: project });
    const low = await g.item('risk', { subjectId: project, statement: 'Budget may slip', props: { severity: 'low' }, occurredAt: daysAgo(3) });
    const high = await g.item('risk', { subjectId: project, title: 'Legal review', statement: 'Legal has not signed off', props: { severity: 'high' }, occurredAt: daysAgo(9) });
    await g.item('risk', { subjectId: project, statement: 'Already handled', status: 'mitigated', props: { severity: 'high' } });
    await g.item('risk', { subjectId: project, statement: 'Not reviewed yet', reviewStatus: 'unreviewed', props: { severity: 'high' } });
    const orphan = await g.item('risk', { subjectId: gone, statement: 'On a merged project', props: { severity: 'medium' } });
    await g.item('person_fact', { subjectId: project, statement: 'SECRET-HEALTH-FACT', sensitivity: 'sensitive' });

    const res = await get(user.id);
    expect(res.openRisks.map((r) => r.id)).toEqual([high, orphan, low]);
    expect(res.openRisks[0]).toMatchObject({ title: 'Legal review', severity: 'high', subject: { id: project, label: 'Copilot rollout', type: 'Project' } });
    expect(res.openRisks[1].subject).toBeNull();
    expect(JSON.stringify(res)).not.toContain('SECRET-HEALTH-FACT');
  });

  it('themes and connectors come from the snapshot: the bridge first, labels live, stale propagated', async () => {
    const { user, g } = await owner('snapshot');
    const group = async (prefix: string) => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await g.entity('Person', `${prefix} ${i}`));
      for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) await g.relation('KNOWS', ids[i], ids[j]);
      return ids;
    };
    const left = await group('Left');
    const right = await group('Right');
    const bridge = await g.entity('Person', 'Joe Bridge');
    await g.relation('KNOWS', bridge, left[0]);
    await g.relation('KNOWS', bridge, right[0]);

    const none = await get(user.id);
    expect(none).toMatchObject({ status: 'none', themes: [], connectors: [], connectorsReady: false });
    expect(await prisma.job.count({ where: { type: KG_GRAPH_LAYOUT_JOB_TYPE, subjectId: user.id } })).toBe(0);

    await handler.process({ id: 'job-1', payload: { ownerId: user.id } } as never);
    const res = await get(user.id);
    expect(res).toMatchObject({ status: 'ready', stale: false, tooLarge: false, connectorsReady: true });
    expect(res.themes.length).toBeGreaterThanOrEqual(2);
    expect(res.themes[0].memberSample.length).toBeGreaterThan(0);
    expect(res.connectors[0].entity).toMatchObject({ id: bridge, label: 'Joe Bridge' });
    expect(res.connectors[0].clusters.length).toBeGreaterThanOrEqual(2);
    expect(res.connectors[0].reason).toMatch(/^Joe Bridge connects the .+ group and the .+ group\.$/);
    expect(JSON.stringify(res)).not.toMatch(/"score":\s*"/);

    // Forgotten after the snapshot: the label disappears everywhere.
    await prisma.kgEntity.update({ where: { id: bridge }, data: { reviewStatus: 'merged', mergedIntoId: left[0] } });
    const after = await get(user.id);
    expect(after.stale).toBe(true);
    expect(after.connectors.map((c) => c.entity.id)).not.toContain(bridge);
    expect(JSON.stringify(after)).not.toContain('Joe Bridge');
  });

  it('a snapshot computed before connectors existed reports connectorsReady: false', async () => {
    const { user, g } = await owner('old');
    const a = await g.entity('Person', 'A');
    const b = await g.entity('Person', 'B');
    await g.relation('KNOWS', a, b);
    await handler.process({ id: 'job-1', payload: { ownerId: user.id } } as never);
    const row = await prisma.kgGraphLayout.findFirstOrThrow({ where: { ownerId: user.id } });
    const { connectors: _dropped, ...older } = row.clusters as Record<string, unknown>;
    await prisma.kgGraphLayout.update({ where: { id: row.id }, data: { clusters: older as never } });

    const res = await get(user.id);
    expect(res).toMatchObject({ status: 'ready', connectorsReady: false, connectors: [] });
    expect(res.themes.length).toBe(1);
  });
});
