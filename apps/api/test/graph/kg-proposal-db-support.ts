// =============================================================================
// Shared real-Postgres fixture for the proposal commit / revert specs (#366)
// =============================================================================
//
// Builds the real services (no Nest container) over one PrismaClient, and
// seeds one owner with: a transcript + note to cite, an existing graph (a
// Person, an old employer with an OPEN `WORKS_FOR` edge, a claim, an open
// commitment), and a draft extraction proposal covering every commit branch:
// a linked entity, two new entities (one the Meeting), a new relation, a new
// commitment, a `known` claim, a `same` commitment with a due-date change, a
// closing of the old edge, and a still-pending row.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import type { RequestUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { NoteAccessService } from '../../src/notes/access/note-access.service';
import { NoteOriginService } from '../../src/notes/note-origin.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { GraphAccessService } from '../../src/graph/access/graph-access.service';
import { GraphOntologyService } from '../../src/graph/ontology/graph-ontology.service';
import { GraphPreferencesService } from '../../src/graph/preferences/graph-preferences.service';
import { ProposalCommitService } from '../../src/graph/proposals/proposal-commit.service';
import { ProposalRevertService } from '../../src/graph/proposals/proposal-revert.service';
import { ProposalsService } from '../../src/graph/proposals/proposals.service';
import { SpanValidator } from '../../src/graph/proposals/span-validator';
import { KgPurgeService } from '../../src/graph/purge/kg-purge.service';
import { AliasLearningService } from '../../src/graph/resolution/alias-learning.service';
import { DistinctPairService } from '../../src/graph/resolution/distinct-pair.service';
import { MergeService } from '../../src/graph/resolution/merge.service';
import { EvidenceValidator } from '../../src/graph/write/evidence-validator.service';
import { GraphWriteService } from '../../src/graph/write/graph-write.service';
import { normalizeAlias, statementHash } from '../../src/graph/write/normalize';

export const V = 'test';

export const NOTE_BODY =
  '# Kickoff\n\nSarah Chen joined Northwind Robotics in March 2026.\n\n' +
  'Sarah will send the deck by March 10.\n\nThe pilot budget was cut.\n\n' +
  'Sarah will send the proposal, now by March 13.\n\nThe Pilot project starts soon.';

export function buildServices(prisma: PrismaClient) {
  const db = prisma as unknown as PrismaService;
  const write = new GraphWriteService(new EvidenceValidator());
  const access = new GraphAccessService(db);
  const ontology = new GraphOntologyService(db, new GraphPreferencesService(db));
  const spans = new SpanValidator(new NoteOriginService(db));
  const proposals = new ProposalsService(db, access, new NoteAccessService(db), ontology, spans);
  const merges = new MergeService(
    db,
    write,
    { enqueue: jest.fn() } as never,
    { get: () => undefined } as never,
    { enqueueFollowUps: jest.fn(async () => undefined) } as never,
  );
  const commits = new ProposalCommitService(
    db,
    access,
    ontology,
    write,
    new AliasLearningService(write),
    new DistinctPairService(),
    merges,
    { enqueue: jest.fn() } as never,
    { get: () => undefined } as never,
    { get: async () => ({}) } as never,
    proposals,
  );
  const reverts = new ProposalRevertService(db, access, merges, commits, proposals);
  return { db, write, proposals, commits, reverts, purge: new KgPurgeService(db) };
}

