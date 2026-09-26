// =============================================================================
// Real-Postgres test: the graph read layer's index, detail, timeline,
// mentions and evidence links (#370)
// =============================================================================
//
// Trigram similarity, `tstzrange` bounds, keyset cursors over microsecond
// timestamps and the owner-scoped SQL are only real against Postgres.
// Excluded from `npm test`; run by `npm run test:db` (CI's Smoke job).
//
// What it proves:
//   - the entity index: `updated` order + keyset cursor across pages,
//     `viewed` order, trigram search including an alias-only hit, the
//     `transcriptId` speaker filter (and its 404 without view access), unknown
//     type keys and cross-route cursors → 400;
//   - detail counts, and the identical 404 for another owner's entity, an
//     unreviewed/rejected one and a merge tombstone;
//   - the timeline: the union's ordering, `as_of`, the superseded flag, the
//     sensitive filter, and paging;
//   - mentions: one row per document, `available: false` after a revoked share;
//   - evidence: a playable segment link, a note-version link, and a revoked
//     transcript share yielding `available: false` with the quote intact.
// =============================================================================

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { NoteAccessService } from '../../src/notes/access/note-access.service';
import { GraphAccessService } from '../../src/graph/access/graph-access.service';
import { GraphOntologyService } from '../../src/graph/ontology/graph-ontology.service';
import { GraphEvidenceService } from '../../src/graph/read/graph-evidence.service';
import { GraphReadService } from '../../src/graph/read/graph-read.service';
import { encodeGraphCursor } from '../../src/graph/read/graph-cursor';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { TranscriptAccessService } from '../../src/transcripts/transcript-access.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from './graph-read.fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('graph-read.db.spec');

const EMAIL_PREFIX = 'graph-read-test';

