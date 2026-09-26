// =============================================================================
// Real-Postgres test: the knowledge-graph data model's constraints (issue
// #351, epic #344)
// =============================================================================
//
// A hand-written index, a CHECK constraint and a foreign key's ON DELETE
// behaviour only exist once a migration has run against a real database — a
// unit test importing `schema.prisma` can read the DECLARATION, never prove
// the DATABASE agrees with it. So, like `transcript-schema.db.spec.ts` and
// `job-schema-indexes.db.spec.ts` beside it, this is a `*.db.spec.ts` file,
// deliberately excluded from `npm test`/`test:unit`/`test:cov`/`test:ci` (see
// apps/api/package.json's testPathIgnorePatterns). It runs only via
// `npm run test:db`, which CI's `Smoke` job invokes right after
// `prisma:migrate` and before `prisma:seed`. Locally, `npm run test:db` needs
// a real Postgres reachable at POSTGRES_HOST/POSTGRES_PORT with pg_trgm and
// pgvector available and the migrations applied; see `resolveDbSuite` for
// what happens without one.
//
// What this file asserts, and why each one is this migration's own
// responsibility (docs/specs/ontology.md §10):
//
//   - All eleven hand-written index names exist in `pg_indexes`.
//   - `pg_trgm` is installed.
//   - `pg_enum` carries the COMPLETE proposal model (`kg_proposal_status`,
//     `kg_proposal_kind`) — every value #363/#364/#366/#387 will need, so
//     none of them ever needs `ALTER TYPE … ADD VALUE`.
//   - Every CHECK constraint listed in the migration exists, each proven
//     with one rejected insert.
//   - The two `EXPLAIN` plan assertions (trigram, range containment).
//   - The cascade/SetNull behaviours §10 specifies for every FK direction.
//   - `tstzrange` round-trips through `lower()`/`upper()`/`upper_inf()`.
//   - `kg_items_live_statement_uniq_idx`'s actual dedup behaviour (rejected
//     while `accepted`, allowed once the blocking row is `rejected`).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildDatabaseUrl } from '../../src/common/database-url';
import { resolveDbSuite, createDbClient } from '../jobs/db-test-support';

// All ELEVEN hand-written, Prisma-inexpressible indexes this migration adds
// (see migration.sql's "HAND-WRITTEN, PRISMA-INEXPRESSIBLE SQL" header).
const HAND_WRITTEN_INDEX_NAMES = [
  'kg_entities_label_trgm_idx',
  'kg_entity_aliases_normalized_trgm_idx',
  'kg_relations_valid_gist_idx',
  'kg_items_valid_gist_idx',
  'kg_entities_embedding_hnsw_idx',
  'kg_items_embedding_hnsw_idx',
  'kg_items_live_statement_uniq_idx',
  'kg_proposals_note_draft_uniq_idx',
  'kg_proposals_note_extracting_uniq_idx',
  'kg_proposals_owner_import_extracting_uniq_idx',
  'kg_relations_speaker_link_uniq_idx',
];

const CHECK_CONSTRAINT_NAMES = [
  'kg_distinct_pairs_order_chk',
  'kg_mentions_one_source_chk',
  'kg_relations_one_source_chk',
  'kg_relations_speaker_type_chk',
  'kg_relations_valid_precision_chk',
  'kg_items_sensitivity_chk',
  'kg_items_subject_required_chk',
  'kg_evidence_char_range_chk',
  'kg_evidence_ms_range_chk',
  'kg_proposal_items_kind_payload_chk',
  'kg_proposal_items_merge_into_chk',
  'kg_proposals_note_source_chk',
];

const { describeWithDb, dbReachable } = resolveDbSuite('kg-schema.db.spec');