export async function cleanup(prisma: PrismaClient, prefix: string, purge: KgPurgeService): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { startsWith: prefix } }, select: { id: true } });
  for (const { id } of users) {
    await prisma.kgMerge.deleteMany({ where: { ownerId: id } });
    await prisma.kgDistinctPair.deleteMany({ where: { ownerId: id } });
    await purge.purgeAll(id);
    await prisma.auditEvent.deleteMany({ where: { actorUserId: id } });
  }
  const owner = { owner: { email: { startsWith: prefix } } };
  await prisma.noteVersion.deleteMany({ where: { note: owner } });
  await prisma.note.deleteMany({ where: owner });
  await prisma.transcriptSegment.deleteMany({ where: { transcript: owner } });
  await prisma.transcriptSpeaker.deleteMany({ where: { transcript: owner } });
  await prisma.transcript.deleteMany({ where: owner });
  await prisma.storageObject.deleteMany({ where: { uploadedBy: { email: { startsWith: prefix } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
}

/** A note-span citation of `quote` in `NOTE_BODY`. */
export function noteCite(noteId: string, quote: string) {
  const charStart = NOTE_BODY.indexOf(quote);
  if (charStart < 0) throw new Error(`fixture quote not in the note: ${quote}`);
  return { noteId, noteVersion: 1, charStart, charEnd: charStart + quote.length, quote };
}

export async function seedFixture(prisma: PrismaClient, prefix: string) {
  const user = await prisma.user.create({
    data: { email: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
  });
  const ownerId = user.id;
  const caller: RequestUser = { id: ownerId, email: user.email, roles: [], permissions: ['graph:read', 'graph:write'], isActive: true };

  const source = await prisma.storageObject.create({
    data: { name: 'r.m4a', size: BigInt(1), mimeType: 'audio/mp4', storageKey: `${prefix}/${randomUUID()}`, managedBy: 'transcripts', uploadedById: ownerId },
  });
  const transcript = await prisma.transcript.create({
    data: { ownerId, title: 'Kickoff call', sourceObjectId: source.id, provider: 'assemblyai' },
  });
  const speaker = await prisma.transcriptSpeaker.create({
    data: { transcriptId: transcript.id, label: 'A', displayName: 'Sarah Chen', colorIndex: 0 },
  });
  const segment = await prisma.transcriptSegment.create({
    data: { transcriptId: transcript.id, speakerId: speaker.id, startMs: 0, endMs: 4000, ordinal: 1000, text: "Hi, I'm Sarah Chen, now at Northwind Robotics.", words: [] },
  });
  const note = await prisma.note.create({
    data: { ownerId, title: 'Kickoff', body: NOTE_BODY, status: 'ready', sourceType: 'transcript', sourceTranscriptId: transcript.id, currentVersion: 1 },
  });
  await prisma.noteVersion.create({ data: { noteId: note.id, version: 1, kind: 'ai_generated', body: NOTE_BODY } });

  // --- the existing graph ------------------------------------------------------
  const sarah = randomUUID();
  const oldco = randomUUID();
  const oldEdge = randomUUID();
  const claim = randomUUID();
  const commitment = randomUUID();
  const claimText = 'The pilot budget was cut.';
  const commitmentText = 'Sarah will send the proposal';
  await prisma.$transaction(async (tx) => {
    for (const [id, type, label] of [[sarah, 'Person', 'Sarah Chen'], [oldco, 'Organization', 'OldCo']] as const) {
      await tx.kgEntity.create({ data: { id, ownerId, type, label, ontologyVersion: V } });
      await tx.kgEntityAlias.create({ data: { entityId: id, ownerId, alias: label, normalized: normalizeAlias(label), source: 'extraction' } });
      await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'entity', subjectId: id, quote: `${label} was mentioned` } });
    }
    await tx.kgRelation.create({ data: { id: oldEdge, ownerId, type: 'WORKS_FOR', fromId: sarah, toId: oldco, ontologyVersion: V } });
    await tx.$executeRaw`UPDATE kg_relations SET valid = '[2019-01-01T00:00:00.000Z,)'::tstzrange, valid_precision = 'year' WHERE id = ${oldEdge}::uuid`;
    await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'relation', subjectId: oldEdge, quote: 'Sarah has worked at OldCo since 2019' } });
    await tx.kgItem.create({
      data: { id: claim, ownerId, kind: 'claim', subjectId: sarah, statement: claimText, status: 'active', statementHash: statementHash('claim', claimText), ontologyVersion: V },
    });
    await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'item', subjectId: claim, quote: claimText } });
    await tx.kgItem.create({
      data: {
        id: commitment, ownerId, kind: 'commitment', ownerPersonId: sarah, title: 'Send proposal', statement: commitmentText,
        status: 'open', dueAt: new Date('2026-03-06T00:00:00.000Z'), statementHash: statementHash('commitment', commitmentText), ontologyVersion: V,
      },
    });
    await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'item', subjectId: commitment, quote: commitmentText } });
  });

  // --- the draft proposal ------------------------------------------------------
  const proposal = await prisma.kgProposal.create({
    data: { ownerId, kind: 'extraction', status: 'draft', noteId: note.id, noteVersion: 1, model: 'gpt-4o', provider: 'openai', stats: { phase: 'ready' } },
  });
  const temporalNone = { validFrom: null, validTo: null, precision: 'unknown' };
  const rows: Array<{ key: string; kind: 'entity' | 'relation' | 'item' | 'closing'; decision: 'accept' | 'pending'; payload: Record<string, unknown>; resolution?: unknown; quote: string }> = [
    {
      key: 'e1', kind: 'entity', decision: 'accept', quote: 'Sarah Chen joined Northwind Robotics in March 2026.',
      payload: { ref: 'e1', type: 'Person', label: 'S. Chen', aliases: [], props: {}, occurredAt: null },
      resolution: { ref: sarah, score: 0.97, source: 'alias', candidates: [{ entityId: sarah, label: 'Sarah Chen', type: 'Person', score: 0.97, signals: ['alias'] }], adjudication: null },
    },
    {
      key: 'e2', kind: 'entity', decision: 'accept', quote: 'Sarah Chen joined Northwind Robotics in March 2026.',
      payload: { ref: 'e2', type: 'Organization', label: 'Northwind Robotics', aliases: [], props: {}, occurredAt: null },
      resolution: { ref: null, score: null, source: null, candidates: [], adjudication: null },
    },
    {
      key: 'meeting', kind: 'entity', decision: 'accept', quote: '# Kickoff',
      payload: { ref: 'meeting', type: 'Meeting', label: 'Kickoff', aliases: [], props: {}, occurredAt: '2026-03-04' },
    },
    {
      key: 'e3', kind: 'entity', decision: 'pending', quote: 'The Pilot project starts soon.',
      payload: { ref: 'e3', type: 'Project', label: 'Pilot', aliases: [], props: {}, occurredAt: null },
    },
    {
      key: 'r1', kind: 'relation', decision: 'accept', quote: 'Sarah Chen joined Northwind Robotics in March 2026.',
      payload: { ref: 'r1', type: 'WORKS_FOR', from: { ref: 'e1' }, to: { ref: 'e2' }, props: {}, validFrom: '2026-03-01', validTo: null, precision: 'month' },
    },
    {
      key: 'i1', kind: 'item', decision: 'accept', quote: 'Sarah will send the deck by March 10.',
      payload: {
        ref: 'i1', kind: 'commitment', title: 'Send the deck', statement: 'Sarah will send the deck by March 10.', subject: null,
        owner: { ref: 'e1' }, counterparty: null, meeting: { ref: 'meeting' }, status: 'open', occurredAt: null, dueAt: '2026-03-10',
        sensitivity: null, statementHash: 'x', props: {}, ...temporalNone,
      },
    },
    {
      key: 'i2', kind: 'item', decision: 'accept', quote: claimText,
      payload: {
        ref: 'i2', kind: 'claim', title: 'Budget cut', statement: claimText, subject: { ref: 'e1' }, owner: null, counterparty: null,
        meeting: null, status: null, occurredAt: null, dueAt: null, sensitivity: null, statementHash: 'x', props: {}, ...temporalNone,
        dedup: { verdict: 'known', targetItemId: claim, changes: {}, rationale: null, score: null },
      },
    },
    {
      key: 'i3', kind: 'item', decision: 'accept', quote: 'Sarah will send the proposal, now by March 13.',
      payload: {
        ref: 'i3', kind: 'commitment', title: 'Send proposal', statement: commitmentText, subject: null, owner: { ref: 'e1' },
        counterparty: null, meeting: { ref: 'meeting' }, status: 'open', occurredAt: null, dueAt: '2026-03-13', sensitivity: null,
        statementHash: 'x', props: {}, ...temporalNone,
        dedup: { verdict: 'same', targetItemId: commitment, changes: { dueAt: '2026-03-13' }, rationale: null, score: 0.95 },
      },
    },
    {
      key: 'c1', kind: 'closing', decision: 'accept', quote: 'Sarah Chen joined Northwind Robotics in March 2026.',
      payload: {
        relationId: oldEdge, relationType: 'WORKS_FOR', fromLabel: 'Sarah Chen', toLabel: 'OldCo', roleTitle: null,
        previousValid: { from: '2019-01-01', to: null, precision: 'year' }, closeAt: '2026-03-01', precision: 'month',
        closedByRef: 'r1', affectedCommitments: [],
      },
    },
  ];
  const itemIds: Record<string, string> = {};
  for (const [i, row] of rows.entries()) {
    const created = await prisma.kgProposalItem.create({
      data: {
        proposalId: proposal.id,
        kind: row.kind,
        payload: row.payload as never,
        resolution: (row.resolution ?? undefined) as never,
        decision: row.decision,
        sortOrder: i,
        flags: row.key === 'i2' ? ['known'] : [],
      },
    });
    itemIds[row.key] = created.id;
    await prisma.kgEvidence.create({
      data: { ownerId, subjectKind: 'proposal_item', subjectId: created.id, ...noteCite(note.id, row.quote) },
    });
  }

  return { user, caller, ownerId, transcript, segment, note, proposal, itemIds, existing: { sarah, oldco, oldEdge, claim, commitment } };
}

