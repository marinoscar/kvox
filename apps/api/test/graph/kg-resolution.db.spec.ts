// =============================================================================
// Real-Postgres test: entity resolution and reversible merges (issue #364)
// =============================================================================
//
// What only a real database can show: `pg_trgm` catching a misspelling, the
// HNSW kNN arm ordering fixed vectors, the exact-alias arm, a distinct pair
// never coming back, and a merge → reverse round trip that restores every
// touched row exactly — including collapsed duplicates, self-loops, item
// duplicates the live-statement index would otherwise refuse, and the deferred
// no-orphans trigger accepting every intermediate state at COMMIT.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { KgPurgeService } from '../../src/graph/purge/kg-purge.service';
import { GRAPH_PREFERENCE_DEFAULTS } from '../../src/graph/preferences/graph-preferences.defaults';
import { CandidateService } from '../../src/graph/resolution/candidate.service';
import { ContextFeatureService, emptyContext } from '../../src/graph/resolution/context-features.service';
import { DistinctPairService } from '../../src/graph/resolution/distinct-pair.service';
import { MergeService } from '../../src/graph/resolution/merge.service';
import { ResolutionService } from '../../src/graph/resolution/resolution.service';
import { EvidenceValidator } from '../../src/graph/write/evidence-validator.service';
import { GraphWriteService } from '../../src/graph/write/graph-write.service';
import { normalizeAlias } from '../../src/graph/write/normalize';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-resolution.db.spec');
const EMAIL_PREFIX = 'kg-resolution-test';
const V = 'test';
const MODEL = 'test-embedding-model';

type Tx = Prisma.TransactionClient;

/** A 1536-wide unit-ish vector pointing mostly along `axis`. */
function vec(axis: number, tilt = 0): number[] {
  const v = Array(1536).fill(0);
  v[axis] = 1;
  v[(axis + 1) % 1536] = tilt;
  return v;
}

