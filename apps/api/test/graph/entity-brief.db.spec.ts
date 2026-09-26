// =============================================================================
// Real-Postgres test: the entity brief (#372, epic #347)
// =============================================================================
//
// `tstzrange` bounds, the closing rule's superseded edges, generated tsvector
// columns behind the search arm, the jobs dedup index and `kg_entity_views`
// are only real against Postgres. Excluded from `npm test`; run by
// `npm run test:db` (CI's Smoke job).
//
// What it proves:
//   - the full response for a seeded Person (promotion, manager change, open
//     commitments both directions, a sensitive fact that never appears);
//   - every evidence id the brief returns is the caller's own
//     (`GraphEvidenceService.getMany` resolves all of them);
//   - "since I last looked": the second visit's window starts at the first
//     visit's recorded time, and a promotion committed in between shows as one
//     `ended` + one `started` HAS_ROLE;
//   - `as_of=2024-01-15` reads the REPORTS_TO state of that date, returns no
//     digest, never enqueues and never moves `last_viewed_at`;
//   - the related sources include a transcript that mentions the label but has
//     no graph evidence (`inGraph: false`) — the non-graph leg (§9.4);
//   - a stale digest enqueues exactly ONE `kg.entity_digest` across concurrent
//     GETs; no key → `ai_key_missing` and no job; a failure < 15 min → no job.
// =============================================================================

import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { GraphAccessService } from '../../src/graph/access/graph-access.service';
import { EntityBriefService } from '../../src/graph/brief/entity-brief.service';
import { EntityDigestEnqueuer } from '../../src/graph/brief/entity-digest.enqueuer';
import { EntityViewService } from '../../src/graph/brief/entity-view.service';
import type { EntityBriefResponse } from '../../src/graph/brief/dto/entity-brief.dto';
import { entityBriefResponseSchema } from '../../src/graph/brief/dto/entity-brief.dto';
import { KG_ENTITY_DIGEST_JOB_TYPE } from '../../src/graph/job-types';
import { GraphOntologyService } from '../../src/graph/ontology/graph-ontology.service';
import { GraphEvidenceService } from '../../src/graph/read/graph-evidence.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import { NoteAccessService } from '../../src/notes/access/note-access.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { SearchService } from '../../src/search/search.service';
import { TranscriptAccessService } from '../../src/transcripts/transcript-access.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from './graph-read.fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('entity-brief.db.spec');

