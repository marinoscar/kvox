// =============================================================================
// Real-Postgres test: work-item dedup, temporal closing and rejection memory
// (issue #365)
// =============================================================================
//
// What only a real database can show: `tstzrange` edges read back through
// `valid::text` and planned by #353's engine (a promotion → one "Closes: …"
// row that is never pre-checked; a 2020 fact inside an accepted `[2019, 2026)`
// edge → `known`), pgvector cosine between a proposed item's vector and a
// committed item's (the pilot moving to Q2 → `supersedes`), the statement-hash
// lookup, the company-change commitments, and rejection memory reading
// committed — never discarded — proposals.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { computeEffectiveSchema } from '@app/shared/ontology';

import { buildDatabaseUrl } from '../../src/common/database-url';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { applyPrecheck, type PrecheckItem } from '../../src/graph/extraction/precheck';
import { ProposalStageRegistry, type ProposalStageContext } from '../../src/graph/extraction/proposal-stage';
import { ItemCandidateService } from '../../src/graph/dedup/item-candidates.service';
import { RejectionMemoryStage } from '../../src/graph/dedup/rejection-memory.stage';
import { TemporalClosingStage } from '../../src/graph/dedup/temporal-closing.stage';
import { WorkItemDedupStage } from '../../src/graph/dedup/work-item-dedup.stage';
import { GRAPH_PREFERENCE_DEFAULTS } from '../../src/graph/preferences/graph-preferences.defaults';
import type { ProposalResolution } from '../../src/graph/proposals/proposal-payload.schema';
import { KgPurgeService } from '../../src/graph/purge/kg-purge.service';
import { statementHash } from '../../src/graph/write/normalize';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-dedup.db.spec');
const EMAIL_PREFIX = 'kg-dedup-test';
const V = 'test';
const MODEL = 'test-embedding-model';
const SCHEMA = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });

type Tx = Prisma.TransactionClient;

function vec(axis: number, tilt = 0): number[] {
  const v = Array(1536).fill(0);
  v[axis] = 1;
  v[(axis + 1) % 1536] = tilt;
  return v;
}