describeWithDb('entity resolution (real Postgres)', () => {
  let prisma: PrismaClient;
  let db: PrismaService;
  let candidates: CandidateService;
  let resolution: ResolutionService;
  let merges: MergeService;
  let distinct: DistinctPairService;
  let purge: KgPurgeService;
  const followUps = { enqueueFollowUps: jest.fn(async () => undefined) };

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...env } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(env)) });
    await prisma.$connect();
    db = prisma as unknown as PrismaService;
    candidates = new CandidateService(db);
    const noEmbedder = { resolve: async () => ({ ok: false, reason: 'ai_key_missing' }) };
    resolution = new ResolutionService(
      db,
      candidates,
      new ContextFeatureService(db),
      noEmbedder as never,
      { adjudicate: jest.fn(), buildCandidateDossiers: jest.fn() } as never,
      { registerProviderKey: jest.fn() } as never,
    );
    merges = new MergeService(
      db,
      new GraphWriteService(new EvidenceValidator()),
      { enqueue: jest.fn() } as never,
      { get: () => undefined } as never,
      followUps as never,
    );
    distinct = new DistinctPairService();
    purge = new KgPurgeService(db);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
    for (const { id } of users) {
      await prisma.kgMerge.deleteMany({ where: { ownerId: id } });
      await prisma.kgDistinctPair.deleteMany({ where: { ownerId: id } });
      await purge.purgeAll(id);
      await prisma.auditEvent.deleteMany({ where: { actorUserId: id } });
    }
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
    await prisma.noteVersion.deleteMany({ where: { note: owner } });
    await prisma.note.deleteMany({ where: owner });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async function createUser() {
    return prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
  }

  function cite(tx: Tx, ownerId: string, subjectKind: 'entity' | 'relation' | 'item', subjectId: string, quote = 'cited') {
    return tx.kgEvidence.create({ data: { ownerId, subjectKind, subjectId, quote } });
  }

  async function entity(ownerId: string, type: string, label: string, aliases: string[] = [], id = randomUUID()) {
    await prisma.$transaction(async (tx) => {
      await tx.kgEntity.create({ data: { id, ownerId, type, label, ontologyVersion: V } });
      await tx.kgEntityAlias.createMany({
        data: [label, ...aliases].map((a) => ({
          entityId: id,
          ownerId,
          alias: a,
          normalized: normalizeAlias(a),
          source: 'extraction' as const,
        })),
        skipDuplicates: true,
      });
      await cite(tx, ownerId, 'entity', id, `${label} was mentioned`);
    });
    return id;
  }

  async function relation(ownerId: string, type: string, fromId: string, toId: string, id = randomUUID()) {
    await prisma.$transaction(async (tx) => {
      await tx.kgRelation.create({ data: { id, ownerId, type, fromId, toId, ontologyVersion: V } });
      await cite(tx, ownerId, 'relation', id);
    });
    return id;
  }

  async function setVector(id: string, v: number[]) {
    await prisma.$executeRaw`UPDATE kg_entities SET embedding = ${`[${v.join(',')}]`}::vector, embedding_model = ${MODEL}, embedding_hash = 'h' WHERE id = ${id}::uuid`;
  }

  // ---------------------------------------------------------------------------
  // Candidate arms
  // ---------------------------------------------------------------------------

  it('finds the exact-alias, trigram and vector arms, same type, live only', async () => {
    const user = await createUser();
    const sarah = await entity(user.id, 'Person', 'Sarah Chen', ['S. Chen']);
    const org = await entity(user.id, 'Organization', 'Sarah Chen Consulting');
    const tom = await entity(user.id, 'Person', 'Tom Hale');
    const gone = await entity(user.id, 'Person', 'Sarah Chen');
    await prisma.kgEntity.update({ where: { id: gone }, data: { reviewStatus: 'rejected' } });

    // Alias exact (normalized with #355's normalizer).
    const exact = await candidates.forMention(user.id, { type: 'Person', label: 's. chen', aliases: [] });
    expect(exact.map((c) => [c.entityId, c.aliasExact])).toEqual([[sarah, true]]);

    // A misspelling: pg_trgm, never the exact arm; the organization is another type.
    const fuzzy = await candidates.forMention(user.id, { type: 'Person', label: 'Sara Chen', aliases: [] });
    expect(fuzzy.map((c) => c.entityId)).toEqual([sarah]);
    expect(fuzzy[0].aliasExact).toBe(false);
    expect(fuzzy[0].trigram).toBeGreaterThanOrEqual(0.4);
    expect(fuzzy.some((c) => c.entityId === org)).toBe(false);

    // HNSW kNN with fixed vectors: nearest first, same model only.
    await setVector(sarah, vec(1, 0.1));
    await setVector(tom, vec(7));
    const near = await candidates.forMention(user.id, {
      type: 'Person',
      label: 'Zed',
      aliases: [],
      vector: { values: vec(1), model: MODEL },
    });
    const bySim = [...near].sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0));
    expect(bySim[0].entityId).toBe(sarah);
    expect(bySim[0].cosine).toBeGreaterThan(0.99);
    const otherModel = await candidates.forMention(user.id, {
      type: 'Person',
      label: 'Zed',
      aliases: [],
      vector: { values: vec(1), model: 'another-model' },
    });
    expect(otherModel).toEqual([]);
  });

  it('never proposes a confirmed distinct pair again', async () => {
    const user = await createUser();
    const a = await entity(user.id, 'Person', 'Sarah Chen');
    const b = await entity(user.id, 'Person', 'Sarah Chen', ['Sarah C.']);
    const before = await candidates.forMention(user.id, { type: 'Person', label: 'Sarah Chen', aliases: [], excludeIds: [a] });
    expect(before.map((c) => c.entityId)).toEqual([b]);

    const recorded = await prisma.$transaction((tx) => distinct.record(tx, user.id, b, a));
    expect(recorded.created).toBe(true);
    expect(recorded.aId < recorded.bId).toBe(true);
    expect((await prisma.$transaction((tx) => distinct.record(tx, user.id, a, b))).created).toBe(false);

    const after = await candidates.forMention(user.id, { type: 'Person', label: 'Sarah Chen', aliases: [], excludeIds: [a] });
    expect(after).toEqual([]);
  });

  it('resolves "Sarah Chen" in a second meeting — exact alias, same organization — above 0.90', async () => {
    const user = await createUser();
    const sarah = await entity(user.id, 'Person', 'Sarah Chen');
    const northwind = await entity(user.id, 'Organization', 'Northwind Robotics');
    await relation(user.id, 'WORKS_FOR', sarah, northwind);

    const outcomes = await resolution.rankMentions(
      user.id,
      [
        {
          key: 'm',
          type: 'Person',
          label: 'Sarah Chen',
          aliases: [],
          context: { ...emptyContext(), orgNames: new Set(['northwind robotics']) },
        },
      ],
      GRAPH_PREFERENCE_DEFAULTS.resolution,
    );
    const top = outcomes.get('m')!.candidates[0];
    expect(top.entityId).toBe(sarah);
    expect(top.score).toBeGreaterThanOrEqual(0.9);
    expect(top.signals).toEqual(expect.arrayContaining(['alias_exact', 'org_co_mention', 'recent']));
    expect(outcomes.get('m')!.band).toBe('link');
  });

  // ---------------------------------------------------------------------------
  // Merge → reverse
  // ---------------------------------------------------------------------------

  async function snapshot(ownerId: string) {
    const strip = <T extends Record<string, unknown>>(rows: T[]) =>
      rows.map(({ updatedAt: _u, ...rest }) => rest).sort((x, y) => String(x.id).localeCompare(String(y.id)));
    return {
      entities: strip(await prisma.kgEntity.findMany({ where: { ownerId }, select: { id: true, label: true, props: true, reviewStatus: true, mergedIntoId: true, updatedAt: true } })),
      aliases: strip(await prisma.kgEntityAlias.findMany({ where: { ownerId }, select: { id: true, entityId: true, normalized: true } })),
      relations: strip(await prisma.kgRelation.findMany({ where: { ownerId }, select: { id: true, fromId: true, toId: true, reviewStatus: true, updatedAt: true } })),
      items: strip(await prisma.kgItem.findMany({ where: { ownerId }, select: { id: true, subjectId: true, ownerPersonId: true, counterpartyId: true, meetingId: true, reviewStatus: true, updatedAt: true } })),
      evidence: strip(await prisma.kgEvidence.findMany({ where: { ownerId }, select: { id: true, subjectKind: true, subjectId: true } })),
      mentions: strip(await prisma.kgMention.findMany({ where: { ownerId }, select: { id: true, entityId: true } })),
      pairs: (await prisma.kgDistinctPair.findMany({ where: { ownerId }, select: { aId: true, bId: true } })).sort((x, y) => (x.aId + x.bId).localeCompare(y.aId + y.bId)),
    };
  }

  async function mergeFixture() {
    const user = await createUser();
    const note = await prisma.note.create({ data: { ownerId: user.id, title: 'M', body: 'b', status: 'ready', sourceType: 'document' } });
    const s = await entity(user.id, 'Person', 'Sarah Chen', ['Sarah']);
    const m = await entity(user.id, 'Person', 'S. Chen', ['Sarah']); // 'sarah' collides and stays behind
    const org = await entity(user.id, 'Organization', 'Northwind');
    const x = await entity(user.id, 'Person', 'Tom Hale');
    const meeting = await entity(user.id, 'Meeting', 'Weekly');
    const ids = {
      sWorks: await relation(user.id, 'WORKS_FOR', s, org),
      mWorks: await relation(user.id, 'WORKS_FOR', m, org), // duplicate after the merge → collapsed
      loop: await relation(user.id, 'REPORTS_TO', m, s), // self-loop after the merge
      xReports: await relation(user.id, 'REPORTS_TO', x, m), // to_id re-pointed
      mAttended: await relation(user.id, 'ATTENDED', m, meeting),
    };
    const items = { sClaim: randomUUID(), mClaim: randomUUID(), mOwn: randomUUID() };
    await prisma.$transaction(async (tx) => {
      await tx.kgItem.createMany({
        data: [
          { id: items.sClaim, ownerId: user.id, kind: 'claim', subjectId: s, statement: 'Is CTO', status: 'open', statementHash: 'same', ontologyVersion: V },
          { id: items.mClaim, ownerId: user.id, kind: 'claim', subjectId: m, statement: 'Is CTO', status: 'open', statementHash: 'same', ontologyVersion: V },
          { id: items.mOwn, ownerId: user.id, kind: 'commitment', ownerPersonId: m, counterpartyId: x, meetingId: meeting, statement: 'Send deck', status: 'open', statementHash: 'c1', ontologyVersion: V },
        ],
      });
      for (const id of Object.values(items)) await cite(tx, user.id, 'item', id);
    });
    await prisma.kgMention.create({ data: { ownerId: user.id, entityId: m, noteId: note.id } });
    await prisma.$transaction((tx) => distinct.record(tx, user.id, m, x));
    await prisma.$transaction((tx) => distinct.record(tx, user.id, m, s));
    return { user, s, m, org, x, meeting, ids, items };
  }

  it('merges, then reverses row for row across every touched table', async () => {
    const f = await mergeFixture();
    const before = await snapshot(f.user.id);

    const merged = await merges.merge({ ownerId: f.user.id, mergedId: f.m, survivorId: f.s, actorId: f.user.id, source: 'manual' });
    expect(merged.merge).toMatchObject({ survivorId: f.s, mergedId: f.m });

    const mid = await snapshot(f.user.id);
    const ent = (id: string) => mid.entities.find((e) => e.id === id)!;
    const rel = (id: string) => mid.relations.find((r) => r.id === id)!;
    expect(ent(f.m)).toMatchObject({ reviewStatus: 'merged', mergedIntoId: f.s });
    expect(rel(f.ids.mWorks)).toMatchObject({ fromId: f.s, reviewStatus: 'merged' }); // collapsed
    expect(rel(f.ids.loop)).toMatchObject({ fromId: f.s, toId: f.s, reviewStatus: 'merged' }); // self-loop
    expect(rel(f.ids.xReports)).toMatchObject({ toId: f.s, reviewStatus: 'accepted' });
    expect(rel(f.ids.mAttended)).toMatchObject({ fromId: f.s, reviewStatus: 'accepted' });
    expect(mid.items.find((i) => i.id === f.items.mClaim)).toMatchObject({ subjectId: f.s, reviewStatus: 'merged' });
    expect(mid.items.find((i) => i.id === f.items.mOwn)).toMatchObject({ ownerPersonId: f.s });
    expect(mid.mentions.every((x) => x.entityId === f.s)).toBe(true);
    expect(mid.evidence.filter((e) => e.subjectKind === 'entity' && e.subjectId === f.m)).toHaveLength(0);
    // The collapsed duplicate's evidence moved onto the kept relation.
    expect(mid.evidence.filter((e) => e.subjectId === f.ids.sWorks)).toHaveLength(2);
    // Aliases: 's chen' moved, 'sarah' stayed on the tombstone (the survivor has it), label added.
    expect(mid.aliases.filter((a) => a.entityId === f.s).map((a) => a.normalized).sort()).toEqual(
      [normalizeAlias('S. Chen'), 'sarah', 'sarah chen'].sort(),
    );
    // Distinct pairs: (m, x) → (s, x); (m, s) dropped.
    const [pa, pb] = [f.s, f.x].sort();
    expect(mid.pairs).toEqual([{ aId: pa, bId: pb }]);

    const reversed = await merges.reverse({ ownerId: f.user.id, mergeId: merged.merge.id, actorId: f.user.id });
    expect(reversed.skipped).toEqual([]);
    expect(reversed.restored).toMatchObject({ id: f.m, type: 'Person', label: 'S. Chen' });
    expect(await snapshot(f.user.id)).toEqual(before);

    await expect(merges.reverse({ ownerId: f.user.id, mergeId: merged.merge.id, actorId: f.user.id })).rejects.toMatchObject({ status: 404 });
  });

  it('reports rows deleted since instead of failing the reverse', async () => {
    const f = await mergeFixture();
    const merged = await merges.merge({ ownerId: f.user.id, mergedId: f.m, survivorId: f.s, actorId: f.user.id, source: 'manual' });
    await prisma.kgMention.deleteMany({ where: { ownerId: f.user.id } });
    const reversed = await merges.reverse({ ownerId: f.user.id, mergeId: merged.merge.id, actorId: f.user.id });
    expect(reversed.skipped).toEqual([expect.objectContaining({ kind: 'mention', why: 'deleted_since' })]);
  });

  it('refuses to reverse once the survivor was itself merged (409 revert_conflict)', async () => {
    const f = await mergeFixture();
    const first = await merges.merge({ ownerId: f.user.id, mergedId: f.m, survivorId: f.s, actorId: f.user.id, source: 'manual' });
    const third = await entity(f.user.id, 'Person', 'Sarah Chen-Li');
    await merges.merge({ ownerId: f.user.id, mergedId: f.s, survivorId: third, actorId: f.user.id, source: 'manual' });

    await expect(merges.reverse({ ownerId: f.user.id, mergeId: first.merge.id, actorId: f.user.id })).rejects.toMatchObject({
      status: 409,
      response: { details: { reason: 'revert_conflict', conflicts: [{ entity: 'survivor', id: f.s, mergedInto: third }] } },
    });
  });

  it('refuses a merge across types with 400 type_mismatch', async () => {
    const user = await createUser();
    const p = await entity(user.id, 'Person', 'Acme');
    const o = await entity(user.id, 'Organization', 'Acme');
    await expect(merges.merge({ ownerId: user.id, mergedId: p, survivorId: o, actorId: user.id, source: 'manual' })).rejects.toMatchObject({
      status: 400,
      response: { details: { reason: 'type_mismatch' } },
    });
  });
});
