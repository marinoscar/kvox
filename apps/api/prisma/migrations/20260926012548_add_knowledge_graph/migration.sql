-- CreateEnum
CREATE TYPE "kg_review_status" AS ENUM ('unreviewed', 'accepted', 'edited', 'rejected', 'merged', 'superseded');

-- CreateEnum
CREATE TYPE "kg_valid_precision" AS ENUM ('day', 'month', 'year', 'unknown');

-- CreateEnum
CREATE TYPE "kg_item_kind" AS ENUM ('commitment', 'decision', 'claim', 'person_fact');

-- CreateEnum
CREATE TYPE "kg_sensitivity" AS ENUM ('business', 'personal', 'sensitive');

-- CreateEnum
CREATE TYPE "kg_alias_source" AS ENUM ('user', 'extraction', 'speaker_naming', 'import');

-- CreateEnum
CREATE TYPE "kg_evidence_subject_kind" AS ENUM ('entity', 'relation', 'item', 'proposal_item', 'import');

-- CreateEnum
CREATE TYPE "kg_mention_status" AS ENUM ('suggested', 'linked', 'new', 'ignored');

-- CreateEnum
CREATE TYPE "kg_proposal_kind" AS ENUM ('extraction', 'import', 'resolution');

-- CreateEnum
CREATE TYPE "kg_proposal_status" AS ENUM ('draft', 'extracting', 'committed', 'discarded', 'failed', 'reverted');

-- CreateEnum
CREATE TYPE "kg_proposal_item_kind" AS ENUM ('entity', 'relation', 'item', 'closing');

-- CreateEnum
CREATE TYPE "kg_proposal_item_decision" AS ENUM ('pending', 'accept', 'edit', 'reject', 'merge_into');

-- CreateEnum
CREATE TYPE "kg_proposal_item_origin" AS ENUM ('ai', 'user');

-- CreateEnum
CREATE TYPE "kg_attribute_kind" AS ENUM ('text', 'number', 'date', 'boolean', 'select', 'multi_select', 'url', 'entity_ref');

-- ⚠ INTENTIONAL OMISSION: `prisma migrate dev` also proposed `DROP INDEX`
-- for `notes_search_vector_idx`, `search_embeddings_embedding_hnsw_idx`,
-- `transcript_segments_search_vector_idx`, `transcripts_title_search_vector_idx`,
-- plus `ALTER TABLE … ALTER COLUMN "search_vector" DROP DEFAULT` on
-- `notes`/`transcript_segments`/`transcripts` — none of it touches this
-- migration's own tables. It is Prisma re-discovering the PRE-EXISTING
-- hand-written schema drift `search.md` §2 and `SearchEmbedding`'s own block
-- comment already document (generated `tsvector` columns and the HNSW index
-- have no Prisma DSL, so `schema.prisma` cannot describe them exactly as the
-- database has them) and proposing to "fix" it by dropping and reasserting
-- those objects. Per this repo's own rule for exactly this situation (see
-- the CLAUDE.md "Adding a Job Type"/`Job` model's index comments and every
-- prior hand-written-index migration), those lines are deleted here rather
-- than applied — do not restore them.