describeWithDb('GraphReadService and GraphEvidenceService (real Postgres)', () => {
  let prisma: PrismaClient;
  let reads: GraphReadService;
  let evidence: GraphEvidenceService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    const access = new GraphAccessService(p);
    const transcriptAccess = new TranscriptAccessService(p);
    reads = new GraphReadService(p, access, new GraphOntologyService(p), transcriptAccess);
    evidence = new GraphEvidenceService(p, access, transcriptAccess, new NoteAccessService(p));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function owner(suffix = 'a') {
    const user = await createUser(prisma, EMAIL_PREFIX, suffix);
    return { user, g: new GraphFixture(prisma, user.id) };
  }

  const list = (userId: string, q: Record<string, unknown> = {}) =>
    reads.listEntities({ id: userId }, { sort: 'updated', limit: 25, ...q } as never);
  const timeline = (userId: string, id: string, q: Record<string, unknown> = {}) =>
    reads.timeline({ id: userId }, id, { includeSensitive: false, limit: 25, ...q } as never);

  // ---------------------------------------------------------------------------
  // The entity index
  // ---------------------------------------------------------------------------

  it('lists readable entities newest first and pages with a keyset cursor', async () => {
    const { user, g } = await owner();
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Microsecond-distinct timestamps: the cursor must round-trip exactly.
      made.push(await g.entity('Person', `Person ${i}`, { updatedAt: new Date(base + i * 1000) }));
    }
    const live = await g.entity('Organization', 'Acme', { updatedAt: new Date(base + 10_000) });
    await g.entity('Person', 'Draft', { reviewStatus: 'unreviewed' });
    await g.entity('Person', 'Nope', { reviewStatus: 'rejected' });
    await g.entity('Person', 'Old Acme', { reviewStatus: 'merged', mergedIntoId: live });

    const expected = [live, ...[...made].reverse()];
    const first = await list(user.id, { limit: 4 });
    expect(first.items.map((i) => i.id)).toEqual(expected.slice(0, 4));
    expect(first.nextCursor).not.toBeNull();
    const second = await list(user.id, { limit: 4, cursor: first.nextCursor });
    expect(second.items.map((i) => i.id)).toEqual(expected.slice(4));
    expect(second.nextCursor).toBeNull();

    const people = await list(user.id, { type: 'Person' });
    expect(people.items.map((i) => i.id)).toEqual([...made].reverse());

    await expect(list(user.id, { type: 'Person,Spaceship' })).rejects.toThrow(BadRequestException);
    await expect(list(user.id, { type: 'Commitment' })).rejects.toThrow(BadRequestException);
    await expect(
      list(user.id, { cursor: encodeGraphCursor('timeline', { k: '2026-01-01T00:00:00Z', id: live }) }),
    ).rejects.toThrow(BadRequestException);
    await expect(list(user.id, { cursor: 'garbage!!' })).rejects.toThrow(BadRequestException);
  });

  it('sorts by the caller’s own views', async () => {
    const { user, g } = await owner();
    const a = await g.entity('Person', 'Alpha');
    const b = await g.entity('Person', 'Beta');
    await g.entity('Person', 'Never viewed');
    await prisma.kgEntityView.create({ data: { userId: user.id, entityId: a, lastViewedAt: new Date('2026-09-01T00:00:00Z') } });
    await prisma.kgEntityView.create({ data: { userId: user.id, entityId: b, lastViewedAt: new Date('2026-09-02T00:00:00Z') } });

    const page = await list(user.id, { sort: 'viewed', limit: 1 });
    expect(page.items.map((i) => i.id)).toEqual([b]);
    const next = await list(user.id, { sort: 'viewed', limit: 1, cursor: page.nextCursor });
    expect(next.items.map((i) => i.id)).toEqual([a]);
    expect(next.nextCursor).toBeNull();
    // An `updated` cursor is not a `viewed` cursor.
    await expect(
      list(user.id, { sort: 'viewed', cursor: encodeGraphCursor('entities:updated', { k: '2026-01-01T00:00:00Z', id: a }) }),
    ).rejects.toThrow(BadRequestException);
  });

  it('searches labels and aliases by trigram similarity', async () => {
    const { user, g } = await owner();
    const sarah = await g.entity('Person', 'Sarah Chen', { aliases: ['S. Chen'] });
    const bob = await g.entity('Person', 'Robert Tables', { aliases: ['Bobby Tables'] });
    await g.entity('Organization', 'Acme Corporation');

    const byLabel = await list(user.id, { q: 'Sara Chen' });
    expect(byLabel.items[0].id).toBe(sarah);
    expect(byLabel.nextCursor).toBeNull();

    const byAlias = await list(user.id, { q: 'bobby' });
    expect(byAlias.items.map((i) => i.id)).toEqual([bob]);
    expect(byAlias.items[0].aliases).toEqual(['Bobby Tables']);

    const substring = await list(user.id, { q: 'Corp' });
    expect(substring.items.map((i) => i.label)).toEqual(['Acme Corporation']);
  });

  it('filters Persons identified as a speaker in a transcript', async () => {
    const { user, g } = await owner();
    const { user: stranger } = await owner('b');
    const { transcript, speakerA, speakerB } = await g.transcript();
    const sarah = await g.entity('Person', 'Sarah');
    const joe = await g.entity('Person', 'Joe');
    await g.entity('Person', 'Unrelated');
    // #356's storage shape: IDENTIFIED_AS from a transcript speaker.
    await g.relation('IDENTIFIED_AS', null, sarah, { fromSpeakerId: speakerA.id });
    await g.relation('IDENTIFIED_AS', null, joe, { fromSpeakerId: speakerB.id, reviewStatus: 'unreviewed' });

    const page = await list(user.id, { transcriptId: transcript.id });
    expect(page.items.map((i) => i.id)).toEqual([sarah]);
    expect(page.items[0].speakerIds).toEqual([speakerA.id]);

    await expect(list(stranger.id, { transcriptId: transcript.id })).rejects.toThrow(NotFoundException);
  });

  // ---------------------------------------------------------------------------
  // Detail
  // ---------------------------------------------------------------------------

  it('returns detail with counts, and the same 404 for every kind of not-yours', async () => {
    const { user, g } = await owner();
    const { user: other } = await owner('b');
    const { transcript } = await g.transcript();
    const note = await g.note();
    const meeting = await g.entity('Meeting', 'Kickoff', {
      occurredAt: new Date('2026-03-02T00:00:00Z'),
      props: { transcriptId: transcript.id },
    });
    await g.entity('Meeting', 'Retro', {
      occurredAt: new Date('2026-04-10T00:00:00Z'),
      props: { noteId: note.id },
    });
    const joe = await g.entity('Person', 'Joe', { aliases: ['Joseph'] });
    const acme = await g.entity('Organization', 'Acme');
    await g.evidence('entity', joe, { transcriptId: transcript.id, quote: 'Joe said' });
    await g.evidence('entity', joe, { noteId: note.id, noteVersion: 1, quote: 'Joe wrote' });
    await g.relation('WORKS_FOR', joe, acme, { valid: '[2019-01-01,)', precision: 'year' });
    await g.relation('WORKS_FOR', joe, acme, { valid: '[2010-01-01,2012-01-01)', precision: 'year' }); // not valid now
    await g.relation('ATTENDED', joe, meeting);
    await g.item('commitment', { ownerPersonId: joe, status: 'open' });
    await g.item('commitment', { counterpartyId: joe, status: 'done' });
    await g.item('decision', { subjectId: joe });
    await g.item('person_fact', { subjectId: joe, sensitivity: 'personal' });
    await g.item('person_fact', { subjectId: joe, sensitivity: 'sensitive' });
    await g.item('claim', { subjectId: joe, reviewStatus: 'unreviewed' });
    await prisma.kgMention.create({ data: { ownerId: user.id, entityId: joe, noteId: note.id } });
    await prisma.kgMention.create({ data: { ownerId: user.id, entityId: joe, transcriptId: transcript.id } });
    await prisma.kgMention.create({ data: { ownerId: user.id, entityId: joe, transcriptId: transcript.id, status: 'ignored' } });

    const detail = await reads.getEntity({ id: user.id }, joe);
    expect(detail).toMatchObject({
      id: joe,
      type: 'Person',
      label: 'Joe',
      reviewStatus: 'accepted',
      firstSeenAt: '2026-03-02T00:00:00.000Z',
      lastSeenAt: '2026-04-10T00:00:00.000Z',
      counts: {
        relations: 2,
        mentions: 2,
        evidence: 3,
        items: { commitment: 2, decision: 1, claim: 0, person_fact: 1 },
        openCommitments: 1,
      },
    });
    expect(detail.aliases.map((a) => a.alias)).toEqual(['Joe', 'Joseph']);

    const summary = (await list(user.id, { type: 'Person' })).items.find((i) => i.id === joe)!;
    expect(summary).toMatchObject({ mentionCount: 2, lastSeenAt: '2026-04-10T00:00:00.000Z', aliases: ['Joseph'] });

    const unreviewed = await g.entity('Person', 'Draft', { reviewStatus: 'unreviewed' });
    const rejected = await g.entity('Person', 'No', { reviewStatus: 'rejected' });
    const tombstone = await g.entity('Person', 'Joey', { reviewStatus: 'merged', mergedIntoId: joe });
    const messages = await Promise.all(
      [
        () => reads.getEntity({ id: other.id }, joe),
        () => reads.getEntity({ id: user.id }, unreviewed),
        () => reads.getEntity({ id: user.id }, rejected),
        () => reads.getEntity({ id: user.id }, tombstone),
        () => reads.getEntity({ id: user.id }, '00000000-0000-4000-8000-000000000000'),
        () => reads.mentions({ id: other.id }, joe, { limit: 25 } as never),
        () => timeline(other.id, joe),
      ].map((call) => call().then(() => null, (e: unknown) => e)),
    );
    for (const err of messages) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toEqual((messages[0] as NotFoundException).getResponse());
    }
  });

  // ---------------------------------------------------------------------------
  // Timeline
  // ---------------------------------------------------------------------------

  it('orders the timeline union, applies as_of, flags superseded, hides sensitive facts', async () => {
    const { user, g } = await owner();
    const joe = await g.entity('Person', 'Joe');
    const jane = await g.entity('Person', 'Jane');
    const will = await g.entity('Person', 'Will');
    const meeting = await g.entity('Meeting', 'Planning', { occurredAt: new Date('2025-06-01T00:00:00Z') });
    const toJane = await g.relation('REPORTS_TO', joe, jane, {
      valid: '[2020-01-01,2026-03-01)',
      precision: 'day',
      reviewStatus: 'superseded',
    });
    const toWill = await g.relation('REPORTS_TO', joe, will, { valid: '[2026-03-01,)', precision: 'day' });
    await g.relation('ATTENDED', joe, meeting);
    const newer = await g.item('decision', { subjectId: joe, occurredAt: new Date('2026-05-01T00:00:00Z'), statement: 'v2' });
    const older = await g.item('decision', {
      subjectId: joe,
      occurredAt: new Date('2025-01-01T00:00:00Z'),
      statement: 'v1',
      reviewStatus: 'superseded',
      supersededById: newer,
    });
    const undated = await g.item('claim', { subjectId: joe, statement: 'undated' });
    const sensitive = await g.item('person_fact', {
      subjectId: joe,
      sensitivity: 'sensitive',
      occurredAt: new Date('2024-01-01T00:00:00Z'),
    });
    const owed = await g.item('commitment', {
      ownerPersonId: will,
      counterpartyId: joe,
      occurredAt: new Date('2026-04-01T00:00:00Z'),
      dueAt: new Date('2026-04-15T00:00:00Z'),
    });

    const all = await timeline(user.id, joe, { as_of: '2026-09-01' });
    expect(all.asOf).toBe('2026-09-01T00:00:00.000Z');

    const order = all.items.map((e) => e.id);
    expect(order[0]).toBe(newer);
    expect(order[1]).toBe(owed);
    expect(new Set(order.slice(2, 4))).toEqual(new Set([`rel:${toWill}:start`, `rel:${toJane}:end`]));
    expect(order.slice(4)).toEqual([meeting, older, `rel:${toJane}:start`, undated]);
    expect(order).not.toContain(sensitive);

    const olderEvent = all.items.find((e) => e.id === older)!;
    expect(olderEvent.item).toMatchObject({ superseded: true, supersededById: newer, statement: 'v1' });
    expect(olderEvent.evidenceCount).toBe(1);
    expect(olderEvent.evidenceIds).toHaveLength(1);
    const owedEvent = all.items.find((e) => e.id === owed)!;
    expect(owedEvent.item).toMatchObject({
      ownerPerson: { id: will, label: 'Will', type: 'Person' },
      counterparty: { id: joe, label: 'Joe', type: 'Person' },
      dueAt: '2026-04-15T00:00:00.000Z',
    });
    const endEvent = all.items.find((e) => e.id === `rel:${toJane}:end`)!;
    expect(endEvent).toMatchObject({
      eventKind: 'relation_ended',
      at: '2026-03-01T00:00:00.000Z',
      precision: 'day',
      relation: { id: toJane, type: 'REPORTS_TO', direction: 'out', other: { id: jane, label: 'Jane' } },
    });
    expect(all.items.find((e) => e.id === meeting)).toMatchObject({ eventKind: 'meeting', meeting: { id: meeting, label: 'Planning' } });

    // as_of drops everything after it.
    const then = await timeline(user.id, joe, { as_of: '2025-03-01' });
    expect(then.items.map((e) => e.id)).toEqual([older, `rel:${toJane}:start`, undated]);

    // Sensitive facts only on request.
    const withSensitive = await timeline(user.id, joe, { as_of: '2026-09-01', includeSensitive: true });
    expect(withSensitive.items.map((e) => e.id)).toContain(sensitive);

    // kinds filter; unknown kind → 400.
    const onlyRelations = await timeline(user.id, joe, { as_of: '2026-09-01', kinds: 'relation' });
    expect(onlyRelations.items.every((e) => e.eventKind.startsWith('relation_'))).toBe(true);
    expect(onlyRelations.items).toHaveLength(3);
    await expect(timeline(user.id, joe, { kinds: 'relation,gossip' })).rejects.toThrow(BadRequestException);

    // Paging walks the same order, including across the NULLS LAST tail.
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await timeline(user.id, joe, { as_of: '2026-09-01', limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(order);
  });

  // ---------------------------------------------------------------------------
  // Mentions and evidence
  // ---------------------------------------------------------------------------

  it('lists mentions per document and resolves evidence links, honouring a revoked share', async () => {
    const { user: alice, g: aliceGraph } = await owner('alice');
    const { user: bob, g: bobGraph } = await owner('bob');
    // Alice's transcript, shared with Bob; Bob's own note.
    const { transcript, segment } = await aliceGraph.transcript({ recordedAt: new Date('2026-02-01T00:00:00Z'), title: 'Board call' });
    const share = await prisma.transcriptShare.create({
      data: { transcriptId: transcript.id, userId: bob.id, role: 'viewer', grantedById: alice.id },
    });
    const note = await bobGraph.note({ title: 'Prep', versions: 2 });

    const person = await bobGraph.entity('Person', 'Sarah');
    const fromSegment = await bobGraph.evidence('entity', person, {
      transcriptId: transcript.id,
      segmentId: segment.id,
      segmentRev: 1,
      startMs: 1500,
      endMs: 4000,
      quote: 'Sarah joined Acme',
    });
    const fromNote = await bobGraph.evidence('entity', person, {
      noteId: note.id,
      noteVersion: 1,
      charStart: 0,
      charEnd: 4,
      quote: 'Body',
    });
    await prisma.kgMention.create({ data: { ownerId: bob.id, entityId: person, transcriptId: transcript.id } });
    await prisma.kgMention.create({ data: { ownerId: bob.id, entityId: person, transcriptId: transcript.id } });
    await prisma.kgMention.create({ data: { ownerId: bob.id, entityId: person, noteId: note.id } });

    const mentions = await reads.mentions({ id: bob.id }, person, { limit: 25 } as never);
    expect(mentions.items).toEqual([
      { kind: 'note', id: note.id, title: 'Prep', occurredAt: expect.any(String), available: true },
      { kind: 'transcript', id: transcript.id, title: 'Board call', occurredAt: '2026-02-01T00:00:00.000Z', available: true },
    ]);

    const [segLink, noteLink] = (await evidence.getMany(bob.id, [fromSegment.id, fromNote.id, '00000000-0000-4000-8000-000000000000'])) as never as [
      { source: Record<string, unknown>; quote: string },
      { source: Record<string, unknown> },
    ];
    expect(segLink.source).toEqual({
      kind: 'segment',
      transcriptId: transcript.id,
      transcriptTitle: 'Board call',
      segmentId: segment.id,
      segmentRev: 1,
      currentSegmentRev: 1,
      startMs: 1500,
      endMs: 4000,
      textChanged: false,
      available: true,
      href: `/transcripts/${transcript.id}?segment=${segment.id}&t=1500`,
    });
    expect(noteLink.source).toMatchObject({
      kind: 'note',
      noteTitle: 'Prep',
      noteVersion: 1,
      currentNoteVersion: 2,
      versionChanged: true,
      available: true,
      href: `/notes/${note.id}?v=1`,
    });

    // The segment is corrected: the citation says its text has changed since.
    await prisma.transcriptSegment.update({ where: { id: segment.id }, data: { rev: 2 } });
    expect((await evidence.getOne(bob.id, fromSegment.id)).source).toMatchObject({ currentSegmentRev: 2, textChanged: true });

    // Alice revokes the share: the link goes, the quote stays.
    await prisma.transcriptShare.delete({ where: { id: share.id } });
    const revoked = await evidence.getOne(bob.id, fromSegment.id);
    expect(revoked.quote).toBe('Sarah joined Acme');
    expect(revoked.source).toMatchObject({
      kind: 'segment',
      available: false,
      href: null,
      transcriptTitle: null,
      currentSegmentRev: null,
      textChanged: false,
    });
    const afterRevoke = await reads.mentions({ id: bob.id }, person, { limit: 25 } as never);
    expect(afterRevoke.items.find((m) => m.kind === 'transcript')).toEqual({
      kind: 'transcript',
      id: transcript.id,
      title: null,
      occurredAt: null,
      available: false,
    });

    // Another owner's evidence id is the evidence 404 — and omitted from a batch.
    await expect(evidence.getOne(alice.id, fromSegment.id)).rejects.toThrow(NotFoundException);
    expect(await evidence.getMany(alice.id, [fromSegment.id])).toEqual([]);
  });

  it('pages mentions with a keyset cursor', async () => {
    const { user, g } = await owner();
    const person = await g.entity('Person', 'Sarah');
    const transcripts = [];
    for (let i = 0; i < 3; i++) {
      const { transcript } = await g.transcript({ recordedAt: new Date(Date.UTC(2026, i, 1)) });
      transcripts.push(transcript.id);
      await prisma.kgMention.create({ data: { ownerId: user.id, entityId: person, transcriptId: transcript.id } });
    }
    const first = await reads.mentions({ id: user.id }, person, { limit: 2 } as never);
    expect(first.items.map((m) => m.id)).toEqual([transcripts[2], transcripts[1]]);
    const second = await reads.mentions({ id: user.id }, person, { limit: 2, cursor: first.nextCursor } as never);
    expect(second.items.map((m) => m.id)).toEqual([transcripts[0]]);
    expect(second.nextCursor).toBeNull();
  });
});