export type Fixture = Awaited<ReturnType<typeof seedFixture>>;

/** Every live (accepted/edited) graph row of the owner that has no evidence. */
export async function orphans(prisma: PrismaClient, ownerId: string): Promise<Array<{ kind: string; id: string }>> {
  return prisma.$queryRaw<Array<{ kind: string; id: string }>>`
    SELECT 'entity' AS kind, e.id::text AS id FROM kg_entities e
     WHERE e.owner_id = ${ownerId}::uuid AND e.review_status IN ('accepted','edited')
       AND NOT EXISTS (SELECT 1 FROM kg_evidence v WHERE v.subject_kind = 'entity' AND v.subject_id = e.id)
    UNION ALL
    SELECT 'relation', r.id::text FROM kg_relations r
     WHERE r.owner_id = ${ownerId}::uuid AND r.review_status IN ('accepted','edited')
       AND NOT EXISTS (SELECT 1 FROM kg_evidence v WHERE v.subject_kind = 'relation' AND v.subject_id = r.id)
    UNION ALL
    SELECT 'item', i.id::text FROM kg_items i
     WHERE i.owner_id = ${ownerId}::uuid AND i.review_status IN ('accepted','edited')
       AND NOT EXISTS (SELECT 1 FROM kg_evidence v WHERE v.subject_kind = 'item' AND v.subject_id = i.id)`;
}