const EMAIL_PREFIX = 'entity-brief-test';
const PERMISSIONS = ['graph:read', 'transcripts:read', 'notes:read'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeWithDb('EntityBriefService (real Postgres)', () => {
  let prisma: PrismaClient;
  let briefs: EntityBriefService;
  let evidence: GraphEvidenceService;
  const resolver = { resolve: jest.fn() };

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    const access = new GraphAccessService(p);
    const transcriptAccess = new TranscriptAccessService(p);
    evidence = new GraphEvidenceService(p, access, transcriptAccess, new NoteAccessService(p));

    const registry = new JobHandlerRegistry();
    // A stand-in handler: the brief only needs the type to be registered.
    registry.register({ type: KG_ENTITY_DIGEST_JOB_TYPE, process: async () => undefined } as never);
    const enqueuer = new EntityDigestEnqueuer(new JobsService(p), registry, { get: async () => ({ graphEnabled: true }) } as never);
    // The semantic arm is off (no key); the full-text arm runs for real.
    const search = new SearchService(p, { resolve: async () => ({ ok: false, reason: 'ai_key_missing' }) } as never);

    briefs = new EntityBriefService(
      p,
      access,
      new GraphOntologyService(p),
      new EntityViewService(p),
      search,
      resolver as never,
      enqueuer,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    resolver.resolve.mockReset();
    resolver.resolve.mockResolvedValue({ model: 'model-x' });
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await prisma.$executeRaw`
      DELETE FROM jobs WHERE type = ${KG_ENTITY_DIGEST_JOB_TYPE} AND subject_id IN (
        SELECT e.id::text FROM kg_entities e JOIN users u ON u.id = e.owner_id WHERE u.email LIKE ${`${EMAIL_PREFIX}%`})`;
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function owner(suffix = 'a') {
    const user = await createUser(prisma, EMAIL_PREFIX, suffix);
    return { user, reader: { id: user.id, permissions: PERMISSIONS } as never, g: new GraphFixture(prisma, user.id) };
  }

  /** Every evidence id anywhere in a brief. */
  function allEvidenceIds(b: EntityBriefResponse): string[] {
    const s = b.sections;
    return [
      ...[...s.whatChanged, ...s.decisions, ...s.openCommitments.theirs, ...s.openCommitments.yours, ...s.risksClaims].flatMap(
        (e) => e.evidenceIds,
      ),
      ...s.peopleChanges.flatMap((c) => c.evidenceIds),
      ...(b.digest?.statements.flatMap((st) => st.evidenceIds) ?? []),
    ];
  }

  /**
   * Sarah at Acme: §5.4's manager change (Jane until 2026-03-01, then Will),
   * a role, commitments in both directions, a decision, a claim and a
   * sensitive fact.
   */
  async function seedSarah(g: GraphFixture) {
    const acme = await g.entity('Organization', 'Acme');
    const sarah = await g.entity('Person', 'Sarah Chen');
    const jane = await g.entity('Person', 'Jane');
    const will = await g.entity('Person', 'Will');
    const bob = await g.entity('Person', 'Bob');
    await g.relation('WORKS_FOR', sarah, acme, { valid: '[2019-01-01,)', precision: 'year' });
    await g.relation('REPORTS_TO', sarah, jane, { valid: '[2020-01-01,2026-03-01)', precision: 'month', reviewStatus: 'superseded' });
    await g.relation('REPORTS_TO', sarah, will, { valid: '[2026-03-01,)', precision: 'month' });
    const role = await g.relation('HAS_ROLE', sarah, acme, { valid: '[2019-01-01,)', precision: 'year' });
    await prisma.$executeRaw`UPDATE kg_relations SET props = '{"title":"Engineer"}'::jsonb WHERE id = ${role}::uuid`;

    const recent = new Date(Date.now() - 5 * 86_400_000);
    const theirs = await g.item('commitment', { ownerPersonId: sarah, counterpartyId: bob, statement: 'Sarah will send the deck', occurredAt: recent });
    const yours = await g.item('commitment', { ownerPersonId: bob, counterpartyId: sarah, statement: 'Bob will review the plan', occurredAt: recent });
    const decision = await g.item('decision', { subjectId: sarah, statement: 'Sarah leads the migration', occurredAt: recent });
    const claim = await g.item('claim', { subjectId: sarah, statement: 'Sarah thinks the date slips', occurredAt: recent });
    const sensitive = await g.item('person_fact', {
      subjectId: sarah,
      statement: 'SENSITIVE-HEALTH-DETAIL',
      sensitivity: 'sensitive',
      occurredAt: recent,
    });
    return { acme, sarah, jane, will, bob, role, theirs, yours, decision, claim, sensitive };
  }

  const get = (reader: never, id: string, opts: Partial<Parameters<EntityBriefService['getBrief']>[2]> = {}) =>
    briefs.getBrief(reader, id, { markViewed: true, enqueueStaleDigest: true, ...opts });

  it('assembles the full cited brief and never includes a sensitive fact', async () => {
    const { user, reader, g } = await owner();
    const s = await seedSarah(g);

    const brief = await get(reader, s.sarah, { enqueueStaleDigest: false });
    expect(entityBriefResponseSchema.safeParse(brief).success).toBe(true);
    expect(brief.entity).toEqual({ id: s.sarah, label: 'Sarah Chen', type: 'Person' });
    expect(brief.window.sinceSource).toBe('default');

    const ids = (list: { itemId: string }[]) => list.map((e) => e.itemId).sort();
    expect(ids(brief.sections.whatChanged)).toEqual([s.theirs, s.yours, s.decision, s.claim].sort());
    expect(ids(brief.sections.decisions)).toEqual([s.decision]);
    expect(ids(brief.sections.openCommitments.theirs)).toEqual([s.theirs]);
    expect(ids(brief.sections.openCommitments.yours)).toEqual([s.yours]);
    expect(ids(brief.sections.risksClaims)).toEqual([s.claim]);
    expect(brief.sections.openCommitments.theirs[0].counterparty).toEqual({ id: s.bob, label: 'Bob', type: 'Person' });
    // The manager change is years ago: outside the default 30-day window.
    expect(brief.sections.peopleChanges).toEqual([]);

    const serialized = JSON.stringify(brief);
    expect(serialized).not.toContain(s.sensitive);
    expect(serialized).not.toContain('SENSITIVE-HEALTH-DETAIL');

    // Something to summarize and no digest yet: stale, but the Ask tool path enqueues nothing.
    expect(brief).toMatchObject({ digest: null, digestStale: true, digestPending: false });
    expect(await prisma.job.count({ where: { type: KG_ENTITY_DIGEST_JOB_TYPE, subjectId: s.sarah } })).toBe(0);

    // Every evidence id is the caller's own.
    const cited = [...new Set(allEvidenceIds(brief))];
    expect(cited.length).toBeGreaterThan(0);
    const links = await evidence.getMany(user.id, cited);
    expect(links.map((l) => l.id).sort()).toEqual(cited.sort());
  });

  it('shows the stored digest, keeping only statements cited by the caller’s own evidence', async () => {
    const { user, reader, g } = await owner();
    const s = await seedSarah(g);
    const stranger = await owner('b');
    const theirEntity = await stranger.g.entity('Person', 'Other');
    const foreignEv = await prisma.kgEvidence.findFirstOrThrow({ where: { subjectId: theirEntity } });
    const ownEv = await prisma.kgEvidence.findFirstOrThrow({ where: { subjectId: s.decision } });
    await prisma.kgEntityDigest.create({
      data: {
        entityId: s.sarah,
        ownerId: user.id,
        summary: 'Sarah leads the migration\nLeaked',
        citations: {
          version: 1,
          statements: [
            { text: 'Sarah leads the migration', evidenceIds: [ownEv.id] },
            { text: 'Leaked', evidenceIds: [foreignEv.id] },
          ],
          dropped: 0,
        },
        coversUntil: new Date(),
        model: 'model-x',
        generatedAt: new Date(Date.now() + 60_000),
      },
    });

    const brief = await get(reader, s.sarah);
    expect(brief.digest?.statements).toEqual([{ text: 'Sarah leads the migration', evidenceIds: [ownEv.id] }]);
    expect(brief.digest?.model).toBe('model-x');
    expect(brief.digestStale).toBe(false);
    expect(resolver.resolve).not.toHaveBeenCalled();
    const cited = [...new Set(allEvidenceIds(brief))];
    expect((await evidence.getMany(user.id, cited)).length).toBe(cited.length);
  });

  it('starts the second visit where the first one left off, and shows a promotion in between', async () => {
    const { user, reader, g } = await owner();
    const s = await seedSarah(g);

    const first = await get(reader, s.acme, { enqueueStaleDigest: false });
    expect(first.window.sinceSource).toBe('default');
    const view = await prisma.kgEntityView.findUniqueOrThrow({
      where: { userId_entityId: { userId: user.id, entityId: s.acme } },
    });

    // The promotion: the closing rule closes the Engineer role and opens Staff Engineer.
    await sleep(10);
    const at = new Date();
    await prisma.$executeRaw`UPDATE kg_relations SET valid = tstzrange(lower(valid), ${at}::timestamptz, '[)'),
      review_status = 'superseded' WHERE id = ${s.role}::uuid`;
    const promoted = await g.relation('HAS_ROLE', s.sarah, s.acme, { valid: `[${at.toISOString()},)`, precision: 'day' });
    await prisma.$executeRaw`UPDATE kg_relations SET props = '{"title":"Staff Engineer"}'::jsonb WHERE id = ${promoted}::uuid`;
    await sleep(10);

    const second = await get(reader, s.acme, { enqueueStaleDigest: false });
    expect(second.window).toMatchObject({
      since: view.lastViewedAt.toISOString(),
      sinceSource: 'last_viewed',
      lastViewedAt: view.lastViewedAt.toISOString(),
    });
    const hasRole = second.sections.peopleChanges.filter((c) => c.type === 'HAS_ROLE');
    expect(hasRole.map((c) => [c.change, c.title, c.relationId])).toEqual([
      ['ended', 'Engineer', s.role],
      ['started', 'Staff Engineer', promoted],
    ]);
    expect(hasRole[0].person.id).toBe(s.sarah);
    expect(hasRole[0].other.id).toBe(s.acme);

    // For an Organization, "theirs" is what its current workers owe.
    expect(second.sections.openCommitments.theirs.map((e) => e.itemId)).toEqual([s.theirs]);

    const moved = await prisma.kgEntityView.findUniqueOrThrow({
      where: { userId_entityId: { userId: user.id, entityId: s.acme } },
    });
    expect(moved.lastViewedAt.getTime()).toBeGreaterThan(view.lastViewedAt.getTime());
  });

  it('as_of=2024-01-15 reads that date’s REPORTS_TO state, with no digest, no job and no view', async () => {
    const { user, reader, g } = await owner();
    const s = await seedSarah(g);

    const brief = await get(reader, s.sarah, { asOf: '2024-01-15', since: '2019-06-01' });
    expect(brief.window.asOf).toBe('2024-01-15T00:00:00.000Z');
    expect(brief).toMatchObject({ digest: null, digestStale: false, digestPending: false, digestUnavailable: null });
    const reports = brief.sections.peopleChanges.filter((c) => c.type === 'REPORTS_TO');
    // Jane from 2020; neither Jane's end nor Will's start (2026) had happened yet.
    expect(reports.map((c) => [c.change, c.other.label, c.at])).toEqual([['started', 'Jane', '2020-01-01T00:00:00.000Z']]);
    // Items stated after as_of are not known yet.
    expect(brief.sections.whatChanged).toEqual([]);

    expect(await prisma.kgEntityView.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.job.count({ where: { type: KG_ENTITY_DIGEST_JOB_TYPE, subjectId: s.sarah } })).toBe(0);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('fuses a text-only transcript (inGraph: false) with the documents the graph cites', async () => {
    const { reader, g } = await owner();
    const acme = await g.entity('Organization', 'Acme');
    // Mentions "Acme" in its segment, and nothing in the graph cites it.
    const textOnly = await g.transcript({ title: 'Weekly sync' });
    // Cited by the graph, and does not mention the label at all.
    const cited = await g.transcript({ title: 'Board meeting' });
    await prisma.transcriptSegment.updateMany({ where: { transcriptId: cited.transcript.id }, data: { text: 'Unrelated words' } });
    const decision = await g.item('decision', { subjectId: acme, statement: 'Go with the blue plan', occurredAt: new Date() });
    await g.evidence('item', decision, { transcriptId: cited.transcript.id, segmentId: cited.segment.id });

    const brief = await get(reader, acme, { enqueueStaleDigest: false });
    const byId = new Map(brief.related.map((r) => [r.id, r]));
    expect(byId.get(textOnly.transcript.id)).toMatchObject({ kind: 'transcript', inGraph: false, title: 'Weekly sync' });
    expect(byId.get(textOnly.transcript.id)?.snippetHtml).toContain('<mark>');
    expect(byId.get(cited.transcript.id)).toMatchObject({ kind: 'transcript', inGraph: true, title: 'Board meeting', snippetHtml: null });
  });

  it('enqueues exactly one digest job across concurrent stale GETs', async () => {
    const { reader, g } = await owner();
    const s = await seedSarah(g);
    const results = await Promise.all([get(reader, s.sarah), get(reader, s.sarah), get(reader, s.sarah)]);
    for (const r of results) expect(r).toMatchObject({ digestStale: true, digestPending: true, digestUnavailable: null });
    const jobs = await prisma.job.findMany({ where: { type: KG_ENTITY_DIGEST_JOB_TYPE, subjectId: s.sarah } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ subjectType: 'kg_entity', reason: 'backfill', status: 'pending' });
    expect(jobs[0].payload).toEqual({ entityId: s.sarah, ownerId: expect.any(String) });
  });

  it('reports a missing key and enqueues nothing', async () => {
    const { reader, g } = await owner();
    const s = await seedSarah(g);
    resolver.resolve.mockRejectedValue(new ConflictException({ message: 'no key', details: { reason: 'ai_key_missing' } }));
    const brief = await get(reader, s.sarah);
    expect(brief).toMatchObject({ digestStale: true, digestPending: false, digestUnavailable: 'ai_key_missing' });
    expect(await prisma.job.count({ where: { type: KG_ENTITY_DIGEST_JOB_TYPE, subjectId: s.sarah } })).toBe(0);
  });

  it('does not re-enqueue within 15 minutes of a failed digest job', async () => {
    const { reader, g } = await owner();
    const s = await seedSarah(g);
    await prisma.job.create({
      data: {
        type: KG_ENTITY_DIGEST_JOB_TYPE,
        reason: 'backfill',
        subjectType: 'kg_entity',
        subjectId: s.sarah,
        status: 'failed',
        finishedAt: new Date(Date.now() - 60_000),
        payload: { entityId: s.sarah },
      },
    });
    const brief = await get(reader, s.sarah);
    expect(brief).toMatchObject({ digestStale: true, digestPending: false, digestUnavailable: null });
    expect(await prisma.job.count({ where: { type: KG_ENTITY_DIGEST_JOB_TYPE, subjectId: s.sarah } })).toBe(1);
  });
});
