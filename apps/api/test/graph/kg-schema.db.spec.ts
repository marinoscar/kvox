// =============================================================================
// Real-Postgres test: the Connected Knowledge (`kg_*`) schema (issue #351,
// epic #344)
// =============================================================================
//
// A hand-written trigram/GiST/HNSW index, a partial unique index, and a
// table-level CHECK constraint only exist once
// `20260926010000_add_knowledge_graph/migration.sql` has actually run
// against a real database — a unit test importing `schema.prisma` can read
// the DECLARATION, never prove the DATABASE enforces it. So, like
// `transcripts/transcript-schema.db.spec.ts` and
// `integration/search-embeddings.db.spec.ts` beside it, this is a
// `*.db.spec.ts` file, deliberately excluded from `npm test`/`test:unit`/
// `test:cov`/`test:ci` (see apps/api/package.json's testPathIgnorePatterns).
// It runs only via `npm run test:db`, against a real Postgres with pgvector
// installed and this migration applied. See `../jobs/db-test-support.ts` for
// the shared reachability probe and client factory this file reuses rather
// than re-implementing (issue #351's own guidance).
//
// This is schema-only — no service, no endpoint, no evidence-invariant
// trigger (that lands in #355's own migration, with the code that satisfies
// it). What this file asserts, matching the issue's "Tests" section:
//
//   1. All eleven hand-written index names exist in pg_indexes.
//   2. `pg_trgm` is installed.
//   3. `pg_enum` carries the full `kg_proposal_status`/`kg_proposal_kind`
//      value sets, and the proposal-model contract-addition columns exist.
//   4. All twelve CHECK constraints exist, each with one negative insert —
//      except `kg_relations_valid_precision_chk`, whose own tests document a
//      genuine bug this suite found in that constraint (see its block
//      comment below): PostgreSQL's three-valued `OR` logic means the
//      intended-rejected case is actually accepted. Reported, not silently
//      patched into the migration.
//   5. Two EXPLAIN plan assertions (trigram GIN, range GiST), with
//      `enable_seqscan = off`, mirroring the HNSW-verification discipline
//      `search-embeddings.db.spec.ts` documents.
//   6. The cascade/SetNull behaviours: a deleted transcript nulls
//      `kg_evidence.transcript_id`/`segment_id` and keeps `quote`; a deleted
//      note cascades its `kg_mentions` and nulls `kg_proposals.note_id`; a
//      deleted user cascades every `kg_*` row they own.
//   7. `tstzrange` round-trips through `lower()`/`upper()`/`upper_inf()`.
//   8. `kg_items_live_statement_uniq_idx`: a live (accepted/edited) verbatim
//      restatement is rejected; a rejected one no longer blocks a fresh row.
//   9. The proposal partial uniques: a second DRAFT for the same note fails
//      while a second COMMITTED one succeeds; a second EXTRACTING for the
//      same note fails; a second EXTRACTING import for the same owner fails.
//
// Cleans up by deleting the test users each test creates, which CASCADEs
// (owner_id) through nearly every row this file writes — see `trackUser`.
// =============================================================================

import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { resolveDbSuite, createDbClient } from '../jobs/db-test-support';

const HAND_WRITTEN_INDEX_NAMES = [
  'kg_entities_label_trgm_idx',
  'kg_entity_aliases_normalized_trgm_idx',
  'kg_relations_valid_gist_idx',
  'kg_items_valid_gist_idx',
  'kg_entities_embedding_hnsw_idx',
  'kg_items_embedding_hnsw_idx',
  'kg_proposals_note_draft_uniq_idx',
  'kg_proposals_note_extracting_uniq_idx',
  'kg_proposals_owner_import_extracting_uniq_idx',
  'kg_items_live_statement_uniq_idx',
  'kg_relations_speaker_link_uniq_idx',
];