describeWithDb('Knowledge graph schema (real Postgres)', () => {
  let prisma: PrismaClient;

  const EMAIL_PREFIX = 'kg-schema-test';

  beforeAll(async () => {
    if (!dbReachable) return;
    // `DATABASE_URL` is stripped before rebuilding from POSTGRES_* — see
    // `db-test-support.ts`'s own reasoning: `test/setup.ts` loads a
    // hard-coded value from `.env.test` that would point this suite
    // somewhere other than the host the reachability check just proved.
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      },
    });
  }

  async function createEntity(ownerId: string, overrides: Partial<{ type: string; label: string }> = {}) {
    return prisma.kgEntity.create({
      data: {
        ownerId,
        type: overrides.type ?? 'person',
        label: overrides.label ?? 'Sarah Chen',
        ontologyVersion: 'test-v1',
      },
    });
  }

  afterEach(async () => {
    if (!dbReachable) return;
    // Children first — every kg_* table but the entity/relation/item trio
    // itself cascades off an owner or an entity anyway, so most of this is
    // belt-and-braces for rows a failed assertion left behind mid-test.
    await prisma.kgProposalItem.deleteMany({
      where: { proposal: { owner: { email: { startsWith: EMAIL_PREFIX } } } },
    });
    await prisma.kgProposal.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.kgMention.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.kgEvidence.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.kgMerge.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.$executeRaw`DELETE FROM "kg_distinct_pairs" WHERE "owner_id" IN (SELECT "id" FROM "users" WHERE "email" LIKE ${EMAIL_PREFIX + '%'})`;
    await prisma.kgAttributeDef.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.kgRelation.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.kgItem.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.kgEntityAlias.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.kgEntity.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  // ===========================================================================
  // Hand-written indexes and pg_trgm
  // ===========================================================================

  describe('hand-written indexes (Prisma-inexpressible, migration.sql only)', () => {
    it('creates all eleven hand-written indexes', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE indexname = ANY(${HAND_WRITTEN_INDEX_NAMES})
      `;
      expect(rows.map((r) => r.indexname).sort()).toEqual([...HAND_WRITTEN_INDEX_NAMES].sort());
    });

    it('has pg_trgm installed', async () => {
      const rows = await prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
      `;
      expect(rows).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Every CHECK constraint exists
  // ===========================================================================

  describe('CHECK constraints exist', () => {
    it('has all twelve CHECK constraints', async () => {
      const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint WHERE conname = ANY(${CHECK_CONSTRAINT_NAMES})
      `;
      expect(rows.map((r) => r.conname).sort()).toEqual([...CHECK_CONSTRAINT_NAMES].sort());
    });
  });

  // ===========================================================================
  // The complete proposal model (issue #351's own "no ALTER TYPE later" goal)
  // ===========================================================================

  describe('the complete proposal model', () => {
    it('kg_proposal_status has exactly draft extracting committed discarded failed reverted', async () => {
      const rows = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
        SELECT e.enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'kg_proposal_status'
        ORDER BY e.enumsortorder
      `;
      expect(rows.map((r) => r.enumlabel)).toEqual([
        'draft',
        'extracting',
        'committed',
        'discarded',
        'failed',
        'reverted',
      ]);
    });

    it('kg_proposal_kind has exactly extraction import resolution', async () => {
      const rows = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
        SELECT e.enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'kg_proposal_kind'
        ORDER BY e.enumsortorder
      `;
      expect(rows.map((r) => r.enumlabel)).toEqual(['extraction', 'import', 'resolution']);
    });

    it('has commit_log, merge_into_id/distinct_from, embedding_hash, from_speaker_id and meeting_id', async () => {
      const rows = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'kg_proposals' AND column_name = 'commit_log')
           OR (table_name = 'kg_proposal_items' AND column_name IN ('merge_into_id', 'distinct_from'))
           OR (table_name = 'kg_entities' AND column_name = 'embedding_hash')
           OR (table_name = 'kg_items' AND column_name IN ('embedding_hash', 'meeting_id'))
           OR (table_name = 'kg_relations' AND column_name = 'from_speaker_id')
      `;
      const found = rows.map((r) => `${r.table_name}.${r.column_name}`).sort();
      expect(found).toEqual(
        [
          'kg_entities.embedding_hash',
          'kg_items.embedding_hash',
          'kg_items.meeting_id',
          'kg_proposal_items.distinct_from',
          'kg_proposal_items.merge_into_id',
          'kg_proposals.commit_log',
          'kg_relations.from_speaker_id',
        ].sort(),
      );
    });
  });

  // ===========================================================================
  // kg_proposals_note_source_chk
  // ===========================================================================

  describe('kg_proposals_note_source_chk', () => {
    it('rejects an extraction proposal without note_version', async () => {
      const owner = await createUser('proposal-extraction-no-version');
      const note = await prisma.note.create({
        data: { ownerId: owner.id, title: 'Note', body: 'Body', status: 'ready', sourceType: 'document' },
      });

      await expect(
        prisma.kgProposal.create({
          data: { ownerId: owner.id, kind: 'extraction', noteId: note.id },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('rejects an import proposal with a note_id set', async () => {
      const owner = await createUser('proposal-import-with-note');
      const note = await prisma.note.create({
        data: { ownerId: owner.id, title: 'Note', body: 'Body', status: 'ready', sourceType: 'document' },
      });

      await expect(
        prisma.kgProposal.create({
          data: { ownerId: owner.id, kind: 'import', noteId: note.id },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('allows an extraction proposal with note_version, and survives the note being hard-deleted', async () => {
      const owner = await createUser('proposal-source-chk-survive');
      const note = await prisma.note.create({
        data: { ownerId: owner.id, title: 'Note', body: 'Body', status: 'ready', sourceType: 'document' },
      });
      const proposal = await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'extraction', noteId: note.id, noteVersion: 1 },
      });

      // Hard-deleting the note SetNulls kg_proposals.note_id — the CHECK
      // keys on note_version (never nulled), never on note_id, precisely so
      // this delete does not violate it. See migration.sql's own comment.
      await prisma.note.delete({ where: { id: note.id } });

      await expect(prisma.kgProposal.findUniqueOrThrow({ where: { id: proposal.id } })).resolves.toMatchObject({
        noteId: null,
        noteVersion: 1,
      });
    });
  });

  // ===========================================================================
  // kg_relations_one_source_chk / kg_relations_speaker_type_chk
  // ===========================================================================

  describe('kg_relations source/speaker-type CHECKs', () => {
    it('rejects a relation with both from_id and from_speaker_id set', async () => {
      const owner = await createUser('relation-both-sources');
      const from = await createEntity(owner.id);
      const to = await createEntity(owner.id, { label: 'Acme Corp', type: 'organization' });
      const source = await prisma.storageObject.create({
        data: {
          name: 'r.m4a',
          size: BigInt(1),
          mimeType: 'audio/mp4',
          storageKey: `kg-schema-test/${randomUUID()}`,
          managedBy: 'transcripts',
          uploadedById: owner.id,
        },
      });
      const transcript = await prisma.transcript.create({
        data: { ownerId: owner.id, title: 'T', sourceObjectId: source.id, provider: 'assemblyai' },
      });
      const speaker = await prisma.transcriptSpeaker.create({
        data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
      });

      await expect(
        prisma.kgRelation.create({
          data: {
            ownerId: owner.id,
            type: 'IDENTIFIED_AS',
            fromId: from.id,
            fromSpeakerId: speaker.id,
            toId: to.id,
            ontologyVersion: 'test-v1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });

      await prisma.transcript.delete({ where: { id: transcript.id } });
      await prisma.storageObject.delete({ where: { id: source.id } });
    });

    it('rejects a non-IDENTIFIED_AS relation with from_speaker_id set', async () => {
      const owner = await createUser('relation-wrong-type-speaker');
      const to = await createEntity(owner.id, { label: 'Acme Corp', type: 'organization' });
      const source = await prisma.storageObject.create({
        data: {
          name: 'r.m4a',
          size: BigInt(1),
          mimeType: 'audio/mp4',
          storageKey: `kg-schema-test/${randomUUID()}`,
          managedBy: 'transcripts',
          uploadedById: owner.id,
        },
      });
      const transcript = await prisma.transcript.create({
        data: { ownerId: owner.id, title: 'T', sourceObjectId: source.id, provider: 'assemblyai' },
      });
      const speaker = await prisma.transcriptSpeaker.create({
        data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
      });

      await expect(
        prisma.kgRelation.create({
          data: {
            ownerId: owner.id,
            type: 'WORKS_AT',
            fromSpeakerId: speaker.id,
            toId: to.id,
            ontologyVersion: 'test-v1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });

      await prisma.transcript.delete({ where: { id: transcript.id } });
      await prisma.storageObject.delete({ where: { id: source.id } });
    });

    it('allows an IDENTIFIED_AS relation with from_speaker_id only, and cascades on speaker deletion', async () => {
      const owner = await createUser('relation-speaker-ok');
      const to = await createEntity(owner.id, { label: 'Sarah Chen' });
      const source = await prisma.storageObject.create({
        data: {
          name: 'r.m4a',
          size: BigInt(1),
          mimeType: 'audio/mp4',
          storageKey: `kg-schema-test/${randomUUID()}`,
          managedBy: 'transcripts',
          uploadedById: owner.id,
        },
      });
      const transcript = await prisma.transcript.create({
        data: { ownerId: owner.id, title: 'T', sourceObjectId: source.id, provider: 'assemblyai' },
      });
      const speaker = await prisma.transcriptSpeaker.create({
        data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
      });

      const relation = await prisma.kgRelation.create({
        data: {
          ownerId: owner.id,
          type: 'IDENTIFIED_AS',
          fromSpeakerId: speaker.id,
          toId: to.id,
          ontologyVersion: 'test-v1',
        },
      });

      // A second IDENTIFIED_AS edge for the SAME speaker is refused by
      // kg_relations_speaker_link_uniq_idx.
      await expect(
        prisma.kgRelation.create({
          data: {
            ownerId: owner.id,
            type: 'IDENTIFIED_AS',
            fromSpeakerId: speaker.id,
            toId: to.id,
            ontologyVersion: 'test-v1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await prisma.transcriptSpeaker.delete({ where: { id: speaker.id } });
      await expect(prisma.kgRelation.findUnique({ where: { id: relation.id } })).resolves.toBeNull();

      await prisma.transcript.delete({ where: { id: transcript.id } });
      await prisma.storageObject.delete({ where: { id: source.id } });
    });
  });

  // ===========================================================================
  // kg_items_sensitivity_chk / kg_items_subject_required_chk
  // ===========================================================================

  describe('kg_items sensitivity/subject CHECKs', () => {
    it('rejects a person_fact without sensitivity', async () => {
      const owner = await createUser('item-person-fact-no-sensitivity');
      const subject = await createEntity(owner.id);

      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'person_fact',
            subjectId: subject.id,
            statement: 'Likes coffee',
            status: 'active',
            statementHash: randomUUID(),
            ontologyVersion: 'test-v1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('rejects a claim with a sensitivity set', async () => {
      const owner = await createUser('item-claim-with-sensitivity');
      const subject = await createEntity(owner.id);

      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'claim',
            subjectId: subject.id,
            statement: 'Revenue grew 20%',
            status: 'active',
            statementHash: randomUUID(),
            sensitivity: 'business',
            ontologyVersion: 'test-v1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('rejects a claim without a subject_id', async () => {
      const owner = await createUser('item-claim-no-subject');

      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'claim',
            statement: 'Revenue grew 20%',
            status: 'active',
            statementHash: randomUUID(),
            ontologyVersion: 'test-v1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('allows a commitment without a subject_id', async () => {
      const owner = await createUser('item-commitment-no-subject');

      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'commitment',
            statement: 'Send the deck',
            status: 'open',
            statementHash: randomUUID(),
            ontologyVersion: 'test-v1',
          },
        }),
      ).resolves.toMatchObject({ kind: 'commitment' });
    });
  });

  // ===========================================================================
  // kg_evidence_char_range_chk / kg_evidence_ms_range_chk, and the deliberate
  // ABSENCE of any anchor CHECK
  // ===========================================================================

  describe('kg_evidence range CHECKs, and no anchor CHECK', () => {
    it('rejects char_end before char_start', async () => {
      const owner = await createUser('evidence-char-range');

      await expect(
        prisma.kgEvidence.create({
          data: {
            ownerId: owner.id,
            subjectKind: 'entity',
            subjectId: randomUUID(),
            quote: 'hello',
            charStart: 10,
            charEnd: 5,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('rejects end_ms before start_ms', async () => {
      const owner = await createUser('evidence-ms-range');

      await expect(
        prisma.kgEvidence.create({
          data: {
            ownerId: owner.id,
            subjectKind: 'entity',
            subjectId: randomUUID(),
            quote: 'hello',
            startMs: 5000,
            endMs: 1000,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('allows an evidence row with every anchor NULL, keeping quote', async () => {
      const owner = await createUser('evidence-no-anchor');

      await expect(
        prisma.kgEvidence.create({
          data: {
            ownerId: owner.id,
            subjectKind: 'entity',
            subjectId: randomUUID(),
            quote: 'a fully anchorless citation is a valid end state',
          },
        }),
      ).resolves.toMatchObject({ quote: 'a fully anchorless citation is a valid end state' });
    });
  });

  // ===========================================================================
  // kg_mentions_one_source_chk
  // ===========================================================================

  describe('kg_mentions_one_source_chk', () => {
    it('rejects a mention with neither note_id nor transcript_id', async () => {
      const owner = await createUser('mention-no-source');
      const entity = await createEntity(owner.id);

      await expect(
        prisma.kgMention.create({
          data: { ownerId: owner.id, entityId: entity.id },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('rejects a mention with both note_id and transcript_id', async () => {
      const owner = await createUser('mention-both-sources');
      const entity = await createEntity(owner.id);
      const note = await prisma.note.create({
        data: { ownerId: owner.id, title: 'Note', body: 'Body', status: 'ready', sourceType: 'document' },
      });
      const source = await prisma.storageObject.create({
        data: {
          name: 'r.m4a',
          size: BigInt(1),
          mimeType: 'audio/mp4',
          storageKey: `kg-schema-test/${randomUUID()}`,
          managedBy: 'transcripts',
          uploadedById: owner.id,
        },
      });
      const transcript = await prisma.transcript.create({
        data: { ownerId: owner.id, title: 'T', sourceObjectId: source.id, provider: 'assemblyai' },
      });

      await expect(
        prisma.kgMention.create({
          data: { ownerId: owner.id, entityId: entity.id, noteId: note.id, transcriptId: transcript.id },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });

      await prisma.transcript.delete({ where: { id: transcript.id } });
      await prisma.storageObject.delete({ where: { id: source.id } });
    });
  });

  // ===========================================================================
  // kg_distinct_pairs_order_chk
  // ===========================================================================

  describe('kg_distinct_pairs_order_chk', () => {
    it('rejects a pair with a_id > b_id', async () => {
      const owner = await createUser('distinct-pairs-order');
      const a = await createEntity(owner.id, { label: 'Zed' });
      const b = await createEntity(owner.id, { label: 'Alice' });
      const [lo, hi] = [a.id, b.id].sort();

      // Insert with the ids REVERSED relative to the canonical order.
      await expect(
        prisma.$executeRaw`INSERT INTO "kg_distinct_pairs" ("owner_id", "a_id", "b_id", "created_at")
          VALUES (${owner.id}::uuid, ${hi}::uuid, ${lo}::uuid, now())`,
      ).rejects.toMatchObject({ code: 'P2010' });

      await expect(
        prisma.$executeRaw`INSERT INTO "kg_distinct_pairs" ("owner_id", "a_id", "b_id", "created_at")
          VALUES (${owner.id}::uuid, ${lo}::uuid, ${hi}::uuid, now())`,
      ).resolves.toBe(1);
    });
  });

  // ===========================================================================
  // kg_proposal_items_kind_payload_chk / kg_proposal_items_merge_into_chk
  // ===========================================================================

  describe('kg_proposal_items CHECKs', () => {
    it('rejects a payload that is not a JSON object', async () => {
      const owner = await createUser('proposal-item-bad-payload');
      const proposal = await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'import' },
      });

      await expect(
        prisma.$executeRaw`INSERT INTO "kg_proposal_items"
          ("id", "proposal_id", "kind", "payload", "created_at", "updated_at")
          VALUES (gen_random_uuid(), ${proposal.id}::uuid, 'entity', '[1,2,3]'::jsonb, now(), now())`,
      ).rejects.toMatchObject({ code: 'P2010' });
    });

    it('rejects merge_into_id set without decision = merge_into', async () => {
      const owner = await createUser('proposal-item-bad-merge-into');
      const target = await createEntity(owner.id);
      const proposal = await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'import' },
      });

      await expect(
        prisma.kgProposalItem.create({
          data: {
            proposalId: proposal.id,
            kind: 'entity',
            payload: {},
            mergeIntoId: target.id,
            decision: 'pending',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2039' });
    });

    it('allows merge_into_id set together with decision = merge_into, and SetNulls on target deletion', async () => {
      const owner = await createUser('proposal-item-good-merge-into');
      const target = await createEntity(owner.id);
      const proposal = await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'import' },
      });
      const item = await prisma.kgProposalItem.create({
        data: {
          proposalId: proposal.id,
          kind: 'entity',
          payload: {},
          mergeIntoId: target.id,
          decision: 'merge_into',
        },
      });

      await prisma.kgEntity.delete({ where: { id: target.id } });

      await expect(prisma.kgProposalItem.findUniqueOrThrow({ where: { id: item.id } })).resolves.toMatchObject({
        mergeIntoId: null,
      });
    });
  });

  // ===========================================================================
  // Partial unique indexes: proposal draft/extracting, and the item dedup
  // guard
  // ===========================================================================

  describe('partial unique indexes', () => {
    it('rejects a second draft proposal for the same note, allows a second committed one', async () => {
      const owner = await createUser('proposal-draft-uniq');
      const note = await prisma.note.create({
        data: { ownerId: owner.id, title: 'Note', body: 'Body', status: 'ready', sourceType: 'document' },
      });

      await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'extraction', noteId: note.id, noteVersion: 1 },
      });
      await expect(
        prisma.kgProposal.create({
          data: { ownerId: owner.id, kind: 'extraction', noteId: note.id, noteVersion: 1 },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await prisma.kgProposal.create({
        data: {
          ownerId: owner.id,
          kind: 'extraction',
          noteId: note.id,
          noteVersion: 1,
          status: 'committed',
        },
      });
      await expect(
        prisma.kgProposal.create({
          data: {
            ownerId: owner.id,
            kind: 'extraction',
            noteId: note.id,
            noteVersion: 1,
            status: 'committed',
          },
        }),
      ).resolves.toMatchObject({ status: 'committed' });
    });

    it('rejects a second extracting proposal for the same note', async () => {
      const owner = await createUser('proposal-extracting-uniq');
      const note = await prisma.note.create({
        data: { ownerId: owner.id, title: 'Note', body: 'Body', status: 'ready', sourceType: 'document' },
      });

      await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'extraction', noteId: note.id, noteVersion: 1, status: 'extracting' },
      });
      await expect(
        prisma.kgProposal.create({
          data: { ownerId: owner.id, kind: 'extraction', noteId: note.id, noteVersion: 1, status: 'extracting' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rejects a second extracting import proposal for the same owner', async () => {
      const owner = await createUser('proposal-import-extracting-uniq');

      await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'import', status: 'extracting' },
      });
      await expect(
        prisma.kgProposal.create({
          data: { ownerId: owner.id, kind: 'import', status: 'extracting' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('kg_items_live_statement_uniq_idx: rejects the same hash while accepted, allows it once rejected', async () => {
      const owner = await createUser('item-live-statement-uniq');
      const subject = await createEntity(owner.id);
      const hash = randomUUID();

      const first = await prisma.kgItem.create({
        data: {
          ownerId: owner.id,
          kind: 'claim',
          subjectId: subject.id,
          statement: 'Revenue grew 20%',
          status: 'active',
          statementHash: hash,
          ontologyVersion: 'test-v1',
        },
      });

      // A verbatim restatement while the first is still accepted is refused
      // by the index — the "known, skipped" §8 dedup guard.
      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'claim',
            subjectId: subject.id,
            statement: 'Revenue grew 20%',
            status: 'active',
            statementHash: hash,
            ontologyVersion: 'test-v1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      // Once the first is rejected, a fresh row with the identical hash is
      // no longer blocked.
      await prisma.kgItem.update({ where: { id: first.id }, data: { reviewStatus: 'rejected' } });
      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'claim',
            subjectId: subject.id,
            statement: 'Revenue grew 20%',
            status: 'active',
            statementHash: hash,
            ontologyVersion: 'test-v1',
          },
        }),
      ).resolves.toMatchObject({ statementHash: hash });
    });
  });

  // ===========================================================================
  // EXPLAIN plan assertions — the index must actually be USED, not merely
  // present (mirrors search_embeddings_embedding_hnsw_idx's own discipline).
  // ===========================================================================

  describe('EXPLAIN plans actually use the hand-written indexes', () => {
    it('uses kg_entity_aliases_normalized_trgm_idx for a similarity search', async () => {
      const owner = await createUser('explain-trgm');
      const entity = await createEntity(owner.id);
      await prisma.kgEntityAlias.create({
        data: { entityId: entity.id, ownerId: owner.id, alias: 'Sarah Chen', normalized: 'sarah chen', source: 'user' },
      });

      await prisma.$executeRaw`SET enable_seqscan = off`;
      try {
        const rows = await prisma.$queryRaw<Array<{ plan: string }>>`
          EXPLAIN SELECT * FROM "kg_entity_aliases" WHERE "normalized" % 'sarah chen'
        `;
        const plan = rows.map((r) => Object.values(r)[0]).join('\n');
        expect(plan).toContain('kg_entity_aliases_normalized_trgm_idx');
      } finally {
        await prisma.$executeRaw`SET enable_seqscan = on`;
      }
    });

    it('uses kg_relations_valid_gist_idx for a range-containment query', async () => {
      const owner = await createUser('explain-gist');
      const from = await createEntity(owner.id);
      const to = await createEntity(owner.id, { label: 'Acme Corp', type: 'organization' });
      const relation = await prisma.kgRelation.create({
        data: { ownerId: owner.id, type: 'WORKS_AT', fromId: from.id, toId: to.id, ontologyVersion: 'test-v1' },
      });
      await prisma.$executeRaw`
        UPDATE "kg_relations" SET "valid" = tstzrange('2019-01-01', '2026-03-01', '[)'), "valid_precision" = 'day'
        WHERE "id" = ${relation.id}::uuid
      `;

      await prisma.$executeRaw`SET enable_seqscan = off`;
      try {
        const rows = await prisma.$queryRaw<Array<{ plan: string }>>`
          EXPLAIN SELECT * FROM "kg_relations" WHERE "valid" @> now()
        `;
        const plan = rows.map((r) => Object.values(r)[0]).join('\n');
        expect(plan).toContain('kg_relations_valid_gist_idx');
      } finally {
        await prisma.$executeRaw`SET enable_seqscan = on`;
      }
    });
  });

  // ===========================================================================
  // tstzrange round-trip
  // ===========================================================================

  describe('tstzrange round-trip', () => {
    it('round-trips through lower()/upper()/upper_inf()', async () => {
      const owner = await createUser('tstzrange-roundtrip');
      const from = await createEntity(owner.id);
      const to = await createEntity(owner.id, { label: 'Acme Corp', type: 'organization' });
      const relation = await prisma.kgRelation.create({
        data: { ownerId: owner.id, type: 'WORKS_AT', fromId: from.id, toId: to.id, ontologyVersion: 'test-v1' },
      });

      await prisma.$executeRaw`
        UPDATE "kg_relations" SET "valid" = tstzrange('2019-01-01T00:00:00Z', '2026-03-01T00:00:00Z', '[)'), "valid_precision" = 'day'
        WHERE "id" = ${relation.id}::uuid
      `;

      const rows = await prisma.$queryRaw<
        Array<{ lower: Date; upper: Date; upper_inf: boolean }>
      >`
        SELECT lower("valid") AS lower, upper("valid") AS upper, upper_inf("valid") AS upper_inf
        FROM "kg_relations" WHERE "id" = ${relation.id}::uuid
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0].lower.toISOString()).toBe('2019-01-01T00:00:00.000Z');
      expect(rows[0].upper.toISOString()).toBe('2026-03-01T00:00:00.000Z');
      expect(rows[0].upper_inf).toBe(false);

      // An open-ended range (no closing date yet) reads back as upper_inf.
      await prisma.$executeRaw`
        UPDATE "kg_relations" SET "valid" = tstzrange('2019-01-01T00:00:00Z', NULL, '[)')
        WHERE "id" = ${relation.id}::uuid
      `;
      const openRows = await prisma.$queryRaw<Array<{ upper_inf: boolean }>>`
        SELECT upper_inf("valid") AS upper_inf FROM "kg_relations" WHERE "id" = ${relation.id}::uuid
      `;
      expect(openRows[0].upper_inf).toBe(true);
    });
  });

  // ===========================================================================
  // Cascade / SetNull behaviours
  // ===========================================================================

  describe('owner CASCADE deletes every kg_* row (no graph:read_any, §10)', () => {
    it('deletes entities, aliases, relations, items and proposals when the owner is deleted', async () => {
      const owner = await createUser('owner-cascade');
      const entity = await createEntity(owner.id);
      const alias = await prisma.kgEntityAlias.create({
        data: { entityId: entity.id, ownerId: owner.id, alias: 'S. Chen', normalized: 's chen', source: 'user' },
      });
      const to = await createEntity(owner.id, { label: 'Acme Corp', type: 'organization' });
      const relation = await prisma.kgRelation.create({
        data: { ownerId: owner.id, type: 'WORKS_AT', fromId: entity.id, toId: to.id, ontologyVersion: 'test-v1' },
      });
      const item = await prisma.kgItem.create({
        data: {
          ownerId: owner.id,
          kind: 'commitment',
          statement: 'Send the deck',
          status: 'open',
          statementHash: randomUUID(),
          ontologyVersion: 'test-v1',
        },
      });
      const proposal = await prisma.kgProposal.create({ data: { ownerId: owner.id, kind: 'import' } });

      await prisma.user.delete({ where: { id: owner.id } });

      await expect(prisma.kgEntity.findUnique({ where: { id: entity.id } })).resolves.toBeNull();
      await expect(prisma.kgEntityAlias.findUnique({ where: { id: alias.id } })).resolves.toBeNull();
      await expect(prisma.kgRelation.findUnique({ where: { id: relation.id } })).resolves.toBeNull();
      await expect(prisma.kgItem.findUnique({ where: { id: item.id } })).resolves.toBeNull();
      await expect(prisma.kgProposal.findUnique({ where: { id: proposal.id } })).resolves.toBeNull();
    });
  });

  describe('kg_evidence SetNulls its transcript/segment/note pointers on delete, keeping quote', () => {
    it('nulls transcript_id/segment_id when the transcript is deleted', async () => {
      const owner = await createUser('evidence-transcript-setnull');
      const source = await prisma.storageObject.create({
        data: {
          name: 'r.m4a',
          size: BigInt(1),
          mimeType: 'audio/mp4',
          storageKey: `kg-schema-test/${randomUUID()}`,
          managedBy: 'transcripts',
          uploadedById: owner.id,
        },
      });
      const transcript = await prisma.transcript.create({
        data: { ownerId: owner.id, title: 'T', sourceObjectId: source.id, provider: 'assemblyai' },
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
          text: 'Hello world',
          words: [],
        },
      });
      const evidence = await prisma.kgEvidence.create({
        data: {
          ownerId: owner.id,
          subjectKind: 'entity',
          subjectId: randomUUID(),
          transcriptId: transcript.id,
          segmentId: segment.id,
          quote: 'Hello world',
        },
      });

      await prisma.transcript.delete({ where: { id: transcript.id } });

      await expect(prisma.kgEvidence.findUniqueOrThrow({ where: { id: evidence.id } })).resolves.toMatchObject({
        transcriptId: null,
        segmentId: null,
        quote: 'Hello world',
      });

      await prisma.storageObject.delete({ where: { id: source.id } });
    });

    it('nulls note_id when the note is deleted', async () => {
      const owner = await createUser('evidence-note-setnull');
      const note = await prisma.note.create({
        data: { ownerId: owner.id, title: 'Note', body: 'Body', status: 'ready', sourceType: 'document' },
      });
      const evidence = await prisma.kgEvidence.create({
        data: {
          ownerId: owner.id,
          subjectKind: 'entity',
          subjectId: randomUUID(),
          noteId: note.id,
          noteVersion: 1,
          quote: 'a quoted line',
        },
      });

      await prisma.note.delete({ where: { id: note.id } });

      await expect(prisma.kgEvidence.findUniqueOrThrow({ where: { id: evidence.id } })).resolves.toMatchObject({
        noteId: null,
        quote: 'a quoted line',
      });
    });
  });

  describe('kg_mentions CASCADEs on note/transcript deletion', () => {
    it('deletes the mention when its note is deleted', async () => {
      const owner = await createUser('mention-note-cascade');
      const entity = await createEntity(owner.id);
      const note = await prisma.note.create({
        data: { ownerId: owner.id, title: 'Note', body: 'Body', status: 'ready', sourceType: 'document' },
      });
      const mention = await prisma.kgMention.create({
        data: { ownerId: owner.id, entityId: entity.id, noteId: note.id },
      });

      await prisma.note.delete({ where: { id: note.id } });

      await expect(prisma.kgMention.findUnique({ where: { id: mention.id } })).resolves.toBeNull();
    });
  });
});
