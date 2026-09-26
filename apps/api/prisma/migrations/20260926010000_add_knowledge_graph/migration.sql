-- =============================================================================
-- Connected Knowledge: the whole `kg_*` graph schema (epic #344, issue #351)
-- =============================================================================
--
-- docs/specs/ontology.md §5, §7, §8, §10, §17.3. Storage only — no service,
-- endpoint, or the evidence-invariant trigger (that is #355's, in its own
-- migration so it lands with the code that satisfies it). One foundation
-- migration for the whole graph rather than one migration per feature issue,
-- so #354-#357, #363-#366, #370 and #372 stay purely additive and never race
-- each other on `schema.prisma` relations or migration ordering.
--
-- -----------------------------------------------------------------------------
-- 1. `pg_trgm` IS A NEW EXTENSION FOR THIS DATABASE — trusted, not superuser.
-- -----------------------------------------------------------------------------
--
-- Only `uuid-ossp` and `vector` were enabled before this migration.
-- `pg_trgm` is a TRUSTED extension on PostgreSQL 13+: any database owner may
-- `CREATE EXTENSION` it without superuser, unlike `vector` (which still
-- needed #179's deploy-time preflight because its SHARED LIBRARY must be
-- present on the server first — a fact no migration can install). `pg_trgm`
-- ships in `contrib` on every mainstream PostgreSQL build, including the CI
-- smoke job's `pgvector/pgvector:pg16` image, so `CREATE EXTENSION IF NOT
-- EXISTS pg_trgm` below needs no preflight of its own and no operator
-- action on managed PostgreSQL.
--
-- -----------------------------------------------------------------------------
-- 2. `valid tstzrange` (§5.4) — RANGES, NOT TWO NULLABLE TIMESTAMPS.
-- -----------------------------------------------------------------------------
--
-- `kg_relations.valid` and `kg_items.valid` hold a fact's bitemporal
-- validity window as a single `tstzrange` value rather than
-- `valid_from`/`valid_to` columns a service would have to keep consistent by
-- hand. Range operators (`@>`, `&&`) and a GiST index make "what was true at
-- time T" and "does this new fact overlap an existing one" correct BY
-- CONSTRUCTION, the exact argument §5.4 makes against the two-timestamp
-- alternative. Prisma has no scalar type for a Postgres range, so
-- `schema.prisma` declares both columns `Unsupported("tstzrange")?` — the
-- generated client cannot read OR write them at all. Every writer sets
-- `valid` with `$executeRaw` inside the SAME transaction as the row's
-- `create`; every reader selects `lower(valid)`, `upper(valid)`,
-- `lower_inc(valid)`/`upper_inc(valid)` via `$queryRaw`. #353 provides
-- `toPgRange`/`fromPgRange` for both directions. `valid_precision` sits
-- BESIDE the range, not encoded into it, because a fact's timing confidence
-- ("sometime in 2024" vs. "at this exact instant") is orthogonal to its
-- actual bounds.
--
-- -----------------------------------------------------------------------------
-- 3. HNSW ON `kg_entities.embedding`/`kg_items.embedding` — SAME REASONING
--    AS `search_embeddings`, RESTATED, NOT RE-ARGUED.
-- -----------------------------------------------------------------------------
--
-- Both indexes are built against EMPTY tables (this migration runs before
-- any entity or item has ever been embedded), which is exactly the case
-- HNSW's incremental graph construction handles well and IVFFlat's
-- fixed-list-count-at-build-time handles badly — see
-- `20260915130000_add_search_embeddings/migration.sql`'s header (point 3)
-- for the full argument, which is not repeated here. `vector_cosine_ops`
-- matches the `<=>` operator the ranking queries (#370, #372) will use, for
-- the identical reason that migration's header (point 4) states: an HNSW
-- index whose opclass disagrees with a query's distance operator is
-- SILENTLY unusable by that query, not merely slower.
--
-- -----------------------------------------------------------------------------
-- 4. FIVE PARTIAL UNIQUE INDEXES — never a `findFirst` before an INSERT.
-- -----------------------------------------------------------------------------
--
-- `kg_proposals_note_draft_uniq_idx`: at most one open DRAFT proposal per
-- note. Whoever creates a new draft discards the previous one in the same
-- transaction (#363) — this index is what makes "at most one" true even
-- under a race, the same `database_backup_runs_active_uniq_idx` reasoning
-- this schema already relies on elsewhere.
--
-- `kg_proposals_note_extracting_uniq_idx` / `kg_proposals_owner_import_
-- extracting_uniq_idx`: at most one RUNNING extraction per note (#363's 409
-- `extraction_running`) and at most one running IMPORT per owner (#387's).
-- Enforced here, at the database, never by a read-then-write race in a
-- service.
--
-- `kg_items_live_statement_uniq_idx`: the "known, skipped" guard §8
-- describes — a verbatim restatement (same owner, kind, subject, statement
-- hash) attaches evidence to the existing row instead of inserting a
-- duplicate, scoped to `accepted`/`edited` rows only so a previously
-- `rejected` item's hash never blocks a fresh proposal from trying again.
--
-- `kg_relations_speaker_link_uniq_idx`: at most one `IDENTIFIED_AS` edge per
-- diarized speaker — a speaker is identified as exactly one entity at a
-- time; re-identifying updates the existing edge rather than adding a
-- second one alongside it.
--
-- -----------------------------------------------------------------------------
-- 5. TWELVE CHECK CONSTRAINTS — restated briefly; see each ALTER TABLE below
--    for the full column-level comment.
-- -----------------------------------------------------------------------------
--
-- `kg_distinct_pairs_order_chk` makes the pair's storage order canonical.
-- `kg_mentions_one_source_chk` and `kg_relations_one_source_chk` each
-- enforce "exactly one of these two columns is set" the way this schema
-- already leaves as a service-only rule elsewhere (`notes.sourceType`'s
-- trio) — these two get a real CHECK because getting either wrong corrupts
-- the graph itself, not just a display field. `kg_relations_speaker_type_
-- chk` confines `from_speaker_id` to `IDENTIFIED_AS` rows.
-- `kg_relations_valid_precision_chk` keeps `valid`/`valid_precision`
-- null-together (or precision `unknown`, the one legitimate exception: a
-- range with real bounds but an admittedly unknown precision).
-- `kg_items_sensitivity_chk` ties `sensitivity` to `kind = 'person_fact'`
-- exactly (§5.6). `kg_items_subject_required_chk` requires a subject for
-- `claim`/`person_fact`. `kg_evidence_char_range_chk`/`kg_evidence_ms_range_
-- chk` keep an evidence span's end past its start when both are set.
-- `kg_proposal_items_kind_payload_chk` requires `payload` to be a JSON
-- object (never an array or scalar). `kg_proposal_items_merge_into_chk`
-- ties `merge_into_id` to `decision = 'merge_into'`. `kg_proposals_note_
-- source_chk` is explained in full at its own ALTER TABLE below — it is the
-- one CHECK in this migration keyed on a column OTHER than the one it looks
-- like it should be keyed on, and that choice is deliberate.
--
-- -----------------------------------------------------------------------------
-- 6. WHY THERE IS NO CHECK REQUIRING AN ANCHOR ON `kg_evidence`.
-- -----------------------------------------------------------------------------
--
-- `transcript_id`/`segment_id`/`note_id` are all `SET NULL` by design
-- (§10). A CHECK requiring at least one non-null anchor would make deleting
-- a transcript or note FAIL the instant its own evidence row loses that
-- pointer — exactly backward: the citation should survive the deletion,
-- just without a live link to jump to. `quote` (`NOT NULL`) is what keeps
-- an anchor-less citation readable: the sentence is still there even once
-- nothing points back to where it came from.
--
-- -----------------------------------------------------------------------------
-- INTENTIONAL SCHEMA DRIFT — THE SIXTH OCCURRENCE OF THIS EXACT PATTERN.
-- -----------------------------------------------------------------------------
--
-- `pg_trgm`'s extension statement, both trigram GIN indexes, both `valid`
-- GiST indexes, both embedding HNSW indexes, all five partial unique
-- indexes and all twelve CHECK constraints below exist ONLY in this file.
-- `prisma migrate dev`/`diff` has no DSL for a trigram opclass, a GiST index
-- on a range column, `USING hnsw`, a partial `WHERE` clause on an index, or
-- a table-level CHECK constraint — following (1) `jobs_active_dedup_uniq_
-- idx`, (2) `database_backup_runs_active_uniq_idx`, (3) `transcript_
-- speakers_transcript_id_label_key`, (4) the generated `tsvector` columns'
-- GIN indexes, and (5) `search_embeddings_embedding_hnsw_idx`. When a later
-- `prisma migrate dev` proposes `DROP INDEX`/`DROP CONSTRAINT` for any name
-- introduced below, delete that proposal from the generated migration — it
-- is not real drift to reconcile, it is Prisma re-discovering hand-written
-- SQL it was never told about.
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

-- =============================================================================
-- HAND-WRITTEN: Prisma-inexpressible schema (see the migration header's
-- "INTENTIONAL SCHEMA DRIFT" section, occurrence 6 of 6). Everything below
-- lives ONLY in this file.
-- =============================================================================

-- `pg_trgm` is a TRUSTED extension on PostgreSQL 13+ (header point 1): any
-- database owner may create it, no superuser required, and it ships in
-- `contrib` on every mainstream build including the CI smoke job's
-- `pgvector/pgvector:pg16` image. MUST run before the trigram indexes below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- Trigram indexes (§7 candidate generation) — fuzzy alias/label matching via
-- the `%` similarity operator (`normalizeAlias()`'s output feeds these
-- directly, #355).
-- -----------------------------------------------------------------------------
CREATE INDEX kg_entities_label_trgm_idx        ON kg_entities        USING gin (label gin_trgm_ops);
CREATE INDEX kg_entity_aliases_normalized_trgm_idx ON kg_entity_aliases USING gin (normalized gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- Range indexes (§5.4) — GiST is the only access method that can index
-- `tstzrange`'s `@>`/`&&` operators; a plain b-tree cannot.
-- -----------------------------------------------------------------------------
CREATE INDEX kg_relations_valid_gist_idx ON kg_relations USING gist (valid);
CREATE INDEX kg_items_valid_gist_idx     ON kg_items     USING gist (valid);

-- -----------------------------------------------------------------------------
-- Vector indexes (§7, §9) — HNSW, built empty, `vector_cosine_ops` to match
-- the `<=>` ranking queries. See the migration header, point 3.
-- -----------------------------------------------------------------------------
CREATE INDEX kg_entities_embedding_hnsw_idx ON kg_entities USING hnsw (embedding vector_cosine_ops);
CREATE INDEX kg_items_embedding_hnsw_idx    ON kg_items    USING hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- Partial unique indexes — enforced here, at the database, never by a
-- `findFirst` before the INSERT (the `database_backup_runs_active_uniq_idx`
-- reasoning). See the migration header, point 4, for what each one prevents.
-- -----------------------------------------------------------------------------

-- At most one open DRAFT proposal per note. Whoever creates a new draft
-- discards the previous one in the same transaction (#363).
CREATE UNIQUE INDEX kg_proposals_note_draft_uniq_idx ON kg_proposals (note_id) WHERE status = 'draft';

-- At most one RUNNING extraction per note (#363's 409 extraction_running).
CREATE UNIQUE INDEX kg_proposals_note_extracting_uniq_idx ON kg_proposals (note_id) WHERE status = 'extracting';

-- At most one running IMPORT per owner (#387's).
CREATE UNIQUE INDEX kg_proposals_owner_import_extracting_uniq_idx
  ON kg_proposals (owner_id) WHERE kind = 'import' AND status = 'extracting';

-- The "known, skipped" guard (§8): a verbatim restatement attaches evidence
-- to the existing row instead of inserting a duplicate. Scoped to
-- accepted/edited rows only, so a rejected item's hash never blocks a fresh
-- proposal from trying again.
CREATE UNIQUE INDEX kg_items_live_statement_uniq_idx
  ON kg_items (owner_id, kind, subject_id, statement_hash)
  WHERE review_status IN ('accepted','edited') AND subject_id IS NOT NULL;

-- At most one IDENTIFIED_AS edge per diarized speaker — re-identifying
-- updates the existing edge rather than adding a second one alongside it.
CREATE UNIQUE INDEX kg_relations_speaker_link_uniq_idx
  ON kg_relations (from_speaker_id) WHERE from_speaker_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- CHECK constraints — see the migration header, point 5, for the summary;
-- each comment below states what THIS constraint specifically prevents.
-- -----------------------------------------------------------------------------

-- Canonical pair order — makes (x, y) and (y, x) the same storage identity,
-- so a distinct-pair lookup never has to check both orderings.
ALTER TABLE kg_distinct_pairs ADD CONSTRAINT kg_distinct_pairs_order_chk CHECK (a_id < b_id);

-- Exactly one of note_id/transcript_id — a mention's source is never both
-- or neither (unlike kg_evidence's anchors, which are deliberately allowed
-- to end up all-null via SET NULL; see the migration header, point 6).
ALTER TABLE kg_mentions ADD CONSTRAINT kg_mentions_one_source_chk
  CHECK (num_nonnulls(note_id, transcript_id) = 1);

-- Exactly one of from_id/from_speaker_id — a relation's source is either an
-- entity or a diarized speaker, never both, never neither.
ALTER TABLE kg_relations ADD CONSTRAINT kg_relations_one_source_chk
  CHECK (num_nonnulls(from_id, from_speaker_id) = 1);

-- from_speaker_id is only ever set on an IDENTIFIED_AS edge — every other
-- relation type sources from an entity.
ALTER TABLE kg_relations ADD CONSTRAINT kg_relations_speaker_type_chk
  CHECK (from_speaker_id IS NULL OR type = 'IDENTIFIED_AS');

-- valid and valid_precision are null together, except that a range with
-- real bounds may still carry an admittedly unknown precision.
ALTER TABLE kg_relations ADD CONSTRAINT kg_relations_valid_precision_chk
  CHECK ((valid IS NULL) = (valid_precision IS NULL) OR valid_precision = 'unknown');

-- sensitivity is set if and only if kind = 'person_fact' (§5.6) — the one
-- item kind capable of holding data this deployment must never let leave it.
ALTER TABLE kg_items ADD CONSTRAINT kg_items_sensitivity_chk
  CHECK ((kind = 'person_fact') = (sensitivity IS NOT NULL));

-- claim/person_fact items must have a subject — an unattributed claim or
-- fact about no one is not representable.
ALTER TABLE kg_items ADD CONSTRAINT kg_items_subject_required_chk
  CHECK (kind NOT IN ('claim','person_fact') OR subject_id IS NOT NULL);

-- A character-offset span's end never precedes its start, when both are set.
ALTER TABLE kg_evidence ADD CONSTRAINT kg_evidence_char_range_chk
  CHECK (char_start IS NULL OR char_end IS NULL OR char_end >= char_start);

-- Same rule for the millisecond span into the anchored segment's audio.
ALTER TABLE kg_evidence ADD CONSTRAINT kg_evidence_ms_range_chk
  CHECK (start_ms IS NULL OR end_ms IS NULL OR end_ms >= start_ms);

-- payload must be a JSON object, never an array or bare scalar — every
-- reader assumes object-shaped access.
ALTER TABLE kg_proposal_items ADD CONSTRAINT kg_proposal_items_kind_payload_chk
  CHECK (jsonb_typeof(payload) = 'object');

-- merge_into_id is set if and only if decision = 'merge_into' (#366) — a
-- reviewer override recorded without the matching decision is not
-- representable.
ALTER TABLE kg_proposal_items ADD CONSTRAINT kg_proposal_items_merge_into_chk
  CHECK (merge_into_id IS NULL OR decision = 'merge_into');

-- Only kind = 'extraction' has a note. Keyed on note_version, NEVER on
-- note_id: note_id is SET NULL, so hard-deleting a note nulls note_id on
-- its extraction proposals as a pure side effect of that FK. A CHECK keyed
-- on note_id would then start failing rows the delete never meant to
-- touch. note_version is never nulled by any FK, so it is the column that
-- actually distinguishes 'extraction' from 'import'/'resolution' for the
-- CHECK's whole lifetime — note_id is inserted non-null for every
-- extraction and can only become NULL afterwards through that SetNull.
ALTER TABLE kg_proposals ADD CONSTRAINT kg_proposals_note_source_chk
  CHECK (CASE WHEN kind = 'extraction' THEN note_version IS NOT NULL
              ELSE note_id IS NULL AND note_version IS NULL END);
