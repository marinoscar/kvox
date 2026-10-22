// =============================================================================
// Real-Postgres test: kg.topics_promote (issue #666, epic #661)
// =============================================================================
//
// What only a real database can show, end to end through the real resolution
// pipeline (candidates, scoring), the real proposal writer and the real commit:
//
//   - three meetings with overlapping topic strings give ONE draft proposal per
//     distinct concept, each a Topic row plus a "Meeting DISCUSSED Topic" row
//     per meeting, every row cited;
//   - a string that matches an existing Topic links to it instead of creating one;
//   - NOTHING is in the graph until a proposal is committed;
//   - running it again creates nothing, before and after a commit.
//
// The AI is off here (no key, adjudication 'off'): the exact-alias arm needs
// neither, and what degrades is recorded, not thrown.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { normalizeAlias } from '@marinoscar/kvox-api/graph';
import { KgTopicsPromoteHandler, ResolutionService, AdjudicationService } from '@marinoscar/kvox-api/graph-extraction';
import { resolveDbSuite } from '../jobs/db-test-support';
import { CandidateService, ContextFeatureService, ProposalWriter } from './package-internals';
import { NOTE_BODY, V, buildServices, cleanup, noteCite, orphans } from './kg-proposal-db-support';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-topics-promote.db.spec');
const PREFIX = 'kg-topics-promote-test';