-- CreateTable
CREATE TABLE "kg_entities" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1536),
    "embedding_model" TEXT,
    "embedding_hash" TEXT,
    "review_status" "kg_review_status" NOT NULL DEFAULT 'accepted',
    "merged_into_id" UUID,
    "occurred_at" TIMESTAMPTZ,
    "ontology_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_entity_aliases" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "source" "kg_alias_source" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_entity_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_relations" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_id" UUID,
    "from_speaker_id" UUID,
    "to_id" UUID NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "valid" tstzrange,
    "valid_precision" "kg_valid_precision",
    "review_status" "kg_review_status" NOT NULL DEFAULT 'accepted',
    "confidence" DOUBLE PRECISION,
    "superseded_by_id" UUID,
    "ontology_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_items" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "kind" "kg_item_kind" NOT NULL,
    "subject_id" UUID,
    "meeting_id" UUID,
    "owner_person_id" UUID,
    "counterparty_id" UUID,
    "title" TEXT,
    "statement" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ,
    "due_at" TIMESTAMPTZ,
    "superseded_by_id" UUID,
    "sensitivity" "kg_sensitivity",
    "statement_hash" TEXT NOT NULL,
    "valid" tstzrange,
    "valid_precision" "kg_valid_precision",
    "embedding" vector(1536),
    "embedding_model" TEXT,
    "embedding_hash" TEXT,
    "review_status" "kg_review_status" NOT NULL DEFAULT 'accepted',
    "confidence" DOUBLE PRECISION,
    "ontology_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_evidence" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "subject_kind" "kg_evidence_subject_kind" NOT NULL,
    "subject_id" UUID NOT NULL,
    "transcript_id" UUID,
    "segment_id" UUID,
    "segment_rev" INTEGER,
    "start_ms" INTEGER,
    "end_ms" INTEGER,
    "note_id" UUID,
    "note_version" INTEGER,
    "char_start" INTEGER,
    "char_end" INTEGER,
    "quote" TEXT NOT NULL,
    "import_object_id" UUID,
    "source_iri" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_mentions" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "note_id" UUID,
    "transcript_id" UUID,
    "span" JSONB,
    "status" "kg_mention_status" NOT NULL DEFAULT 'linked',
    "score" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_proposals" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "kind" "kg_proposal_kind" NOT NULL,
    "status" "kg_proposal_status" NOT NULL DEFAULT 'draft',
    "note_id" UUID,
    "note_version" INTEGER,
    "model" TEXT,
    "provider" TEXT,
    "system_prompt" TEXT,
    "user_content" TEXT,
    "user_guidance" JSONB,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "committed_at" TIMESTAMPTZ,
    "reverted_at" TIMESTAMPTZ,
    "job_id" UUID,
    "commit_log" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_proposal_items" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "kind" "kg_proposal_item_kind" NOT NULL,
    "payload" JSONB NOT NULL,
    "resolution" JSONB,
    "edited_payload" JSONB,
    "decision" "kg_proposal_item_decision" NOT NULL DEFAULT 'pending',
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "origin" "kg_proposal_item_origin" NOT NULL DEFAULT 'ai',
    "merge_into_id" UUID,
    "distinct_from" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "committed_ref_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_proposal_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_merges" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "survivor_id" UUID NOT NULL,
    "merged_id" UUID NOT NULL,
    "reversal" JSONB NOT NULL,
    "reversed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_distinct_pairs" (
    "owner_id" UUID NOT NULL,
    "a_id" UUID NOT NULL,
    "b_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_distinct_pairs_pkey" PRIMARY KEY ("owner_id","a_id","b_id")
);

-- CreateTable
CREATE TABLE "kg_attribute_defs" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "kg_attribute_kind" NOT NULL,
    "options" JSONB,
    "extractable" BOOLEAN NOT NULL DEFAULT false,
    "extraction_hint" TEXT,
    "sensitivity" "kg_sensitivity",
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "deprecated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_attribute_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_entity_digests" (
    "entity_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "covers_until" TIMESTAMPTZ NOT NULL,
    "model" TEXT NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_entity_digests_pkey" PRIMARY KEY ("entity_id")
);

-- CreateTable
CREATE TABLE "kg_entity_views" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "last_viewed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_entity_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kg_entities_owner_id_type_review_status_idx" ON "kg_entities"("owner_id", "type", "review_status");

