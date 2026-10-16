-- =============================================================================
-- Notes (issue #48, epic #45)
-- =============================================================================
-- Five tables: `notes`, `note_templates`, `note_generations`, `note_versions`,
-- `note_exports`. See the block comment above the `Note` model in
-- prisma/schema.prisma for the full reasoning behind every `onDelete` choice
-- below (in particular why `owner_id` cascades while the three source
-- pointers restrict, why `template_id` is `SetNull` rather than `Restrict`,
-- why `note_generations.job_id` mirrors `DatabaseBackupRun.jobId`/
-- `TranscriptExport.jobId`, and why `note_exports`' content-addressed lookup
-- is a plain non-unique index rather than the `@@unique` docs/specs/notes.md
-- §4.6's prose names), and docs/specs/notes.md §1, §4, §6, §7 for the
-- product reasoning this file intentionally does not restate at length.
--
-- NO HAND-WRITTEN, PRISMA-INEXPRESSIBLE CONSTRAINTS IN THIS MIGRATION, unlike
-- `20260914130000_add_transcripts` (which needed one, a partial unique index
-- for `transcript_speakers.label`). Every unique constraint below
-- (`note_templates` on `(owner_id, name)`, `note_generations.job_id`,
-- `note_versions` on `(note_id, version)` and `(note_id, client_batch_id)`,
-- `note_exports.job_id`) is a plain, fully Prisma-expressible unique index,
-- and the content-addressed export lookup is a plain non-unique index —
-- there is nothing here Prisma's own DSL cannot say.
-- =============================================================================

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('draft', 'generating', 'ready', 'failed', 'deleting');

-- CreateEnum
CREATE TYPE "NoteSourceType" AS ENUM ('transcript', 'note', 'document');

-- CreateEnum
CREATE TYPE "NoteGenerationKind" AS ENUM ('create', 'regenerate', 'preview');

-- CreateEnum
CREATE TYPE "NoteGenerationStatus" AS ENUM ('pending', 'streaming', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "NoteGenerationErrorClass" AS ENUM ('auth', 'refusal', 'rate_limit', 'other');

-- CreateEnum
CREATE TYPE "NoteVersionKind" AS ENUM ('ai_generated', 'edit', 'restore');

-- CreateEnum
CREATE TYPE "NoteExportStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "status" "NoteStatus" NOT NULL DEFAULT 'draft',
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "model" TEXT,
    "current_generation_id" UUID,
    "source_type" "NoteSourceType" NOT NULL,
    "source_transcript_id" UUID,
    "source_note_id" UUID,
    "source_object_id" UUID,
    "template_id" UUID,
    "context_text" TEXT,
    "failure_reason" TEXT,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_templates" (
    "id" UUID NOT NULL,
    "owner_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "output_format" TEXT NOT NULL,
    "structure" JSONB NOT NULL,
    "tone" TEXT,
    "length" TEXT,
    "model" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "note_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_generations" (
    "id" UUID NOT NULL,
    "note_id" UUID,
    "kind" "NoteGenerationKind" NOT NULL,
    "status" "NoteGenerationStatus" NOT NULL DEFAULT 'pending',
    "error_class" "NoteGenerationErrorClass",
    "error_detail" TEXT,
    "template_id" UUID,
    "template_name_snapshot" TEXT NOT NULL,
    "context_text" TEXT,
    "source_type" "NoteSourceType" NOT NULL,
    "source_transcript_id" UUID,
    "source_note_id" UUID,
    "source_object_id" UUID,
    "provider_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "last_event_id" INTEGER NOT NULL DEFAULT 0,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "job_id" UUID,
    "expires_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_versions" (
    "id" UUID NOT NULL,
    "note_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "NoteVersionKind" NOT NULL,
    "body" TEXT NOT NULL,
    "summary" TEXT,
    "author_id" UUID,
    "generation_id" UUID,
    "restored_from_version" INTEGER,
    "client_batch_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_exports" (
    "id" UUID NOT NULL,
    "note_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "options_hash" TEXT NOT NULL,
    "status" "NoteExportStatus" NOT NULL DEFAULT 'pending',
    "object_id" UUID,
    "job_id" UUID,
    "requested_by_id" UUID NOT NULL,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "This owner's notes, newest first" — the notes library list view.
CREATE INDEX "notes_owner_id_updated_at_idx" ON "notes"("owner_id", "updated_at" DESC);

-- CreateIndex
-- "Every note in state X" — notes.housekeeping's scans (#53) and any future
-- admin-adjacent health check.
CREATE INDEX "notes_status_idx" ON "notes"("status");

-- CreateIndex
-- A user may not have two templates sharing a name (issue #48). PostgreSQL's
-- standard NULLS-DISTINCT behaviour means this is a no-op among built-ins —
-- every built-in's owner_id is permanently NULL, and NULL is never equal to
-- NULL for uniqueness purposes, so any number of built-in rows may coexist
-- regardless of name. See the block comment above the Note model in
-- schema.prisma for the full reasoning.
CREATE UNIQUE INDEX "note_templates_owner_id_name_key" ON "note_templates"("owner_id", "name");

-- CreateIndex
-- One note_generations row per producing job — mirrors
-- note_exports_job_id_key/transcript_exports_job_id_key exactly: a second
-- generation claiming the SAME job is unrepresentable.
CREATE UNIQUE INDEX "note_generations_job_id_key" ON "note_generations"("job_id");

-- CreateIndex
-- The version sequence itself.
CREATE UNIQUE INDEX "note_versions_note_id_version_key" ON "note_versions"("note_id", "version");

-- CreateIndex
-- The idempotent-retry key for a batch save (#53). A plain UNIQUE index,
-- deliberately not hand-written: PostgreSQL's standard NULLS-DISTINCT
-- behaviour already gives exactly the wanted semantics for this nullable
-- column (any number of null-client_batch_id versions, e.g. AI-generated or
-- restore, may coexist; at most one per note for any given non-null value).
CREATE UNIQUE INDEX "note_versions_note_id_client_batch_id_key" ON "note_versions"("note_id", "client_batch_id");

-- CreateIndex
-- One note_exports row per rendering job — mirrors
-- transcript_exports_job_id_key exactly: a second render for the SAME job is
-- unrepresentable.
CREATE UNIQUE INDEX "note_exports_job_id_key" ON "note_exports"("job_id");

-- CreateIndex
-- The reuse-by-content-hash lookup (docs/specs/notes.md §8.4). Deliberately
-- NOT unique — mirrors transcript_exports_lookup_idx's real shape rather
-- than spec §4.6's own shorthand "unique" wording: an expired or failed row
-- may briefly coexist with a fresh one sharing the same key before
-- housekeeping removes the stale one. Named explicitly
-- (`map: "note_exports_lookup_idx"` in schema.prisma) because the default
-- four-column name is one byte over PostgreSQL's 63-byte identifier limit.
CREATE INDEX "note_exports_lookup_idx" ON "note_exports"("note_id", "version", "format", "options_hash");

-- AddForeignKey
-- Cascade: a note's only reason to exist is that exactly one user owns it,
-- and this application's access model has no path to it once its owner is
-- gone (no notes:read_any, docs/specs/notes.md §6.3). See the block comment
-- above the Note model for the full reasoning.
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull: losing the pointer loses only "which generation is live right
-- now," never the generation row itself or any note_versions row it already
-- produced.
ALTER TABLE "notes" ADD CONSTRAINT "notes_current_generation_id_fkey" FOREIGN KEY ("current_generation_id") REFERENCES "note_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, with a REAL user-visible consequence unlike the belt-and-
-- suspenders Restrict on storage_objects below: a transcript that has
-- produced a note cannot be deleted while that note still exists.
-- DELETE /api/transcripts/:id gains a pre-check that 409s naming the
-- blocking note id(s) before this constraint is ever reached (see the block
-- comment above the Note model — that pre-check is backend work landing
-- alongside this migration, not part of this migration itself).
ALTER TABLE "notes" ADD CONSTRAINT "notes_source_transcript_id_fkey" FOREIGN KEY ("source_transcript_id") REFERENCES "transcripts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, self-referencing: a note cited as another note's source cannot
-- be deleted while that derivative note still exists. #53's own
-- notes.service.ts delete guard is the note-on-note counterpart to the
-- transcript pre-check above.
ALTER TABLE "notes" ADD CONSTRAINT "notes_source_note_id_fkey" FOREIGN KEY ("source_note_id") REFERENCES "notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, belt-and-suspenders: the uploaded document is
-- managed_by: 'notes', so the generic storage DELETE already 409s on it
-- before this constraint is ever tested.
ALTER TABLE "notes" ADD CONSTRAINT "notes_source_object_id_fkey" FOREIGN KEY ("source_object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, not Restrict: a template is a reusable recipe, not evidence.
-- note_generations.template_name_snapshot keeps "which recipe produced this"
-- as a plain string forever, independent of whether the template row itself
-- survives.
ALTER TABLE "notes" ADD CONSTRAINT "notes_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "note_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade: a user's own custom template has no meaning once its owner is
-- gone. Never fires for a built-in row, whose owner_id is permanently NULL.
ALTER TABLE "note_templates" ADD CONSTRAINT "note_templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade: a note_generations row belongs entirely to the note that owns
-- it (NULL note_id for a preview, which has none).
ALTER TABLE "note_generations" ADD CONSTRAINT "note_generations_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, matching notes.template_id above.
ALTER TABLE "note_generations" ADD CONSTRAINT "note_generations_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "note_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, mirroring note_exports_job_id_fkey/transcript_exports_job_id_fkey
-- exactly: job.history.purge deletes jobs rows on a retention schedule
-- independent of this row's own lifetime, and losing the LINK must never
-- mean losing the GENERATION (its buffered content is what a
-- note_versions.ai_generated row was stamped from).
ALTER TABLE "note_generations" ADD CONSTRAINT "note_generations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull: a version is permanent history and must survive its human
-- author's own account being deleted. NULL already means "the AI" for a
-- different reason (note.generate never sets an author at all) — this FK
-- action only ever fires for a human-authored version whose author was
-- later deleted.
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull: the version's body already carries everything durable; losing
-- the pointer back to the generation that produced it loses only "which
-- streaming run wrote this," never the content itself.
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "note_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_exports" ADD CONSTRAINT "note_exports_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, matching every storage_objects FK on the transcripts feature:
-- only notes.housekeeping's expiry sweep may remove the rendered file, and
-- only after deleting this row first.
ALTER TABLE "note_exports" ADD CONSTRAINT "note_exports_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, mirroring transcript_exports_job_id_fkey exactly: job.history
-- .purge deletes jobs rows on a retention schedule independent of this
-- row's own 7-day export expiry, and losing the LINK must never mean losing
-- the EXPORT.
ALTER TABLE "note_exports" ADD CONSTRAINT "note_exports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade: unlike every SetNull audit column elsewhere in this schema, an
-- export is a disposable, byte-for-byte reproducible artifact with a 7-day
-- expiry already built in — nothing is lost by deleting a pending/ready
-- export row alongside the account that requested it.
ALTER TABLE "note_exports" ADD CONSTRAINT "note_exports_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