describeWithDb('kg.topics_promote (real Postgres)', () => {
  let prisma: PrismaClient;
  let services: ReturnType<typeof buildServices>;
  let handler: InstanceType<typeof KgTopicsPromoteHandler>;

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...env } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(env)) });
    await prisma.$connect();
    services = buildServices(prisma);
    const db = prisma as unknown as PrismaService;
    const noEmbedder = { resolve: async () => ({ ok: false, reason: 'ai_key_missing' }) };
    const resolution = new ResolutionService(
      db as never,
      new CandidateService(db as never),
      new ContextFeatureService(db as never),
      noEmbedder as never,
      { adjudicate: jest.fn(), buildCandidateDossiers: jest.fn() } as never,
    );
    const preferences = {
      get: async () => ({ resolution: { mode: 'precheck_confident', autoLinkThreshold: 0.9, newThreshold: 0.55, adjudication: 'off' } }),
    };
    handler = new KgTopicsPromoteHandler(
      { registerHandler: jest.fn() } as never,
      db as never,
      preferences as never,
      resolution,
      {} as unknown as AdjudicationService,
      new ProposalWriter(db as never),
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await cleanup(prisma, PREFIX, services.purge);
  });

  /** An owner with a ready note, an existing Topic "Licensing cost" and three meetings with overlapping topics. */
  async function seed() {
    const user = await prisma.user.create({ data: { email: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` } });
    const ownerId = user.id;
    const caller = { id: ownerId, email: user.email, roles: [], permissions: ['graph:read', 'graph:write'], isActive: true };
    const note = await prisma.note.create({
      data: { ownerId, title: 'Kickoff', body: NOTE_BODY, status: 'ready', sourceType: 'note', currentVersion: 1 },
    });
    await prisma.noteVersion.create({ data: { noteId: note.id, version: 1, kind: 'ai_generated', body: NOTE_BODY } });

    const topic = randomUUID();
    const meetings = [randomUUID(), randomUUID(), randomUUID()];
    const topics = [
      ['Licensing cost', 'Hiring plan'],
      ['licensing  COST', 'Hiring plan', 'Budget review'],
      ['Hiring plans', 'Budget review'],
    ];
    await prisma.$transaction(async (tx) => {
      await tx.kgEntity.create({ data: { id: topic, ownerId, type: 'Topic', label: 'Licensing cost', ontologyVersion: V } });
      await tx.kgEntityAlias.create({ data: { entityId: topic, ownerId, alias: 'Licensing cost', normalized: normalizeAlias('Licensing cost'), source: 'extraction' } });
      await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'entity', subjectId: topic, quote: 'Licensing cost was mentioned' } });
      for (const [i, id] of meetings.entries()) {
        await tx.kgEntity.create({
          data: { id, ownerId, type: 'Meeting', label: `Weekly sync ${i + 1}`, props: { noteId: note.id, topics: topics[i] }, ontologyVersion: V },
        });
        await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'entity', subjectId: id, ...noteCite(note.id, '# Kickoff') } });
      }
    });
    return { ownerId, caller, meetings, topic };
  }

  const run = (ownerId: string) => handler.process({ id: randomUUID(), payload: { userId: ownerId } } as never);

  const drafts = (ownerId: string) =>
    prisma.kgProposal.findMany({
      where: { ownerId, kind: 'import', status: 'draft', stats: { path: ['source'], equals: 'topics_promote' } },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });

  const graphCounts = async (ownerId: string) => ({
    entities: await prisma.kgEntity.count({ where: { ownerId } }),
    topics: await prisma.kgEntity.count({ where: { ownerId, type: 'Topic' } }),
    discussed: await prisma.kgRelation.count({ where: { ownerId, type: 'DISCUSSED' } }),
  });

  it('proposes one draft per distinct concept, with evidence, and writes nothing to the graph', async () => {
    const f = await seed();
    const before = await graphCounts(f.ownerId);

    await run(f.ownerId);

    const proposals = await drafts(f.ownerId);
    const byTopic = Object.fromEntries(proposals.map((p) => [(p.stats as { topic: string }).topic.toLowerCase().replace(/\s+/g, ' '), p]));
    expect(Object.keys(byTopic).sort()).toEqual(['budget review', 'hiring plan', 'licensing cost']);
    expect(proposals.every((p) => p.noteId === null && p.status === 'draft')).toBe(true);

    // Licensing cost links to the existing Topic; two meetings discussed it.
    const licensing = byTopic['licensing cost'];
    expect(licensing.items[0]).toMatchObject({ kind: 'entity', decision: 'pending', resolution: { ref: f.topic } });
    expect(licensing.items.slice(1).map((i) => (i.payload as any).from.entityId).sort()).toEqual([f.meetings[0], f.meetings[1]].sort());
    // Hiring plan ("Hiring plans" is the same concept): all three meetings, a NEW topic.
    const hiring = byTopic['hiring plan'];
    expect(hiring.items[0]).toMatchObject({ kind: 'entity', resolution: { ref: null }, payload: { type: 'Topic' } });
    expect(hiring.items.slice(1)).toHaveLength(3);
    expect(hiring.items.slice(1).every((i) => i.kind === 'relation' && (i.payload as any).type === 'DISCUSSED')).toBe(true);
    expect(byTopic['budget review'].items).toHaveLength(1 + 2);

    // Every row is cited.
    for (const p of proposals) {
      for (const item of p.items) {
        const cites = await prisma.kgEvidence.count({ where: { subjectKind: 'proposal_item', subjectId: item.id } });
        expect(cites).toBeGreaterThan(0);
      }
    }

    // Nothing entered the graph.
    expect(await graphCounts(f.ownerId)).toEqual(before);
    expect(before.discussed).toBe(0);
  });

  it('creates nothing when it runs twice', async () => {
    const f = await seed();
    await run(f.ownerId);
    const first = (await drafts(f.ownerId)).map((p) => p.id);
    const items = await prisma.kgProposalItem.count({ where: { proposal: { ownerId: f.ownerId } } });

    await run(f.ownerId);

    expect((await drafts(f.ownerId)).map((p) => p.id)).toEqual(first);
    expect(await prisma.kgProposalItem.count({ where: { proposal: { ownerId: f.ownerId } } })).toBe(items);
    expect(await prisma.kgProposal.count({ where: { ownerId: f.ownerId } })).toBe(first.length);
  });

  it('commits through the ordinary review, and a run after that proposes only what is still new', async () => {
    const f = await seed();
    await run(f.ownerId);
    const proposals = await drafts(f.ownerId);
    const pick = (label: string) => proposals.find((p) => (p.stats as { topic: string }).topic.toLowerCase() === label)!;

    for (const label of ['licensing cost', 'hiring plan']) {
      const p = pick(label);
      await prisma.kgProposalItem.updateMany({ where: { proposalId: p.id }, data: { decision: 'accept' } });
      const { proposal } = await services.commits.commit(f.caller as never, p.id);
      expect(proposal.status).toBe('committed');
    }

    // The linked proposal added edges to the existing Topic; the new one created a Topic and its edges.
    expect(await graphCounts(f.ownerId)).toMatchObject({ topics: 2, discussed: 2 + 3 });
    expect(await orphans(prisma, f.ownerId)).toEqual([]);
    const licensingEdges = await prisma.kgRelation.count({ where: { ownerId: f.ownerId, type: 'DISCUSSED', toId: f.topic } });
    expect(licensingEdges).toBe(2);

    // Run again: the committed concepts are known by edge and learned alias; Budget review is still pending.
    await run(f.ownerId);
    const remaining = await drafts(f.ownerId);
    expect(remaining.map((p) => (p.stats as { topic: string }).topic.toLowerCase())).toEqual(['budget review']);
    expect(await prisma.kgProposal.count({ where: { ownerId: f.ownerId, kind: 'import' } })).toBe(3);
  });
});
