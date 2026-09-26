// =============================================================================
// Real-Postgres test: KgPurgeService (#357, epic #344; docs/specs/ontology.md
// §11, §15)
// =============================================================================
//
// "Forget this person" and the Danger Zone's `graph` category, against a real,
// migrated database — because the three things that make this deletion hard
// only exist there:
//
//   - the deferred no-orphans trigger (#355), which refuses any COMMIT that
//     leaves an accepted subject without evidence — so the purge's batch
//     ordering is only proven by real COMMITs;
//   - `kg_evidence`'s polymorphic subject (no FK) and entity ids inside draft
//     proposal JSON, which no cascade reaches — the `jsonb_path_exists`
//     predicate is only proven by Postgres evaluating it;
//   - the content tables the purge must NOT touch, whose row counts and texts
//     are compared before and after.
//
// The fixture is the issue's: Person P with two aliases and a merged tombstone
// P′ → P; P has WORKS_FOR and IDENTIFIED_AS edges; a Claim with subject P, a
// Commitment with owner P and one with counterparty P; mentions and evidence
// citing a transcript segment and a note span; draft and committed proposals.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';
import { KgPurgeService } from '../../src/graph/purge/kg-purge.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-purge.db.spec');

const EMAIL_PREFIX = 'kg-purge-test';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