describeWithDb('work-item dedup and temporal closing (real Postgres)', () => {
  let prisma: PrismaClient;
  let db: PrismaService;
  let purge: KgPurgeService;
  let dedup: WorkItemDedupStage;
  let closing: TemporalClosingStage;
  let memory: RejectionMemoryStage;
  const embedMentions = jest.fn();
  const adjudicateItems = jest.fn();

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...env } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(env)) });
    await prisma.$connect();
    db = prisma as unknown as PrismaService;
    purge = new KgPurgeService(db);
    const registry = new ProposalStageRegistry();
    const ontology = { effectiveSchemaFor: async () => SCHEMA };
    const candidates = new ItemCandidateService(db);
    dedup = new WorkItemDedupStage(registry, ontology as never, candidates, { embedMentions } as never, { adjudicateItems } as never);
    closing = new TemporalClosingStage(registry, ontology as never, candidates);
    memory = new RejectionMemoryStage(registry);
  });

  beforeEach(() => {
    embedMentions.mockReset().mockImplementation(async (_u: string, texts: string[]) => ({
      vectors: texts.map(() => null),
      vectorArm: 'skipped:ai_key_missing',
    }));
    adjudicateItems.mockReset().mockResolvedValue(new Map());
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
    for (const { id } of users) {
      await purge.purgeAll(id);
      await prisma.kgEvidence.deleteMany({ where: { ownerId: id } });
      await prisma.kgProposal.deleteMany({ where: { ownerId: id } });
    }
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
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

  async function createNote(ownerId: string) {
    return prisma.note.create({ data: { ownerId, title: 'Meeting', body: 'b', status: 'ready', sourceType: 'document' } });
  }

  function cite(tx: Tx, ownerId: string, subjectKind: 'entity' | 'relation' | 'item' | 'proposal_item', subjectId: string, quote = 'cited') {
    return tx.kgEvidence.create({ data: { ownerId, subjectKind, subjectId, quote } });
  }

  async function entity(ownerId: string, type: string, label: string) {
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.kgEntity.create({ data: { id, ownerId, type, label, ontologyVersion: V } });
      await cite(tx, ownerId, 'entity', id);
    });
    return id;
  }

  async function relation(ownerId: string, type: string, fromId: string, toId: string, valid: string, precision: string, props = {}) {
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.kgRelation.create({ data: { id, ownerId, type, fromId, toId, props, ontologyVersion: V } });
      await tx.$executeRaw`UPDATE kg_relations SET valid = ${valid}::tstzrange, valid_precision = ${precision}::kg_valid_precision WHERE id = ${id}::uuid`;
      await cite(tx, ownerId, 'relation', id);
    });
    return id;
  }

  async function item(
    ownerId: string,
    data: { kind: 'claim' | 'commitment' | 'decision' | 'person_fact'; subjectId: string; statement: string; status?: string; ownerPersonId?: string },
  ) {
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.kgItem.create({
        data: {
          id,
          ownerId,
          kind: data.kind,
          subjectId: data.subjectId,
          ownerPersonId: data.ownerPersonId ?? null,
          title: data.statement.slice(0, 40),
          statement: data.statement,
          status: data.status ?? 'active',
          statementHash: statementHash(data.kind, data.statement),
          sensitivity: data.kind === 'person_fact' ? 'personal' : null,
          ontologyVersion: V,
        },
      });
      await cite(tx, ownerId, 'item', id);
    });
    return id;
  }

  async function proposal(ownerId: string, noteId: string, status: 'extracting' | 'committed' | 'discarded' = 'extracting') {
    return prisma.kgProposal.create({ data: { ownerId, kind: 'extraction', status, noteId, noteVersion: 1 } });
  }

  let order = 0;
  async function row(
    proposalId: string,
    ownerId: string,
    kind: 'entity' | 'relation' | 'item',
    payload: Record<string, unknown>,
    extra: { resolution?: ProposalResolution; decision?: 'pending' | 'reject' | 'accept'; quote?: string } = {},
  ) {
    const created = await prisma.kgProposalItem.create({
      data: {
        proposalId,
        kind,
        payload: payload as Prisma.InputJsonValue,
        resolution: (extra.resolution ?? undefined) as Prisma.InputJsonValue | undefined,
        decision: extra.decision ?? 'pending',
        sortOrder: order++,
      },
    });
    if (extra.quote) await prisma.$transaction((tx) => cite(tx, ownerId, 'proposal_item', created.id, extra.quote));
    return created;
  }

  const linked = (id: string | null): ProposalResolution => ({
    ref: id,
    score: id ? 1 : null,
    source: id ? 'alias' : null,
    candidates: [],
    adjudication: null,
  });

  const entityPayload = (ref: string, type: string, label: string) => ({ ref, type, label, aliases: [], props: {}, occurredAt: null });

  const relPayload = (over: Record<string, unknown>) => ({
    ref: 'r1',
    type: 'WORKS_FOR',
    from: { ref: 'e1' },
    to: { ref: 'e2' },
    props: {},
    validFrom: null,
    validTo: null,
    precision: 'unknown',
    ...over,
  });

  const itemPayload = (over: Record<string, unknown> & { kind: string; statement: string }) => ({
    ref: 'i1',
    title: over.statement.slice(0, 40),
    subject: { ref: 'e2' },
    owner: null,
    counterparty: null,
    meeting: null,
    status: null,
    occurredAt: null,
    dueAt: null,
    sensitivity: null,
    statementHash: statementHash(over.kind as never, over.statement),
    props: {},
    validFrom: null,
    validTo: null,
    precision: 'unknown',
    ...over,
  });

  function ctx(proposalId: string, userId: string, noteId: string): ProposalStageContext {
    return { proposalId, userId, noteId, preferences: GRAPH_PREFERENCE_DEFAULTS, ai: null, prisma: db, stats: {} };
  }

  async function runAll(c: ProposalStageContext) {
    for (const stage of [dedup, closing, memory]) {
      const stats: Record<string, unknown> = {};
      await stage.run({ ...c, stats });
      c.stats[stage.name] = stats;
    }
  }

  async function rows(proposalId: string) {
    return prisma.kgProposalItem.findMany({ where: { proposalId }, orderBy: { sortOrder: 'asc' } });
  }

  function precheck(items: Awaited<ReturnType<typeof rows>>) {
    const list: PrecheckItem[] = items.map((i) => ({
      kind: i.kind,
      payload: i.payload as Record<string, unknown>,
      resolution: i.resolution as ProposalResolution | null,
      flags: i.flags,
      decision: i.decision,
    }));
    applyPrecheck(list, GRAPH_PREFERENCE_DEFAULTS);
    return list.map((l) => l.decision);
  }

  // ---------------------------------------------------------------------------

  it('a promotion yields exactly one "Closes: …" row with the copy fields, never pre-checked', async () => {
    const user = await createUser();
    const note = await createNote(user.id);
    const joe = await entity(user.id, 'Person', 'Joe');
    const acme = await entity(user.id, 'Organization', 'Acme');
    const engineer = await relation(user.id, 'HAS_ROLE', joe, acme, '[2019-01-01,)', 'year', { title: 'Engineer' });

    const p = await proposal(user.id, note.id);
    await row(p.id, user.id, 'entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(joe) });
    await row(p.id, user.id, 'entity', entityPayload('e2', 'Organization', 'Acme'), { resolution: linked(acme) });
    await row(p.id, user.id, 'relation', relPayload({ type: 'HAS_ROLE', props: { title: 'Staff Engineer' }, validFrom: '2026-03-01', precision: 'month' }), {
      quote: 'Joe was promoted to Staff Engineer this month',
    });

    const c = ctx(p.id, user.id, note.id);
    await runAll(c);
    const items = await rows(p.id);
    const closings = items.filter((i) => i.kind === 'closing');
    expect(closings).toHaveLength(1);
    expect(closings[0].payload).toEqual({
      relationId: engineer,
      relationType: 'HAS_ROLE',
      fromLabel: 'Joe',
      toLabel: 'Acme',
      roleTitle: 'Engineer',
      previousValid: { from: '2019-01-01', to: null, precision: 'year' },
      closeAt: '2026-03-01',
      precision: 'month',
      closedByRef: 'r1',
      affectedCommitments: [],
    });
    expect(closings[0].origin).toBe('ai');
    const copied = await prisma.kgEvidence.findMany({ where: { subjectKind: 'proposal_item', subjectId: closings[0].id } });
    expect(copied.map((e) => e.quote)).toEqual(['Joe was promoted to Staff Engineer this month']);
    // Pre-check: the new edge is accepted, the closing never is.
    const decisions = precheck(items);
    expect(decisions[items.findIndex((i) => i.kind === 'relation')]).toBe('accept');
    expect(decisions[items.findIndex((i) => i.kind === 'closing')]).toBe('pending');
    expect(c.stats['temporal-closing']).toMatchObject({ closings: 1 });

    // The engine never touched the graph: the old edge is still open.
    const [still] = await prisma.$queryRaw<Array<{ upper_inf: boolean }>>`SELECT upper_inf(valid) FROM kg_relations WHERE id = ${engineer}::uuid`;
    expect(still.upper_inf).toBe(true);
  });

  it('a 2020 fact inside an accepted [2019, 2026) WORKS_FOR is known, never a closing', async () => {
    const user = await createUser();
    const note = await createNote(user.id);
    const joe = await entity(user.id, 'Person', 'Joe');
    const acme = await entity(user.id, 'Organization', 'Acme');
    const works = await relation(user.id, 'WORKS_FOR', joe, acme, '[2019-01-01,2026-01-01)', 'year');

    const p = await proposal(user.id, note.id);
    await row(p.id, user.id, 'entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(joe) });
    await row(p.id, user.id, 'entity', entityPayload('e2', 'Organization', 'Acme'), { resolution: linked(acme) });
    await row(p.id, user.id, 'relation', relPayload({ validFrom: '2020-01-01', precision: 'year' }));

    await runAll(ctx(p.id, user.id, note.id));
    const items = await rows(p.id);
    const rel = items.find((i) => i.kind === 'relation')!;
    expect(rel.payload).toMatchObject({ dedup: { verdict: 'known', targetRelationId: works } });
    expect(rel.flags).toEqual(['known']);
    expect(items.some((i) => i.kind === 'closing')).toBe(false);
    expect(precheck(items)[items.indexOf(rel)]).toBe('accept');
  });

  it('an overlapping new WORKS_FOR is flagged overlaps and still proposed', async () => {
    const user = await createUser();
    const note = await createNote(user.id);
    const joe = await entity(user.id, 'Person', 'Joe');
    const acme = await entity(user.id, 'Organization', 'Acme');
    const globex = await entity(user.id, 'Organization', 'Globex');
    await relation(user.id, 'WORKS_FOR', joe, acme, '[2019-01-01,2024-01-01)', 'year');

    const p = await proposal(user.id, note.id);
    await row(p.id, user.id, 'entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(joe) });
    await row(p.id, user.id, 'entity', entityPayload('e2', 'Organization', 'Globex'), { resolution: linked(globex) });
    await row(p.id, user.id, 'relation', relPayload({ validFrom: '2023-01-01', validTo: '2025-01-01', precision: 'year' }));
    await runAll(ctx(p.id, user.id, note.id));
    const rel = (await rows(p.id)).find((i) => i.kind === 'relation')!;
    expect(rel.flags).toEqual(['overlaps']);
    expect(rel.payload).toMatchObject({ dedup: { verdict: 'new' } });
  });

  it('a company change closes WORKS_FOR and lists the person’s open commitments', async () => {
    const user = await createUser();
    const note = await createNote(user.id);
    const joe = await entity(user.id, 'Person', 'Joe');
    const acme = await entity(user.id, 'Organization', 'Acme');
    const globex = await entity(user.id, 'Organization', 'Globex');
    const project = await entity(user.id, 'Project', 'Vendor migration');
    const works = await relation(user.id, 'WORKS_FOR', joe, acme, '[2019-01-01,)', 'year');
    const open = await item(user.id, { kind: 'commitment', subjectId: project, statement: 'Joe finishes the vendor migration.', status: 'open', ownerPersonId: joe });
    await item(user.id, { kind: 'commitment', subjectId: project, statement: 'Joe files the old report.', status: 'done', ownerPersonId: joe });

    const p = await proposal(user.id, note.id);
    await row(p.id, user.id, 'entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(joe) });
    await row(p.id, user.id, 'entity', entityPayload('e2', 'Organization', 'Globex'), { resolution: linked(globex) });
    await row(p.id, user.id, 'relation', relPayload({ validFrom: '2026-03-01', precision: 'month' }));
    await runAll(ctx(p.id, user.id, note.id));

    const [c] = (await rows(p.id)).filter((i) => i.kind === 'closing');
    expect(c.flags).toEqual(['closing_affects_commitments']);
    expect(c.payload).toMatchObject({
      relationId: works,
      relationType: 'WORKS_FOR',
      toLabel: 'Acme',
      roleTitle: null,
      closeAt: '2026-03-01',
      affectedCommitments: [{ itemId: open, title: 'Joe finishes the vendor migration.', role: 'owner' }],
    });
  });

  it('"the pilot moved to Q2" after "the pilot is in Q1" → supersedes, by real pgvector cosine', async () => {
    const user = await createUser();
    const note = await createNote(user.id);
    const pilot = await entity(user.id, 'Project', 'The Pilot');
    const q1 = await item(user.id, { kind: 'claim', subjectId: pilot, statement: 'The pilot is in Q1.' });
    const otherModel = await item(user.id, { kind: 'claim', subjectId: pilot, statement: 'The pilot has a budget.' });
    await prisma.$executeRaw`UPDATE kg_items SET embedding = ${`[${vec(1).join(',')}]`}::vector, embedding_model = ${MODEL} WHERE id = ${q1}::uuid`;
    await prisma.$executeRaw`UPDATE kg_items SET embedding = ${`[${vec(1).join(',')}]`}::vector, embedding_model = 'another-model' WHERE id = ${otherModel}::uuid`;

    embedMentions.mockImplementation(async (_u: string, texts: string[]) => ({
      vectors: texts.map(() => ({ values: vec(1, 0.3), model: MODEL })),
      vectorArm: 'ok',
    }));
    adjudicateItems.mockImplementation(async (_u: string, pairs: Array<{ pairId: string; existing: { statement: string } }>) =>
      new Map(pairs.map((pr) => [pr.pairId, { verdict: 'supersedes', changes: { status: null, dueAt: null }, rationale: 'moved', model: 'm' }])),
    );

    const p = await proposal(user.id, note.id);
    await row(p.id, user.id, 'entity', entityPayload('e2', 'Project', 'The Pilot'), { resolution: linked(pilot) });
    await row(p.id, user.id, 'item', itemPayload({ kind: 'claim', statement: 'The pilot moved to Q2.' }), { quote: 'we moved the pilot to Q2' });
    const c = ctx(p.id, user.id, note.id);
    await runAll(c);

    // Only the same-model vector was a candidate, and it was adjudicated with its quote.
    const pairs = adjudicateItems.mock.calls[0][1] as Array<{ existing: { statement: string }; proposed: { quotes: string[] } }>;
    expect(pairs.map((pr) => pr.existing.statement)).toEqual(['The pilot is in Q1.']);
    expect(pairs[0].proposed.quotes).toEqual(['we moved the pilot to Q2']);
    const claim = (await rows(p.id)).find((i) => i.kind === 'item')!;
    expect(claim.payload).toMatchObject({ dedup: { verdict: 'supersedes', targetItemId: q1 } });
    expect((claim.payload as { dedup: { score: number } }).dedup.score).toBeCloseTo(1 / Math.sqrt(1.09), 3);
    expect(claim.flags).toEqual(['supersedes']);
  });

  it('a restated identical fact is known by its statement hash, collapsed and pre-accepted', async () => {
    const user = await createUser();
    const note = await createNote(user.id);
    const sarah = await entity(user.id, 'Person', 'Sarah');
    const known = await item(user.id, { kind: 'claim', subjectId: sarah, statement: 'Sarah owns the vendor migration.' });

    const p = await proposal(user.id, note.id);
    await row(p.id, user.id, 'entity', entityPayload('e2', 'Person', 'Sarah'), { resolution: linked(sarah) });
    await row(p.id, user.id, 'item', itemPayload({ kind: 'claim', statement: 'Sarah owns the vendor  migration!' }));
    await runAll(ctx(p.id, user.id, note.id));
    const items = await rows(p.id);
    const claim = items.find((i) => i.kind === 'item')!;
    expect(claim.payload).toMatchObject({ dedup: { verdict: 'known', targetItemId: known } });
    expect(precheck(items)[items.indexOf(claim)]).toBe('accept');
    expect(adjudicateItems).not.toHaveBeenCalled();
  });

  it('rejection memory: a rejected PersonFact is never re-proposed; same-note rejects flag, discarded ones do not', async () => {
    const user = await createUser();
    const noteA = await createNote(user.id);
    const noteB = await createNote(user.id);
    const joe = await entity(user.id, 'Person', 'Joe');
    const acme = await entity(user.id, 'Organization', 'Acme');
    const fact = itemPayload({ ref: 'f1', kind: 'person_fact', statement: 'Joe is training for a marathon.', subject: { ref: 'e1' }, sensitivity: 'personal' });
    const claim = itemPayload({ ref: 'c1', kind: 'claim', statement: 'Joe runs the Acme account.', subject: { ref: 'e1' } });

    // Note A, committed: the person fact was rejected.
    const oldA = await proposal(user.id, noteA.id, 'committed');
    await row(oldA.id, user.id, 'entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(joe) });
    await row(oldA.id, user.id, 'item', fact, { decision: 'reject' });
    // Note B, committed: the claim was rejected.
    const oldB = await proposal(user.id, noteB.id, 'committed');
    await row(oldB.id, user.id, 'entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(joe) });
    await row(oldB.id, user.id, 'item', claim, { decision: 'reject' });
    // Note B, discarded: a WORKS_FOR was "rejected" — that "no" was never committed.
    const discarded = await proposal(user.id, noteB.id, 'discarded');
    await row(discarded.id, user.id, 'entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(joe) });
    await row(discarded.id, user.id, 'entity', entityPayload('e2', 'Organization', 'Acme'), { resolution: linked(acme) });
    await row(discarded.id, user.id, 'relation', relPayload({ type: 'ATTENDED' }), { decision: 'reject' });

    // Now note B is extracted again.
    const p = await proposal(user.id, noteB.id);
    await row(p.id, user.id, 'entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(joe) });
    await row(p.id, user.id, 'entity', entityPayload('e2', 'Organization', 'Acme'), { resolution: linked(acme) });
    await row(p.id, user.id, 'item', fact, { quote: 'Joe mentioned the marathon' });
    await row(p.id, user.id, 'item', claim);
    await row(p.id, user.id, 'relation', relPayload({ type: 'ATTENDED' }));
    const c = ctx(p.id, user.id, noteB.id);
    await runAll(c);

    const items = await rows(p.id);
    expect(items.some((i) => (i.payload as { ref: string }).ref === 'f1')).toBe(false);
    expect(await prisma.kgEvidence.count({ where: { ownerId: user.id, quote: 'Joe mentioned the marathon' } })).toBe(0);
    const c1 = items.find((i) => (i.payload as { ref: string }).ref === 'c1')!;
    expect(c1).toMatchObject({ flags: ['previously_rejected'], decision: 'reject' });
    const r1 = items.find((i) => i.kind === 'relation')!;
    expect(r1.flags).toEqual([]);
    expect(c.stats['rejection-memory']).toMatchObject({ suppressedPersonFacts: 1, previouslyRejected: 1 });
    expect(precheck(items)[items.indexOf(c1)]).toBe('reject');
  });
});
