-- =============================================================================
-- Connected Knowledge: kg_* models scaffold (epic #344, issue #351)
-- =============================================================================
--
-- Prisma-generated DDL for every `kg_*` table and enum in `schema.prisma`'s
-- "Connected Knowledge" section. docs/specs/ontology.md §5, §7, §8, §10,
-- §17.3. This is the ORM-expressible half of the migration; the
-- Prisma-inexpressible half (pg_trgm, the GiST/HNSW/partial-unique indexes,
-- the CHECK constraints) is a separate commit, appended to this same file.
--
-- NOTE: `prisma migrate dev --create-only` also proposed dropping
-- "notes_search_vector_idx", "search_embeddings_embedding_hnsw_idx",
-- "transcript_segments_search_vector_idx",
-- "transcripts_title_search_vector_idx" and stripping a DEFAULT off three
-- generated `tsvector` columns, because none of those five objects can be
-- expressed in `schema.prisma` and Prisma's diff engine sees them as drift
-- on every single migration from now on. That is INTENTIONAL SCHEMA DRIFT,
-- not a real proposal — see `20260915130000_add_search_embeddings/
-- migration.sql`'s own header. Those lines were deleted from this file; do
-- not re-add them, here or in any future migration this diff engine
-- generates.
-- =============================================================================


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

-- NOTE: `prisma migrate dev --create-only` proposed dropping
-- "notes_search_vector_idx", "search_embeddings_embedding_hnsw_idx",
-- "transcript_segments_search_vector_idx",
-- "transcripts_title_search_vector_idx" and stripping a DEFAULT off three
-- generated `tsvector` columns here, because none of those five objects can
-- be expressed in `schema.prisma` and Prisma's diff engine sees them as
-- drift on every single migration from now on. That is INTENTIONAL SCHEMA
-- DRIFT, not a real proposal — see the "Connected Knowledge" section header
-- in `schema.prisma` and this migration's own header below. Those lines
-- were deleted from this file; do not re-add them, here or in any future
-- migration this diff engine generates.

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
    "distinct_from" UUID[] DEFAULT ARRAY[]::UUID[],
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