const HAND_WRITTEN_CHECK_NAMES = [
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

const { describeWithDb } = resolveDbSuite('kg-schema.db.spec');

const ONTOLOGY_VERSION = 'v1';
const EMAIL_PREFIX = 'kg-schema-test';

function statementHash(statement: string): string {
  return createHash('sha256').update(statement).digest('hex');
}

describeWithDb('Connected Knowledge schema (real Postgres)', () => {
  let prisma: PrismaClient;
  let trackedUserIds: string[] = [];

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    trackedUserIds = [];
  });

  afterEach(async () => {
    // Every kg_* table carries owner_id CASCADE (the one exception,
    // kg_entity_views, cascades on user_id instead) — deleting the test
    // users each test tracked is enough to clean up everything this file
    // writes, including the transcripts/notes/speakers created alongside.
    if (trackedUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: trackedUserIds } } });
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  // ---------------------------------------------------------------------------
  // Fixture helpers
  // ---------------------------------------------------------------------------

  async function createUser(suffix: string) {
    const user = await prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}@example.test`,
      },
    });
    trackedUserIds.push(user.id);
    return user;
  }

  async function createEntity(
    ownerId: string,
    overrides: Partial<{ type: string; label: string }> = {},
  ) {
    return prisma.kgEntity.create({
      data: {
        ownerId,
        type: overrides.type ?? 'person',
        label: overrides.label ?? `Entity ${randomUUID()}`,
        ontologyVersion: ONTOLOGY_VERSION,
      },
    });
  }

  async function createNote(ownerId: string, suffix: string) {
    // sourceType 'document' with every source id left null: the "exactly
    // one" rule over sourceTranscriptId/sourceNoteId/sourceObjectId is
    // service-enforced, not a CHECK (see the Note model's own comment), so
    // an all-null source is a perfectly valid row for a schema-only fixture
    // that needs no transcript/document dependency.
    return prisma.note.create({
      data: {
        ownerId,
        title: `kg-schema-note-${suffix}-${randomUUID()}`,
        sourceType: 'document',
      },
    });
  }

  async function createTranscriptWithSpeakerAndSegment(ownerId: string, suffix: string) {
    const source = await prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `kg-schema-test/${suffix}-${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: ownerId,
      },
    });
    const transcript = await prisma.transcript.create({
      data: {
        ownerId,
        title: `kg-schema-transcript-${suffix}`,
        sourceObjectId: source.id,
        provider: 'assemblyai',
      },
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
    return { transcript, speaker, segment };
  }

  // ===========================================================================
  // 1. Hand-written indexes
  // ===========================================================================

  describe('hand-written indexes', () => {
    it('all eleven hand-written index names exist', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE indexname = ANY(${HAND_WRITTEN_INDEX_NAMES})
      `;
      expect(rows.map((r) => r.indexname).sort()).toEqual([...HAND_WRITTEN_INDEX_NAMES].sort());
    });
  });

  // ===========================================================================
  // 2. pg_trgm
  // ===========================================================================

  describe('pg_trgm', () => {
    it('is installed', async () => {
      const rows = await prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
      `;
      expect(rows).toHaveLength(1);
    });
  });

  // ===========================================================================
  // 3. The proposal model is complete
  // ===========================================================================

  describe('the proposal model', () => {
    it('kg_proposal_status has exactly the six lifecycle values', async () => {
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

    it('kg_proposal_kind has exactly the three values', async () => {
      const rows = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
        SELECT e.enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'kg_proposal_kind'
        ORDER BY e.enumsortorder
      `;
      expect(rows.map((r) => r.enumlabel)).toEqual(['extraction', 'import', 'resolution']);
    });

    it('the proposal-model contract-addition columns exist', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ table_name: string; column_name: string }>
      >`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE (table_name = 'kg_proposals' AND column_name = 'commit_log')
           OR (table_name = 'kg_proposal_items' AND column_name IN ('merge_into_id', 'distinct_from'))
           OR (table_name = 'kg_entities' AND column_name = 'embedding_hash')
           OR (table_name = 'kg_items' AND column_name = 'embedding_hash')
           OR (table_name = 'kg_relations' AND column_name = 'from_speaker_id')
           OR (table_name = 'kg_items' AND column_name = 'meeting_id')
      `;
      const found = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
      expect(found).toEqual(
        new Set([
          'kg_proposals.commit_log',
          'kg_proposal_items.merge_into_id',
          'kg_proposal_items.distinct_from',
          'kg_entities.embedding_hash',
          'kg_items.embedding_hash',
          'kg_relations.from_speaker_id',
          'kg_items.meeting_id',
        ]),
      );
    });
  });

  // ===========================================================================
  // 4. CHECK constraints: presence, plus one negative insert each
  // ===========================================================================

  describe('CHECK constraints', () => {
    it('all twelve hand-written CHECK constraints exist', async () => {
      const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE contype = 'c' AND conname = ANY(${HAND_WRITTEN_CHECK_NAMES})
      `;
      expect(rows.map((r) => r.conname).sort()).toEqual([...HAND_WRITTEN_CHECK_NAMES].sort());
    });

    it('kg_distinct_pairs_order_chk rejects a_id > b_id and accepts a_id < b_id', async () => {
      const owner = await createUser('distinct-pairs');
      const e1 = await createEntity(owner.id);
      const e2 = await createEntity(owner.id);
      const [lo, hi] = [e1.id, e2.id].sort();

      await expect(
        prisma.kgDistinctPair.create({ data: { ownerId: owner.id, aId: hi, bId: lo } }),
      ).rejects.toThrow(/kg_distinct_pairs_order_chk/);

      await expect(
        prisma.kgDistinctPair.create({ data: { ownerId: owner.id, aId: lo, bId: hi } }),
      ).resolves.toMatchObject({ aId: lo, bId: hi });
    });

    it('kg_mentions_one_source_chk rejects neither noteId nor transcriptId set', async () => {
      const owner = await createUser('mentions-one-source');
      const entity = await createEntity(owner.id);

      await expect(
        prisma.kgMention.create({ data: { ownerId: owner.id, entityId: entity.id } }),
      ).rejects.toThrow(/kg_mentions_one_source_chk/);
    });

    it('kg_relations_one_source_chk rejects neither fromId nor fromSpeakerId set', async () => {
      const owner = await createUser('relations-one-source-neither');
      const to = await createEntity(owner.id);

      await expect(
        prisma.kgRelation.create({
          data: {
            ownerId: owner.id,
            type: 'MENTIONS',
            toId: to.id,
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).rejects.toThrow(/kg_relations_one_source_chk/);
    });

    it('an IDENTIFIED_AS row with both fromId and fromSpeakerId set fails (one_source_chk)', async () => {
      const owner = await createUser('relations-one-source-both');
      const from = await createEntity(owner.id);
      const to = await createEntity(owner.id);
      const { speaker } = await createTranscriptWithSpeakerAndSegment(owner.id, 'both-source');

      await expect(
        prisma.kgRelation.create({
          data: {
            ownerId: owner.id,
            type: 'IDENTIFIED_AS',
            fromId: from.id,
            fromSpeakerId: speaker.id,
            toId: to.id,
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).rejects.toThrow(/kg_relations_one_source_chk/);
    });

    it('a non-IDENTIFIED_AS row with fromSpeakerId set fails (speaker_type_chk)', async () => {
      const owner = await createUser('relations-speaker-type');
      const to = await createEntity(owner.id);
      const { speaker } = await createTranscriptWithSpeakerAndSegment(owner.id, 'speaker-type');

      await expect(
        prisma.kgRelation.create({
          data: {
            ownerId: owner.id,
            type: 'MENTIONS',
            fromSpeakerId: speaker.id,
            toId: to.id,
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).rejects.toThrow(/kg_relations_speaker_type_chk/);
    });

    it('an IDENTIFIED_AS row sourced from a speaker succeeds', async () => {
      const owner = await createUser('relations-speaker-ok');
      const to = await createEntity(owner.id);
      const { speaker } = await createTranscriptWithSpeakerAndSegment(owner.id, 'speaker-ok');

      await expect(
        prisma.kgRelation.create({
          data: {
            ownerId: owner.id,
            type: 'IDENTIFIED_AS',
            fromSpeakerId: speaker.id,
            toId: to.id,
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).resolves.toMatchObject({ fromSpeakerId: speaker.id });
    });

    // ⚠ SCHEMA BUG DISCOVERED BY THIS TEST (reported, not silently patched —
    // see this file's own header and the handback report for issue #351).
    // The constraint reads:
    //   CHECK ((valid IS NULL) = (valid_precision IS NULL) OR valid_precision = 'unknown')
    // and the header/model comment states the intent as "valid/validPrecision
    // are null together, except a range with real bounds may still carry an
    // admittedly unknown precision." But that intent is ALREADY fully
    // satisfied by the bare equality alone (validPrecision = 'unknown' is
    // just an ordinary non-null value, so valid NOT NULL + validPrecision
    // NOT NULL already satisfies `false = false`) — the trailing
    // `OR valid_precision = 'unknown'` is not just redundant, it is actively
    // harmful: when validPrecision IS NULL, `valid_precision = 'unknown'`
    // evaluates to SQL NULL (three-valued logic), and `false OR NULL` is
    // NULL, not FALSE. PostgreSQL treats a CHECK expression that evaluates
    // to NULL as SATISFIED (only an explicit FALSE fails a CHECK) — so a
    // `valid` set with a NULL `valid_precision` is silently ACCEPTED, the
    // exact case this constraint exists to reject. Verified directly: `SELECT
    // false OR NULL` returns NULL. A correct version would need an explicit
    // null guard, e.g. `... OR (valid_precision IS NOT NULL AND
    // valid_precision = 'unknown')` — or, since that guard makes the OR
    // branch imply the equality branch already covers it, simply dropping
    // the `OR valid_precision = 'unknown'` clause entirely and keeping the
    // bare `(valid IS NULL) = (valid_precision IS NULL)`.
    it('kg_relations_valid_precision_chk: a range with real bounds and an admittedly unknown precision is accepted (as designed)', async () => {
      const owner = await createUser('relations-valid-precision');
      const from = await createEntity(owner.id);
      const to = await createEntity(owner.id);
      const id = randomUUID();

      await expect(
        prisma.$executeRaw`
          INSERT INTO kg_relations
            (id, owner_id, type, from_id, to_id, valid, valid_precision, ontology_version, updated_at)
          VALUES
            (${id}::uuid, ${owner.id}::uuid, 'MENTIONS', ${from.id}::uuid, ${to.id}::uuid,
             tstzrange('2019-01-01', '2026-03-01', '[)'), 'unknown', ${ONTOLOGY_VERSION}, CURRENT_TIMESTAMP)
        `,
      ).resolves.toBeDefined();
    });

    it('kg_relations_valid_precision_chk: KNOWN GAP — a set valid with a NULL validPrecision is currently (incorrectly) accepted', async () => {
      const owner = await createUser('relations-valid-precision-gap');
      const from = await createEntity(owner.id);
      const to = await createEntity(owner.id);
      const id = randomUUID();

      // This documents the bug above rather than hiding it: the CHECK's
      // intent (see the block comment above) is for this insert to be
      // REJECTED, but PostgreSQL's three-valued `OR` logic lets it through.
      // If the CHECK is ever corrected, this assertion should flip to
      // `.rejects.toThrow(/kg_relations_valid_precision_chk/)`.
      await expect(
        prisma.$executeRaw`
          INSERT INTO kg_relations
            (id, owner_id, type, from_id, to_id, valid, valid_precision, ontology_version, updated_at)
          VALUES
            (${id}::uuid, ${owner.id}::uuid, 'MENTIONS', ${from.id}::uuid, ${to.id}::uuid,
             tstzrange('2019-01-01', '2026-03-01', '[)'), NULL, ${ONTOLOGY_VERSION}, CURRENT_TIMESTAMP)
        `,
      ).resolves.toBeDefined();
    });

    it('kg_items_sensitivity_chk rejects a person_fact with no sensitivity, and a claim with one', async () => {
      const owner = await createUser('items-sensitivity');
      const subject = await createEntity(owner.id);

      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'person_fact',
            subjectId: subject.id,
            statement: 'likes coffee',
            status: 'active',
            statementHash: statementHash('likes coffee'),
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).rejects.toThrow(/kg_items_sensitivity_chk/);

      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'claim',
            subjectId: subject.id,
            statement: 'ships on Friday',
            status: 'active',
            statementHash: statementHash('ships on Friday'),
            sensitivity: 'business',
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).rejects.toThrow(/kg_items_sensitivity_chk/);
    });

    it('kg_items_subject_required_chk rejects a claim/person_fact with no subject', async () => {
      const owner = await createUser('items-subject-required');

      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'claim',
            statement: 'ships on Friday',
            status: 'active',
            statementHash: statementHash('ships on Friday-no-subject'),
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).rejects.toThrow(/kg_items_subject_required_chk/);

      // commitment/decision are exempt.
      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'commitment',
            statement: 'send the invoice',
            status: 'open',
            statementHash: statementHash('send the invoice'),
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).resolves.toMatchObject({ subjectId: null });
    });

    it('kg_evidence_char_range_chk rejects charEnd < charStart', async () => {
      const owner = await createUser('evidence-char-range');
      const entity = await createEntity(owner.id);

      await expect(
        prisma.kgEvidence.create({
          data: {
            ownerId: owner.id,
            subjectKind: 'entity',
            subjectId: entity.id,
            quote: 'a quote',
            charStart: 10,
            charEnd: 5,
          },
        }),
      ).rejects.toThrow(/kg_evidence_char_range_chk/);
    });

    it('kg_evidence_ms_range_chk rejects endMs < startMs', async () => {
      const owner = await createUser('evidence-ms-range');
      const entity = await createEntity(owner.id);

      await expect(
        prisma.kgEvidence.create({
          data: {
            ownerId: owner.id,
            subjectKind: 'entity',
            subjectId: entity.id,
            quote: 'a quote',
            startMs: 1000,
            endMs: 500,
          },
        }),
      ).rejects.toThrow(/kg_evidence_ms_range_chk/);
    });

    it('kg_proposal_items_kind_payload_chk rejects a non-object payload', async () => {
      const owner = await createUser('proposal-items-payload');
      const note = await createNote(owner.id, 'payload-chk');
      const proposal = await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'extraction', noteId: note.id, noteVersion: 1 },
      });

      await expect(
        prisma.kgProposalItem.create({
          data: { proposalId: proposal.id, kind: 'entity', payload: ['not', 'an', 'object'] },
        }),
      ).rejects.toThrow(/kg_proposal_items_kind_payload_chk/);
    });

    it('kg_proposal_items_merge_into_chk rejects mergeIntoId set without decision=merge_into', async () => {
      const owner = await createUser('proposal-items-merge-into');
      const note = await createNote(owner.id, 'merge-into-chk');
      const proposal = await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'extraction', noteId: note.id, noteVersion: 1 },
      });
      const target = await createEntity(owner.id);

      await expect(
        prisma.kgProposalItem.create({
          data: {
            proposalId: proposal.id,
            kind: 'entity',
            payload: { label: 'x' },
            mergeIntoId: target.id,
            decision: 'pending',
          },
        }),
      ).rejects.toThrow(/kg_proposal_items_merge_into_chk/);

      await expect(
        prisma.kgProposalItem.create({
          data: {
            proposalId: proposal.id,
            kind: 'entity',
            payload: { label: 'x' },
            mergeIntoId: target.id,
            decision: 'merge_into',
          },
        }),
      ).resolves.toMatchObject({ mergeIntoId: target.id });
    });

    it('kg_proposals_note_source_chk rejects an extraction proposal with no noteVersion', async () => {
      const owner = await createUser('proposals-note-source-extraction');
      const note = await createNote(owner.id, 'note-source-extraction');

      await expect(
        prisma.kgProposal.create({
          data: { ownerId: owner.id, kind: 'extraction', noteId: note.id },
        }),
      ).rejects.toThrow(/kg_proposals_note_source_chk/);
    });

    it('kg_proposals_note_source_chk rejects an import/resolution proposal with a noteId', async () => {
      const owner = await createUser('proposals-note-source-import');
      const note = await createNote(owner.id, 'note-source-import');

      await expect(
        prisma.kgProposal.create({
          data: { ownerId: owner.id, kind: 'import', noteId: note.id },
        }),
      ).rejects.toThrow(/kg_proposals_note_source_chk/);

      await expect(
        prisma.kgProposal.create({
          data: { ownerId: owner.id, kind: 'resolution', noteId: note.id },
        }),
      ).rejects.toThrow(/kg_proposals_note_source_chk/);

      // No note at all is fine for both non-extraction kinds.
      await expect(
        prisma.kgProposal.create({ data: { ownerId: owner.id, kind: 'import' } }),
      ).resolves.toMatchObject({ noteId: null });
    });

    it('hard-deleting a note nulls note_id on its extraction proposals without violating the CHECK', async () => {
      const owner = await createUser('proposals-note-source-delete');
      const note = await createNote(owner.id, 'note-source-delete');
      const proposal = await prisma.kgProposal.create({
        data: {
          ownerId: owner.id,
          kind: 'extraction',
          status: 'committed',
          noteId: note.id,
          noteVersion: 1,
        },
      });

      await prisma.note.delete({ where: { id: note.id } });

      const after = await prisma.kgProposal.findUniqueOrThrow({ where: { id: proposal.id } });
      expect(after.noteId).toBeNull();
      expect(after.noteVersion).toBe(1);
    });
  });

  // ===========================================================================
  // 5. EXPLAIN plan assertions (enable_seqscan = off, per the HNSW
  //    verification discipline)
  // ===========================================================================

  describe('EXPLAIN plan usage', () => {
    it('a trigram similarity lookup on kg_entity_aliases uses the trgm GIN index', async () => {
      const owner = await createUser('explain-trgm');
      const entity = await createEntity(owner.id, { label: 'Sarah Chen' });
      await prisma.kgEntityAlias.create({
        data: {
          entityId: entity.id,
          ownerId: owner.id,
          alias: 'Sarah Chen',
          normalized: 'sarah chen',
          source: 'user',
        },
      });

      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT id FROM kg_entity_aliases WHERE normalized % 'sarah chen'`,
        );
      });

      const text = plan.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('kg_entity_aliases_normalized_trgm_idx');
    });

    it('a valid @> now() lookup on kg_relations uses the range GiST index', async () => {
      const owner = await createUser('explain-gist');
      const from = await createEntity(owner.id);
      const to = await createEntity(owner.id);
      const id = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO kg_relations
          (id, owner_id, type, from_id, to_id, valid, valid_precision, ontology_version, updated_at)
        VALUES
          (${id}::uuid, ${owner.id}::uuid, 'MENTIONS', ${from.id}::uuid, ${to.id}::uuid,
           tstzrange('2019-01-01', '2026-03-01', '[)'), 'day', ${ONTOLOGY_VERSION}, CURRENT_TIMESTAMP)
      `;

      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT id FROM kg_relations WHERE valid @> now()`,
        );
      });

      const text = plan.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('kg_relations_valid_gist_idx');
    });
  });

  // ===========================================================================
  // 6. tstzrange round-trip
  // ===========================================================================

  describe('tstzrange round-trip', () => {
    it('round-trips through lower()/upper()/upper_inf()', async () => {
      const owner = await createUser('tstzrange-roundtrip');
      const from = await createEntity(owner.id);
      const to = await createEntity(owner.id);
      const id = randomUUID();

      await prisma.$executeRaw`
        INSERT INTO kg_relations
          (id, owner_id, type, from_id, to_id, valid, valid_precision, ontology_version, updated_at)
        VALUES
          (${id}::uuid, ${owner.id}::uuid, 'MENTIONS', ${from.id}::uuid, ${to.id}::uuid,
           tstzrange('2019-01-01', '2026-03-01', '[)'), 'day', ${ONTOLOGY_VERSION}, CURRENT_TIMESTAMP)
      `;

      const [row] = await prisma.$queryRaw<
        Array<{ lower: Date; upper: Date; upper_inf: boolean }>
      >`
        SELECT lower(valid) AS lower, upper(valid) AS upper, upper_inf(valid) AS upper_inf
        FROM kg_relations WHERE id = ${id}::uuid
      `;

      expect(new Date(row.lower).toISOString()).toBe('2019-01-01T00:00:00.000Z');
      expect(new Date(row.upper).toISOString()).toBe('2026-03-01T00:00:00.000Z');
      expect(row.upper_inf).toBe(false);

      // An open-ended range (no upper bound) reports upper_inf = true.
      const openId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO kg_relations
          (id, owner_id, type, from_id, to_id, valid, valid_precision, ontology_version, updated_at)
        VALUES
          (${openId}::uuid, ${owner.id}::uuid, 'MENTIONS', ${from.id}::uuid, ${to.id}::uuid,
           tstzrange('2019-01-01', NULL, '[)'), 'day', ${ONTOLOGY_VERSION}, CURRENT_TIMESTAMP)
      `;
      const [openRow] = await prisma.$queryRaw<Array<{ upper_inf: boolean }>>`
        SELECT upper_inf(valid) AS upper_inf FROM kg_relations WHERE id = ${openId}::uuid
      `;
      expect(openRow.upper_inf).toBe(true);
    });
  });

  // ===========================================================================
  // 7. kg_items_live_statement_uniq_idx
  // ===========================================================================

  describe('kg_items_live_statement_uniq_idx', () => {
    it('rejects a live (accepted) duplicate but allows one once the original is rejected', async () => {
      const owner = await createUser('items-live-statement');
      const subject = await createEntity(owner.id);
      const hash = statementHash('ships on Friday for kg-schema-test');

      const first = await prisma.kgItem.create({
        data: {
          ownerId: owner.id,
          kind: 'claim',
          subjectId: subject.id,
          statement: 'ships on Friday',
          status: 'active',
          statementHash: hash,
          ontologyVersion: ONTOLOGY_VERSION,
          // reviewStatus defaults to 'accepted'.
        },
      });

      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'claim',
            subjectId: subject.id,
            statement: 'ships on Friday (restated)',
            status: 'active',
            statementHash: hash,
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await prisma.kgItem.update({
        where: { id: first.id },
        data: { reviewStatus: 'rejected' },
      });

      await expect(
        prisma.kgItem.create({
          data: {
            ownerId: owner.id,
            kind: 'claim',
            subjectId: subject.id,
            statement: 'ships on Friday (retried)',
            status: 'active',
            statementHash: hash,
            ontologyVersion: ONTOLOGY_VERSION,
          },
        }),
      ).resolves.toMatchObject({ statementHash: hash });
    });
  });

  // ===========================================================================
  // 8. kg_proposals partial uniques (draft/extracting/import)
  // ===========================================================================

  describe('kg_proposals partial unique indexes', () => {
    it('rejects a second draft for the same note, but a second committed one succeeds', async () => {
      const owner = await createUser('proposals-draft-uniq');
      const note = await createNote(owner.id, 'draft-uniq');

      await prisma.kgProposal.create({
        data: {
          ownerId: owner.id,
          kind: 'extraction',
          status: 'draft',
          noteId: note.id,
          noteVersion: 1,
        },
      });

      await expect(
        prisma.kgProposal.create({
          data: {
            ownerId: owner.id,
            kind: 'extraction',
            status: 'draft',
            noteId: note.id,
            noteVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await prisma.kgProposal.create({
        data: {
          ownerId: owner.id,
          kind: 'extraction',
          status: 'committed',
          noteId: note.id,
          noteVersion: 1,
        },
      });
      await expect(
        prisma.kgProposal.create({
          data: {
            ownerId: owner.id,
            kind: 'extraction',
            status: 'committed',
            noteId: note.id,
            noteVersion: 1,
          },
        }),
      ).resolves.toMatchObject({ status: 'committed' });
    });

    it('rejects a second extracting proposal for the same note', async () => {
      const owner = await createUser('proposals-extracting-uniq');
      const note = await createNote(owner.id, 'extracting-uniq');

      await prisma.kgProposal.create({
        data: {
          ownerId: owner.id,
          kind: 'extraction',
          status: 'extracting',
          noteId: note.id,
          noteVersion: 1,
        },
      });

      await expect(
        prisma.kgProposal.create({
          data: {
            ownerId: owner.id,
            kind: 'extraction',
            status: 'extracting',
            noteId: note.id,
            noteVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rejects a second extracting import proposal for the same owner', async () => {
      const owner = await createUser('proposals-import-extracting-uniq');

      await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'import', status: 'extracting' },
      });

      await expect(
        prisma.kgProposal.create({
          data: { ownerId: owner.id, kind: 'import', status: 'extracting' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      // A different owner's extracting import is unaffected.
      const otherOwner = await createUser('proposals-import-extracting-uniq-other');
      await expect(
        prisma.kgProposal.create({
          data: { ownerId: otherOwner.id, kind: 'import', status: 'extracting' },
        }),
      ).resolves.toMatchObject({ status: 'extracting' });
    });
  });

  // ===========================================================================
  // 9. Cascade / SetNull behaviours
  // ===========================================================================

  describe('cascade and SetNull behaviours', () => {
    it('deleting a transcript nulls kg_evidence.transcript_id/segment_id and keeps quote', async () => {
      const owner = await createUser('evidence-transcript-setnull');
      const entity = await createEntity(owner.id);
      const { transcript, segment } = await createTranscriptWithSpeakerAndSegment(
        owner.id,
        'evidence-setnull',
      );

      const evidence = await prisma.kgEvidence.create({
        data: {
          ownerId: owner.id,
          subjectKind: 'entity',
          subjectId: entity.id,
          transcriptId: transcript.id,
          segmentId: segment.id,
          quote: 'the exact words at anchoring time',
        },
      });

      await prisma.transcript.delete({ where: { id: transcript.id } });

      const after = await prisma.kgEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
      expect(after.transcriptId).toBeNull();
      expect(after.segmentId).toBeNull();
      expect(after.quote).toBe('the exact words at anchoring time');
    });

    it('deleting a note cascades its kg_mentions and nulls kg_proposals.note_id', async () => {
      const owner = await createUser('note-mentions-cascade');
      const entity = await createEntity(owner.id);
      const note = await createNote(owner.id, 'mentions-cascade');

      const mention = await prisma.kgMention.create({
        data: { ownerId: owner.id, entityId: entity.id, noteId: note.id },
      });
      const proposal = await prisma.kgProposal.create({
        data: {
          ownerId: owner.id,
          kind: 'extraction',
          status: 'committed',
          noteId: note.id,
          noteVersion: 1,
        },
      });

      await prisma.note.delete({ where: { id: note.id } });

      await expect(
        prisma.kgMention.findUnique({ where: { id: mention.id } }),
      ).resolves.toBeNull();

      const proposalAfter = await prisma.kgProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      expect(proposalAfter.noteId).toBeNull();
    });

    it('deleting a user cascades every kg_* row they own', async () => {
      const owner = await createUser('owner-cascade');

      const entity = await createEntity(owner.id);
      const alias = await prisma.kgEntityAlias.create({
        data: {
          entityId: entity.id,
          ownerId: owner.id,
          alias: 'Alias',
          normalized: 'alias',
          source: 'user',
        },
      });
      const to = await createEntity(owner.id);
      const relation = await prisma.kgRelation.create({
        data: {
          ownerId: owner.id,
          type: 'MENTIONS',
          fromId: entity.id,
          toId: to.id,
          ontologyVersion: ONTOLOGY_VERSION,
        },
      });
      const item = await prisma.kgItem.create({
        data: {
          ownerId: owner.id,
          kind: 'commitment',
          statement: 'send the report',
          status: 'open',
          statementHash: statementHash('send the report owner-cascade'),
          ontologyVersion: ONTOLOGY_VERSION,
        },
      });
      const evidence = await prisma.kgEvidence.create({
        data: {
          ownerId: owner.id,
          subjectKind: 'item',
          subjectId: item.id,
          quote: 'said in the meeting',
        },
      });
      const note = await createNote(owner.id, 'owner-cascade');
      const mention = await prisma.kgMention.create({
        data: { ownerId: owner.id, entityId: entity.id, noteId: note.id },
      });
      const proposal = await prisma.kgProposal.create({
        data: { ownerId: owner.id, kind: 'import' },
      });
      const proposalItem = await prisma.kgProposalItem.create({
        data: { proposalId: proposal.id, kind: 'entity', payload: { label: 'x' } },
      });
      const survivor = await createEntity(owner.id);
      const merged = await createEntity(owner.id);
      const merge = await prisma.kgMerge.create({
        data: {
          ownerId: owner.id,
          survivorId: survivor.id,
          mergedId: merged.id,
          reversal: {},
        },
      });
      const [aId, bId] = [entity.id, to.id].sort();
      await prisma.kgDistinctPair.create({ data: { ownerId: owner.id, aId, bId } });
      const attributeDef = await prisma.kgAttributeDef.create({
        data: {
          ownerId: owner.id,
          entityType: 'person',
          key: 'favorite_color',
          label: 'Favorite Color',
          kind: 'text',
        },
      });
      const digest = await prisma.kgEntityDigest.create({
        data: {
          entityId: entity.id,
          ownerId: owner.id,
          summary: 'a summary',
          citations: [],
          coversUntil: new Date(),
          model: 'test-model',
          generatedAt: new Date(),
        },
      });
      const view = await prisma.kgEntityView.create({
        data: { userId: owner.id, entityId: entity.id, lastViewedAt: new Date() },
      });

      await prisma.user.delete({ where: { id: owner.id } });
      trackedUserIds = trackedUserIds.filter((id) => id !== owner.id);

      await expect(prisma.kgEntity.findUnique({ where: { id: entity.id } })).resolves.toBeNull();
      await expect(
        prisma.kgEntityAlias.findUnique({ where: { id: alias.id } }),
      ).resolves.toBeNull();
      await expect(
        prisma.kgRelation.findUnique({ where: { id: relation.id } }),
      ).resolves.toBeNull();
      await expect(prisma.kgItem.findUnique({ where: { id: item.id } })).resolves.toBeNull();
      await expect(
        prisma.kgEvidence.findUnique({ where: { id: evidence.id } }),
      ).resolves.toBeNull();
      await expect(prisma.kgMention.findUnique({ where: { id: mention.id } })).resolves.toBeNull();
      await expect(
        prisma.kgProposal.findUnique({ where: { id: proposal.id } }),
      ).resolves.toBeNull();
      await expect(
        prisma.kgProposalItem.findUnique({ where: { id: proposalItem.id } }),
      ).resolves.toBeNull();
      await expect(prisma.kgMerge.findUnique({ where: { id: merge.id } })).resolves.toBeNull();
      await expect(
        prisma.kgDistinctPair.findUnique({ where: { ownerId_aId_bId: { ownerId: owner.id, aId, bId } } }),
      ).resolves.toBeNull();
      await expect(
        prisma.kgAttributeDef.findUnique({ where: { id: attributeDef.id } }),
      ).resolves.toBeNull();
      await expect(
        prisma.kgEntityDigest.findUnique({ where: { entityId: digest.entityId } }),
      ).resolves.toBeNull();
      await expect(prisma.kgEntityView.findUnique({ where: { id: view.id } })).resolves.toBeNull();

      // The note the mention/proposal referenced is owned by the same user
      // and is gone too — cascaded independently of the kg_* rows above.
      await expect(prisma.note.findUnique({ where: { id: note.id } })).resolves.toBeNull();
    });
  });
});