-- CreateIndex
CREATE INDEX "kg_entities_owner_id_updated_at_idx" ON "kg_entities"("owner_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "kg_entities_merged_into_id_idx" ON "kg_entities"("merged_into_id");

-- CreateIndex
CREATE INDEX "kg_entity_aliases_owner_id_normalized_idx" ON "kg_entity_aliases"("owner_id", "normalized");

-- CreateIndex
CREATE INDEX "kg_entity_aliases_entity_id_idx" ON "kg_entity_aliases"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "kg_entity_aliases_entity_id_normalized_key" ON "kg_entity_aliases"("entity_id", "normalized");

-- CreateIndex
CREATE INDEX "kg_relations_owner_id_from_id_type_idx" ON "kg_relations"("owner_id", "from_id", "type");

-- CreateIndex
CREATE INDEX "kg_relations_owner_id_to_id_type_idx" ON "kg_relations"("owner_id", "to_id", "type");

-- CreateIndex
CREATE INDEX "kg_relations_from_speaker_id_idx" ON "kg_relations"("from_speaker_id");

-- CreateIndex
CREATE INDEX "kg_relations_superseded_by_id_idx" ON "kg_relations"("superseded_by_id");

-- CreateIndex
CREATE INDEX "kg_relations_owner_id_type_review_status_idx" ON "kg_relations"("owner_id", "type", "review_status");

-- CreateIndex
CREATE INDEX "kg_items_owner_id_subject_id_occurred_at_idx" ON "kg_items"("owner_id", "subject_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "kg_items_owner_id_kind_status_idx" ON "kg_items"("owner_id", "kind", "status");

-- CreateIndex
CREATE INDEX "kg_items_owner_id_statement_hash_idx" ON "kg_items"("owner_id", "statement_hash");

-- CreateIndex
CREATE INDEX "kg_items_owner_person_id_idx" ON "kg_items"("owner_person_id");

-- CreateIndex
CREATE INDEX "kg_items_counterparty_id_idx" ON "kg_items"("counterparty_id");

-- CreateIndex
CREATE INDEX "kg_items_meeting_id_idx" ON "kg_items"("meeting_id");

-- CreateIndex
CREATE INDEX "kg_items_superseded_by_id_idx" ON "kg_items"("superseded_by_id");

-- CreateIndex
CREATE INDEX "kg_evidence_subject_kind_subject_id_idx" ON "kg_evidence"("subject_kind", "subject_id");

-- CreateIndex
CREATE INDEX "kg_evidence_owner_id_transcript_id_idx" ON "kg_evidence"("owner_id", "transcript_id");

-- CreateIndex
CREATE INDEX "kg_evidence_segment_id_idx" ON "kg_evidence"("segment_id");

-- CreateIndex
CREATE INDEX "kg_evidence_owner_id_note_id_idx" ON "kg_evidence"("owner_id", "note_id");

-- CreateIndex
CREATE INDEX "kg_mentions_owner_id_entity_id_idx" ON "kg_mentions"("owner_id", "entity_id");

-- CreateIndex
CREATE INDEX "kg_mentions_note_id_idx" ON "kg_mentions"("note_id");

-- CreateIndex
CREATE INDEX "kg_mentions_transcript_id_idx" ON "kg_mentions"("transcript_id");

-- CreateIndex
CREATE UNIQUE INDEX "kg_proposals_job_id_key" ON "kg_proposals"("job_id");

-- CreateIndex
CREATE INDEX "kg_proposals_owner_id_status_created_at_idx" ON "kg_proposals"("owner_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "kg_proposals_note_id_created_at_idx" ON "kg_proposals"("note_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "kg_proposal_items_proposal_id_kind_sort_order_idx" ON "kg_proposal_items"("proposal_id", "kind", "sort_order");

-- CreateIndex
CREATE INDEX "kg_merges_owner_id_created_at_idx" ON "kg_merges"("owner_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "kg_merges_survivor_id_idx" ON "kg_merges"("survivor_id");

-- CreateIndex
CREATE INDEX "kg_merges_merged_id_idx" ON "kg_merges"("merged_id");

-- CreateIndex
CREATE INDEX "kg_attribute_defs_owner_id_entity_type_sort_order_idx" ON "kg_attribute_defs"("owner_id", "entity_type", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "kg_attribute_defs_owner_id_entity_type_key_key" ON "kg_attribute_defs"("owner_id", "entity_type", "key");

-- CreateIndex
CREATE INDEX "kg_entity_digests_owner_id_idx" ON "kg_entity_digests"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "kg_entity_views_user_id_entity_id_key" ON "kg_entity_views"("user_id", "entity_id");

-- AddForeignKey
ALTER TABLE "kg_entities" ADD CONSTRAINT "kg_entities_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entities" ADD CONSTRAINT "kg_entities_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "kg_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entity_aliases" ADD CONSTRAINT "kg_entity_aliases_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entity_aliases" ADD CONSTRAINT "kg_entity_aliases_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_from_speaker_id_fkey" FOREIGN KEY ("from_speaker_id") REFERENCES "transcript_speakers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "kg_relations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_items" ADD CONSTRAINT "kg_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_items" ADD CONSTRAINT "kg_items_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_items" ADD CONSTRAINT "kg_items_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "kg_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_items" ADD CONSTRAINT "kg_items_owner_person_id_fkey" FOREIGN KEY ("owner_person_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_items" ADD CONSTRAINT "kg_items_counterparty_id_fkey" FOREIGN KEY ("counterparty_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_items" ADD CONSTRAINT "kg_items_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "kg_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "transcript_segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_import_object_id_fkey" FOREIGN KEY ("import_object_id") REFERENCES "storage_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_mentions" ADD CONSTRAINT "kg_mentions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_mentions" ADD CONSTRAINT "kg_mentions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_mentions" ADD CONSTRAINT "kg_mentions_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_mentions" ADD CONSTRAINT "kg_mentions_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_proposals" ADD CONSTRAINT "kg_proposals_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_proposals" ADD CONSTRAINT "kg_proposals_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_proposals" ADD CONSTRAINT "kg_proposals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_proposal_items" ADD CONSTRAINT "kg_proposal_items_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "kg_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_proposal_items" ADD CONSTRAINT "kg_proposal_items_merge_into_id_fkey" FOREIGN KEY ("merge_into_id") REFERENCES "kg_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_merges" ADD CONSTRAINT "kg_merges_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_merges" ADD CONSTRAINT "kg_merges_survivor_id_fkey" FOREIGN KEY ("survivor_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_merges" ADD CONSTRAINT "kg_merges_merged_id_fkey" FOREIGN KEY ("merged_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_distinct_pairs" ADD CONSTRAINT "kg_distinct_pairs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_distinct_pairs" ADD CONSTRAINT "kg_distinct_pairs_a_id_fkey" FOREIGN KEY ("a_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_distinct_pairs" ADD CONSTRAINT "kg_distinct_pairs_b_id_fkey" FOREIGN KEY ("b_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_attribute_defs" ADD CONSTRAINT "kg_attribute_defs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entity_digests" ADD CONSTRAINT "kg_entity_digests_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entity_digests" ADD CONSTRAINT "kg_entity_digests_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entity_views" ADD CONSTRAINT "kg_entity_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entity_views" ADD CONSTRAINT "kg_entity_views_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- HAND-WRITTEN, PRISMA-INEXPRESSIBLE SQL (issue #351)
-- =============================================================================
--
-- Everything below is intentional schema drift, in the same family as
-- `jobs_active_dedup_uniq_idx`, `database_backup_runs_active_uniq_idx`,
-- `transcript_speakers_transcript_id_label_key`, the transcript/note
-- generated `tsvector` columns, and `search_embeddings_embedding_hnsw_idx`.
-- Prisma's schema DSL has no way to express a trigram opclass, `USING gist`,
-- `USING hnsw`, a partial `WHERE` clause on a unique index, or a
-- cross-column/CASE-shaped CHECK constraint — every statement below is one
-- of those five, lives ONLY here, and `prisma migrate dev`/`diff` will
-- propose to drop all of it on every future schema change. WHEN THAT
-- HAPPENS, DELETE THE PROPOSED `DROP INDEX`/`DROP CONSTRAINT` LINES FROM THE
-- NEW MIGRATION — do not apply them, and do not try to force any of this
-- into `@@index`/`@@unique` syntax that does not exist.
--
-- `pg_trgm` IS A NEW MIGRATION REQUIREMENT FOR THIS CODEBASE — pgvector
-- already is not (`SearchEmbedding` already depends on it). It is a trusted
-- extension on PostgreSQL 13+, so the migration role needs no superuser, and
-- CI's `pgvector/pgvector:pg16` image ships it in contrib already.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- TRIGRAM INDEXES — fuzzy candidate generation (§7). `EXPLAIN … WHERE
-- normalized % 'sarah chen'` (with `enable_seqscan = off`) must use the
-- second of these two.
-- -----------------------------------------------------------------------------
CREATE INDEX "kg_entities_label_trgm_idx" ON "kg_entities" USING gin ("label" gin_trgm_ops);
CREATE INDEX "kg_entity_aliases_normalized_trgm_idx" ON "kg_entity_aliases" USING gin ("normalized" gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- RANGE (GiST) INDEXES — §5.4's bitemporal model. `valid` is
-- `Unsupported("tstzrange")` in schema.prisma (see the block comment above
-- `KgRelation`): Prisma cannot construct, bind or select a range value, so
-- every write goes through `$executeRaw` and every read through
-- `$queryRaw(lower(valid), upper(valid), lower_inc(valid), upper_inc(valid))`
-- — #353 provides `toPgRange`/`fromPgRange` for exactly this. `EXPLAIN …
-- WHERE valid @> now()` (with `enable_seqscan = off`) must use these.
-- -----------------------------------------------------------------------------
CREATE INDEX "kg_relations_valid_gist_idx" ON "kg_relations" USING gist ("valid");
CREATE INDEX "kg_items_valid_gist_idx" ON "kg_items" USING gist ("valid");

-- -----------------------------------------------------------------------------
-- HNSW (VECTOR) INDEXES — matching `search_embeddings_embedding_hnsw_idx`'s
-- own discipline exactly: built against an empty table (HNSW needs no
-- representative sample, unlike IVFFlat), and `vector_cosine_ops` to match
-- the `<=>` operator any future ranking query uses — an HNSW index whose
-- opclass disagrees with the query's distance operator is silently unusable,
-- not merely slower. See that migration's own header for the full argument.
-- -----------------------------------------------------------------------------
CREATE INDEX "kg_entities_embedding_hnsw_idx" ON "kg_entities" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "kg_items_embedding_hnsw_idx" ON "kg_items" USING hnsw ("embedding" vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- PARTIAL UNIQUE INDEXES — enforced in the database, never by a `findFirst`
-- before the insert, which cannot close the race a concurrent request needs
-- closed (the `database_backup_runs_active_uniq_idx` reasoning).
-- -----------------------------------------------------------------------------

-- The §8 "known, skipped" dedup guard: a verbatim restatement of an
-- already-live item attaches evidence instead of inserting a duplicate.
-- Scoped to accepted/edited rows with a subject so a rejected row's hash
-- never blocks a legitimate later insert, and an item with no subject
-- (impossible for claim/person_fact per `kg_items_subject_required_chk`,
-- but representable for commitment/decision) is never deduped by this index.
CREATE UNIQUE INDEX "kg_items_live_statement_uniq_idx"
  ON "kg_items" ("owner_id", "kind", "subject_id", "statement_hash")
  WHERE "review_status" IN ('accepted', 'edited') AND "subject_id" IS NOT NULL;

-- At most one OPEN draft per note. Whoever creates a new draft discards the
-- previous one in the same transaction (#363) — this index is what makes
-- "at most one" true under a race, not the service-layer discard alone.
CREATE UNIQUE INDEX "kg_proposals_note_draft_uniq_idx"
  ON "kg_proposals" ("note_id") WHERE "status" = 'draft';

-- At most one RUNNING extraction per note (#363's 409 `extraction_running`).
CREATE UNIQUE INDEX "kg_proposals_note_extracting_uniq_idx"
  ON "kg_proposals" ("note_id") WHERE "status" = 'extracting';

-- At most one RUNNING import per OWNER (#387's) — scoped by owner_id, not
-- note_id, because an import proposal has no note at all
-- (`kg_proposals_note_source_chk` below requires note_id NULL for it).
CREATE UNIQUE INDEX "kg_proposals_owner_import_extracting_uniq_idx"
  ON "kg_proposals" ("owner_id") WHERE "kind" = 'import' AND "status" = 'extracting';

-- At most one `IDENTIFIED_AS` edge per diarized speaker.
CREATE UNIQUE INDEX "kg_relations_speaker_link_uniq_idx"
  ON "kg_relations" ("from_speaker_id") WHERE "from_speaker_id" IS NOT NULL;

-- -----------------------------------------------------------------------------
-- CHECK CONSTRAINTS.
-- -----------------------------------------------------------------------------

-- Canonicalizes an unordered pair into exactly one storable row: (a, b) and
-- (b, a) can never both be inserted as two different "confirmed distinct"
-- facts about the same two entities.
ALTER TABLE "kg_distinct_pairs" ADD CONSTRAINT "kg_distinct_pairs_order_chk" CHECK ("a_id" < "b_id");

-- A mention always comes from exactly one source document.
ALTER TABLE "kg_mentions" ADD CONSTRAINT "kg_mentions_one_source_chk"
  CHECK (num_nonnulls("note_id", "transcript_id") = 1);

-- A relation's `from` side is EITHER a resolved entity OR a diarized speaker
-- awaiting `IDENTIFIED_AS`, never both, never neither.
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_one_source_chk"
  CHECK (num_nonnulls("from_id", "from_speaker_id") = 1);

-- `from_speaker_id` exists for exactly one relation type, and no other.
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_speaker_type_chk"
  CHECK ("from_speaker_id" IS NULL OR "type" = 'IDENTIFIED_AS');

-- A temporal relation always states a precision, but `unknown` stays
-- representable even should `valid` itself later be cleared while a
-- precision remains on record as having once been claimed.
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_valid_precision_chk"
  CHECK (("valid" IS NULL) = ("valid_precision" IS NULL) OR "valid_precision" = 'unknown');

-- Sensitivity is meaningful for exactly one item kind (§5.6): a claim with a
-- sensitivity, or a person fact with none, are both unrepresentable.
ALTER TABLE "kg_items" ADD CONSTRAINT "kg_items_sensitivity_chk"
  CHECK (("kind" = 'person_fact') = ("sensitivity" IS NOT NULL));

-- A claim or a person fact is always ABOUT something; a commitment/decision
-- may stand on its own.
ALTER TABLE "kg_items" ADD CONSTRAINT "kg_items_subject_required_chk"
  CHECK ("kind" NOT IN ('claim', 'person_fact') OR "subject_id" IS NOT NULL);

-- An end offset, when both ends are given, is never before its start. There
-- is deliberately NO CHECK requiring an anchor to be present at all — see
-- this migration's schema.prisma block comment above `KgEvidence` ("WHY
-- THERE IS NO ANCHOR CHECK"): every anchor FK is SetNull, and a fully
-- anchorless evidence row (every FK NULL, `quote` intact) is a valid,
-- expected end state, not a bug to prevent.
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_char_range_chk"
  CHECK ("char_start" IS NULL OR "char_end" IS NULL OR "char_end" >= "char_start");
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_ms_range_chk"
  CHECK ("start_ms" IS NULL OR "end_ms" IS NULL OR "end_ms" >= "start_ms");

-- `payload` is always a JSON object, never a bare array or scalar, so every
-- reader can assume key access without a type guard.
ALTER TABLE "kg_proposal_items" ADD CONSTRAINT "kg_proposal_items_kind_payload_chk"
  CHECK (jsonb_typeof("payload") = 'object');

-- The override column and the decision it overrides can never disagree
-- about which decision this row represents. `merge_into_id` is SetNull:
-- forgetting or purging the target entity clears the override, and the row
-- falls back to `pending` semantics at commit (#366 refuses a `merge_into`
-- row without a target).
ALTER TABLE "kg_proposal_items" ADD CONSTRAINT "kg_proposal_items_merge_into_chk"
  CHECK ("merge_into_id" IS NULL OR "decision" = 'merge_into');

-- Only `kind = 'extraction'` has a note. Keys on `note_version`, NEVER on
-- `note_id`, and this is deliberate: `note_id` is inserted non-null for
-- every extraction proposal and can only become NULL afterwards through the
-- note's own SetNull FK once the note is hard-deleted. A CHECK keyed on
-- `note_id` would then start failing for rows that were valid when written;
-- a CHECK keyed on `note_version` (never nulled by any FK action) stays
-- satisfied for the life of the row, so hard-deleting a note never violates
-- this constraint on its own extraction proposals.
ALTER TABLE "kg_proposals" ADD CONSTRAINT "kg_proposals_note_source_chk"
  CHECK (CASE WHEN "kind" = 'extraction' THEN "note_version" IS NOT NULL
              ELSE "note_id" IS NULL AND "note_version" IS NULL END);