describeWithDb('KgPurgeService (real Postgres)', () => {
  let prisma: PrismaClient;
  let purge: KgPurgeService;

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
    purge = new KgPurgeService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const users = await prisma.user.findMany({
      where: { email: { startsWith: EMAIL_PREFIX } },
      select: { id: true },
    });
    for (const { id } of users) await purge.purgeAll(id);
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
    await prisma.transcriptSegment.deleteMany({ where: { transcript: owner } });
    await prisma.transcriptSpeaker.deleteMany({ where: { transcript: owner } });
    await prisma.transcript.deleteMany({ where: owner });
    await prisma.storageObject.deleteMany({ where: { uploadedBy: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.noteVersion.deleteMany({ where: { note: owner } });
    await prisma.note.deleteMany({ where: owner });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  // ---------------------------------------------------------------------------
  // Fixture
  // ---------------------------------------------------------------------------

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
  }

  async function content(ownerId: string) {
    const note = await prisma.note.create({
      data: { ownerId, title: 'Standup', body: 'Sarah will send the deck', status: 'ready', sourceType: 'document' },
    });
    await prisma.noteVersion.create({
      data: { noteId: note.id, version: 1, kind: 'edit', body: 'Sarah will send the deck' },
    });
    const source = await prisma.storageObject.create({
      data: {
        name: 'r.m4a',
        size: BigInt(1),
        mimeType: 'audio/mp4',
        storageKey: `${EMAIL_PREFIX}/${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: ownerId,
      },
    });
    const transcript = await prisma.transcript.create({
      data: { ownerId, title: 'Call', sourceObjectId: source.id, provider: 'assemblyai' },
    });
    const speaker = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
    });
    const segment = await prisma.transcriptSegment.create({
      data: {
        transcriptId: transcript.id,
        speakerId: speaker.id,
        startMs: 0,
        endMs: 1000,
        ordinal: 1000,
        text: 'Sarah joined Acme in 2019',
        words: [],
      },
    });
    return { note, transcript, speaker, segment };
  }

  /** Evidence citing the segment and a span of the note — the issue's two anchors. */
  function cite(
    tx: Tx,
    ownerId: string,
    subjectKind: 'entity' | 'relation' | 'item' | 'proposal_item',
    subjectId: string,
    c: Awaited<ReturnType<typeof content>>,
  ) {
    return tx.kgEvidence.createMany({
      data: [
        { ownerId, subjectKind, subjectId, transcriptId: c.transcript.id, segmentId: c.segment.id, quote: 'Sarah joined Acme' },
        { ownerId, subjectKind, subjectId, noteId: c.note.id, noteVersion: 1, charStart: 0, charEnd: 5, quote: 'Sarah' },
      ],
    });
  }

  async function seed(ownerId: string) {
    const c = await content(ownerId);
    const ids = {
      p: randomUUID(),
      pPrime: randomUUID(),
      org: randomUUID(),
      q: randomUUID(),
      worksFor: randomUUID(),
      identifiedAs: randomUUID(),
      qWorksFor: randomUUID(),
      claim: randomUUID(),
      ownerCommitment: randomUUID(),
      counterpartyCommitment: randomUUID(),
      survivorItem: randomUUID(),
      draft: randomUUID(),
      committed: randomUUID(),
      unrelatedDraftItem: randomUUID(),
      committedItem: randomUUID(),
    };
    const v = 'test';

    await prisma.$transaction(async (tx) => {
      await tx.kgEntity.createMany({
        data: [
          { id: ids.p, ownerId, type: 'Person', label: 'Sarah Chen', ontologyVersion: v },
          { id: ids.org, ownerId, type: 'Organization', label: 'Acme', ontologyVersion: v },
          { id: ids.q, ownerId, type: 'Person', label: 'Tom Hale', ontologyVersion: v },
        ],
      });
      await tx.kgEntity.create({
        data: { id: ids.pPrime, ownerId, type: 'Person', label: 'S. Chen', reviewStatus: 'merged', mergedIntoId: ids.p, ontologyVersion: v },
      });
      for (const id of [ids.p, ids.pPrime, ids.org, ids.q]) await cite(tx, ownerId, 'entity', id, c);

      await tx.kgEntityAlias.createMany({
        data: [
          { entityId: ids.p, ownerId, alias: 'Sarah Chen', normalized: 'sarah chen', source: 'extraction' },
          { entityId: ids.p, ownerId, alias: 'Sarah', normalized: 'sarah', source: 'user' },
          { entityId: ids.p, ownerId, alias: 'SC', normalized: 'sc', source: 'user' },
          { entityId: ids.pPrime, ownerId, alias: 'S. Chen', normalized: 's chen', source: 'extraction' },
          { entityId: ids.q, ownerId, alias: 'Tom Hale', normalized: 'tom hale', source: 'extraction' },
          { entityId: ids.org, ownerId, alias: 'Acme', normalized: 'acme', source: 'extraction' },
        ],
      });

      await tx.kgRelation.createMany({
        data: [
          { id: ids.worksFor, ownerId, type: 'WORKS_FOR', fromId: ids.p, toId: ids.org, ontologyVersion: v },
          { id: ids.identifiedAs, ownerId, type: 'IDENTIFIED_AS', fromSpeakerId: c.speaker.id, toId: ids.p, ontologyVersion: v },
          { id: ids.qWorksFor, ownerId, type: 'WORKS_FOR', fromId: ids.q, toId: ids.org, ontologyVersion: v },
        ],
      });
      for (const id of [ids.worksFor, ids.identifiedAs, ids.qWorksFor]) await cite(tx, ownerId, 'relation', id, c);

      await tx.kgItem.createMany({
        data: [
          { id: ids.claim, ownerId, kind: 'claim', subjectId: ids.p, statement: 'Sarah is CTO', status: 'open', statementHash: 'h1', ontologyVersion: v },
          { id: ids.ownerCommitment, ownerId, kind: 'commitment', ownerPersonId: ids.p, statement: 'Sarah sends the deck', status: 'open', statementHash: 'h2', ontologyVersion: v },
          { id: ids.counterpartyCommitment, ownerId, kind: 'commitment', ownerPersonId: ids.q, counterpartyId: ids.p, statement: 'Tom calls Sarah', status: 'open', statementHash: 'h3', ontologyVersion: v },
        ],
      });
      // An item about Q that merely superseded-points at P's claim survives.
      await tx.kgItem.create({
        data: { id: ids.survivorItem, ownerId, kind: 'claim', subjectId: ids.q, statement: 'Tom is VP', status: 'open', statementHash: 'h4', reviewStatus: 'superseded', supersededById: ids.claim, ontologyVersion: v },
      });
      for (const id of [ids.claim, ids.ownerCommitment, ids.counterpartyCommitment, ids.survivorItem]) {
        await cite(tx, ownerId, 'item', id, c);
      }
    });

    await prisma.kgMention.createMany({
      data: [
        { ownerId, entityId: ids.p, noteId: c.note.id, span: { start: 0, end: 5 } },
        { ownerId, entityId: ids.p, transcriptId: c.transcript.id },
        { ownerId, entityId: ids.pPrime, noteId: c.note.id },
        { ownerId, entityId: ids.q, noteId: c.note.id },
      ],
    });
    await prisma.kgEntityDigest.create({
      data: { entityId: ids.p, ownerId, summary: 'Sarah…', citations: [], coversUntil: new Date(), model: 'm', generatedAt: new Date() },
    });
    await prisma.kgEntityView.create({ data: { userId: ownerId, entityId: ids.p, lastViewedAt: new Date() } });
    await prisma.kgEntityView.create({ data: { userId: ownerId, entityId: ids.q, lastViewedAt: new Date() } });
    await prisma.kgMerge.create({ data: { ownerId, survivorId: ids.p, mergedId: ids.pPrime, reversal: {} } });
    const [a, b] = [ids.p, ids.q].sort();
    await prisma.kgDistinctPair.create({ data: { ownerId, aId: a, bId: b } });
    await prisma.kgAttributeDef.create({
      data: { ownerId, entityType: 'Person', key: 'u_nickname', label: 'Nickname', kind: 'text' },
    });

    // A DRAFT proposal: five items that name P or P′ in each of the ways the
    // issue lists, and one that does not (whose distinct_from names P).
    await prisma.kgProposal.create({
      data: { id: ids.draft, ownerId, kind: 'extraction', status: 'draft', noteId: c.note.id, noteVersion: 1 },
    });
    const draftItems = await Promise.all([
      prisma.kgProposalItem.create({ data: { proposalId: ids.draft, kind: 'entity', payload: { label: 'Sarah', existingEntityId: ids.p } } }),
      prisma.kgProposalItem.create({ data: { proposalId: ids.draft, kind: 'relation', payload: { type: 'WORKS_FOR', from: { entityId: ids.p }, to: { entityId: ids.org } } } }),
      prisma.kgProposalItem.create({ data: { proposalId: ids.draft, kind: 'entity', payload: { label: 'S' }, resolution: { ref: ids.pPrime } } }),
      prisma.kgProposalItem.create({ data: { proposalId: ids.draft, kind: 'entity', payload: { label: 'Sar' }, resolution: { candidates: [{ entityId: ids.org }, { entityId: ids.pPrime }] } } }),
      prisma.kgProposalItem.create({ data: { proposalId: ids.draft, kind: 'entity', payload: { label: 'Sarah C' }, decision: 'merge_into', mergeIntoId: ids.p } }),
      prisma.kgProposalItem.create({ data: { proposalId: ids.draft, kind: 'item', payload: { statement: 'x' }, editedPayload: { nested: [{ owner: { entityId: ids.p } }] } } }),
    ]);
    await prisma.kgProposalItem.create({
      data: { id: ids.unrelatedDraftItem, proposalId: ids.draft, kind: 'entity', payload: { label: 'Acme', existingEntityId: ids.org }, distinctFrom: [ids.p, ids.org] },
    });
    await prisma.kgEvidence.create({
      data: { ownerId, subjectKind: 'proposal_item', subjectId: draftItems[0].id, noteId: c.note.id, noteVersion: 1, quote: 'Sarah' },
    });

    // A COMMITTED proposal is history: its items survive.
    await prisma.kgProposal.create({
      data: { id: ids.committed, ownerId, kind: 'extraction', status: 'committed', noteId: c.note.id, noteVersion: 1 },
    });
    await prisma.kgProposalItem.create({
      data: { id: ids.committedItem, proposalId: ids.committed, kind: 'entity', payload: { label: 'Sarah', existingEntityId: ids.p } },
    });

    return { c, ids, draftItemIds: draftItems.map((i) => i.id) };
  }

  /** Row counts of every kg_* table for one owner (views: by viewer). */
  async function graphCounts(ownerId: string) {
    const owned = { where: { ownerId } };
    return {
      entities: await prisma.kgEntity.count(owned),
      aliases: await prisma.kgEntityAlias.count(owned),
      relations: await prisma.kgRelation.count(owned),
      items: await prisma.kgItem.count(owned),
      evidence: await prisma.kgEvidence.count(owned),
      mentions: await prisma.kgMention.count(owned),
      proposals: await prisma.kgProposal.count(owned),
      proposalItems: await prisma.kgProposalItem.count({ where: { proposal: { ownerId } } }),
      merges: await prisma.kgMerge.count(owned),
      distinctPairs: await prisma.kgDistinctPair.count(owned),
      attributeDefs: await prisma.kgAttributeDef.count(owned),
      digests: await prisma.kgEntityDigest.count(owned),
      views: await prisma.kgEntityView.count({ where: { userId: ownerId } }),
    };
  }

  /** The primary content the purge must never touch — counts and texts. */
  async function contentSnapshot(ownerId: string) {
    return {
      transcripts: await prisma.transcript.findMany({ where: { ownerId }, select: { id: true, title: true } }),
      segments: await prisma.transcriptSegment.findMany({ where: { transcript: { ownerId } }, select: { id: true, text: true } }),
      speakers: await prisma.transcriptSpeaker.count({ where: { transcript: { ownerId } } }),
      notes: await prisma.note.findMany({ where: { ownerId }, select: { id: true, body: true } }),
      noteVersions: await prisma.noteVersion.findMany({ where: { note: { ownerId } }, select: { id: true, body: true } }),
      objects: await prisma.storageObject.count({ where: { uploadedById: ownerId } }),
      users: await prisma.user.count({ where: { id: ownerId } }),
    };
  }

  // ===========================================================================
  // scope: 'person'
  // ===========================================================================

  describe('purgePerson', () => {
    it('forgets P, its tombstone P′ and everything derived about them, and nothing else', async () => {
      const owner = await createUser('person');
      const { ids, draftItemIds } = await seed(owner.id);
      const before = await contentSnapshot(owner.id);

      const result = await purge.purgePerson(owner.id, ids.p);

      expect(result).not.toBeNull();
      expect(new Set(result!.entityIds)).toEqual(new Set([ids.p, ids.pPrime]));

      // The person set is gone.
      await expect(prisma.kgEntity.count({ where: { id: { in: [ids.p, ids.pPrime] } } })).resolves.toBe(0);
      await expect(prisma.kgEntityAlias.count({ where: { entityId: { in: [ids.p, ids.pPrime] } } })).resolves.toBe(0);
      await expect(prisma.kgRelation.count({ where: { id: { in: [ids.worksFor, ids.identifiedAs] } } })).resolves.toBe(0);
      await expect(
        prisma.kgItem.count({ where: { id: { in: [ids.claim, ids.ownerCommitment, ids.counterpartyCommitment] } } }),
      ).resolves.toBe(0);
      await expect(prisma.kgMention.count({ where: { entityId: { in: [ids.p, ids.pPrime] } } })).resolves.toBe(0);
      await expect(prisma.kgEntityDigest.count({ where: { entityId: ids.p } })).resolves.toBe(0);
      await expect(prisma.kgEntityView.count({ where: { entityId: ids.p } })).resolves.toBe(0);
      await expect(prisma.kgMerge.count({ where: { ownerId: owner.id } })).resolves.toBe(0);
      await expect(prisma.kgDistinctPair.count({ where: { ownerId: owner.id } })).resolves.toBe(0);

      // No citation of anything forgotten survives — the polymorphic subject has no FK.
      const forgottenSubjects = [
        ids.p, ids.pPrime, ids.worksFor, ids.identifiedAs, ids.claim, ids.ownerCommitment,
        ids.counterpartyCommitment, ...draftItemIds,
      ];
      await expect(prisma.kgEvidence.count({ where: { subjectId: { in: forgottenSubjects } } })).resolves.toBe(0);

      // Draft proposal items naming P/P′ are removed; the unrelated one stays
      // with P stripped from its distinct_from; committed history stays.
      await expect(prisma.kgProposalItem.count({ where: { id: { in: draftItemIds } } })).resolves.toBe(0);
      const unrelated = await prisma.kgProposalItem.findUniqueOrThrow({ where: { id: ids.unrelatedDraftItem } });
      expect(unrelated.distinctFrom).toEqual([ids.org]);
      await expect(prisma.kgProposalItem.count({ where: { id: ids.committedItem } })).resolves.toBe(1);
      await expect(prisma.kgProposal.count({ where: { ownerId: owner.id } })).resolves.toBe(2);

      // Unrelated entities, relations and items survive — with their evidence.
      await expect(prisma.kgEntity.count({ where: { id: { in: [ids.org, ids.q] } } })).resolves.toBe(2);
      await expect(prisma.kgRelation.count({ where: { id: ids.qWorksFor } })).resolves.toBe(1);
      await expect(prisma.kgEvidence.count({ where: { subjectId: { in: [ids.org, ids.q, ids.qWorksFor] } } })).resolves.toBe(6);
      await expect(prisma.kgMention.count({ where: { entityId: ids.q } })).resolves.toBe(1);
      await expect(prisma.kgEntityView.count({ where: { entityId: ids.q } })).resolves.toBe(1);
      await expect(prisma.kgAttributeDef.count({ where: { ownerId: owner.id } })).resolves.toBe(1);

      // The superseded-pointing item survives with the pointer cleared.
      const survivor = await prisma.kgItem.findUniqueOrThrow({ where: { id: ids.survivorItem } });
      expect(survivor.supersededById).toBeNull();
      await expect(prisma.kgEvidence.count({ where: { subjectId: ids.survivorItem } })).resolves.toBe(2);

      // Primary content is untouched — counts AND texts.
      await expect(contentSnapshot(owner.id)).resolves.toEqual(before);

      expect(result!.counts).toMatchObject({
        entities: 2,
        aliases: 4,
        relations: 2,
        items: 3,
        // 2 entities × 2 + 2 relations × 2 + 3 items × 2 + 1 proposal item.
        evidence: 15,
        mentions: 3,
        proposalItems: 6,
        merges: 1,
        distinctPairs: 1,
        digests: 1,
        views: 1,
      });
    });

    it('is re-entrant: a second run finds nothing left and deletes nothing', async () => {
      const owner = await createUser('reentrant');
      const { ids } = await seed(owner.id);
      await purge.purgePerson(owner.id, ids.p);
      const after = await graphCounts(owner.id);

      await expect(purge.purgePerson(owner.id, ids.p)).resolves.toBeNull();
      await expect(graphCounts(owner.id)).resolves.toEqual(after);
    });

    it('is a no-op for a non-Person, and for another user\'s Person', async () => {
      const owner = await createUser('noop');
      const stranger = await createUser('noop-stranger');
      const { ids } = await seed(owner.id);
      const before = await graphCounts(owner.id);

      await expect(purge.purgePerson(owner.id, ids.org)).resolves.toBeNull();
      await expect(purge.purgePerson(stranger.id, ids.p)).resolves.toBeNull();
      await expect(graphCounts(owner.id)).resolves.toEqual(before);
    });

    it('leaves another user\'s graph untouched', async () => {
      const owner = await createUser('iso-a');
      const other = await createUser('iso-b');
      const { ids } = await seed(owner.id);
      await seed(other.id);
      const otherBefore = await graphCounts(other.id);

      await purge.purgePerson(owner.id, ids.p);

      await expect(graphCounts(other.id)).resolves.toEqual(otherBefore);
    });
  });

  // ===========================================================================
  // scope: 'all'
  // ===========================================================================

  describe('purgeAll', () => {
    it('leaves the user with zero rows in every kg_* table, content untouched, another user untouched', async () => {
      const owner = await createUser('all');
      const other = await createUser('all-other');
      await seed(owner.id);
      await seed(other.id);
      const contentBefore = await contentSnapshot(owner.id);
      const otherBefore = await graphCounts(other.id);

      // Something a proposal cannot reach by owner: an import anchor.
      await prisma.kgEvidence.create({
        data: { ownerId: owner.id, subjectKind: 'import', subjectId: randomUUID(), quote: 'imported' },
      });

      const counts = await purge.purgeAll(owner.id);

      const after = await graphCounts(owner.id);
      for (const [table, n] of Object.entries(after)) {
        expect([table, n]).toEqual([table, 0]);
      }
      await expect(contentSnapshot(owner.id)).resolves.toEqual(contentBefore);
      await expect(graphCounts(other.id)).resolves.toEqual(otherBefore);

      expect(counts).toMatchObject({
        entities: 4,
        relations: 3,
        items: 4,
        proposals: 2,
        proposalItems: 8,
        attributeDefs: 1,
        views: 2,
      });
    });

    it('is re-entrant: a second run deletes nothing and does not throw', async () => {
      const owner = await createUser('all-twice');
      await seed(owner.id);
      await purge.purgeAll(owner.id);

      const counts = await purge.purgeAll(owner.id);

      expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    });
  });
});