/** A comparable picture of the owner's graph (ids, key fields, the old edge's range). */
export async function snapshot(prisma: PrismaClient, ownerId: string) {
  const [entities, relations, items, evidence, aliases, mentions, pairs] = await Promise.all([
    prisma.kgEntity.findMany({ where: { ownerId }, select: { id: true, label: true, reviewStatus: true }, orderBy: { id: 'asc' } }),
    prisma.$queryRaw`SELECT id::text, valid::text, valid_precision::text, superseded_by_id::text, review_status::text FROM kg_relations WHERE owner_id = ${ownerId}::uuid ORDER BY id`,
    prisma.kgItem.findMany({ where: { ownerId }, select: { id: true, status: true, dueAt: true, reviewStatus: true, supersededById: true }, orderBy: { id: 'asc' } }),
    prisma.kgEvidence.findMany({ where: { ownerId, subjectKind: { not: 'proposal_item' } }, select: { id: true }, orderBy: { id: 'asc' } }),
    prisma.kgEntityAlias.findMany({ where: { ownerId }, select: { id: true }, orderBy: { id: 'asc' } }),
    prisma.kgMention.findMany({ where: { ownerId }, select: { id: true }, orderBy: { id: 'asc' } }),
    prisma.kgDistinctPair.findMany({ where: { ownerId }, select: { aId: true, bId: true }, orderBy: { aId: 'asc' } }),
  ]);
  return { entities, relations, items, evidence, aliases, mentions, pairs };
}
