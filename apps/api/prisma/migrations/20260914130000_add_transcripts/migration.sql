-- =============================================================================
-- Transcripts (issue #24, epic #19)
-- =============================================================================
-- Six tables: `transcripts`, `transcript_speakers`, `transcript_segments`,
-- `transcript_versions`, `transcript_shares`, `transcript_exports`. See the
-- block comment above the `Transcript` model in prisma/schema.prisma for the
-- full reasoning behind every `onDelete` choice below (in particular why
-- `owner_id` cascades while every `storage_objects` FK on these tables
-- restricts, and why `speaker_id` on `transcript_segments` also restricts)
-- and docs/specs/transcription.md §3–§6 for the product reasoning this file
-- intentionally does not restate at length.
--
-- ONE HAND-WRITTEN, PRISMA-INEXPRESSIBLE CONSTRAINT, flagged where it
-- appears below: `transcript_speakers_transcript_id_label_key`, a PARTIAL
-- unique index (`WHERE "label" IS NOT NULL`) — the same
-- Prisma-DSL-has-no-WHERE-clause pattern `jobs_active_dedup_uniq_idx` and
-- `database_backup_runs_active_uniq_idx` already establish in this
-- repository. `prisma migrate dev`/`diff` will never regenerate it and will
-- want to drop it on a naive reconcile — do not let it. Every OTHER unique
-- constraint in this migration (`transcript_versions` on `(transcript_id,
-- version)` and `(transcript_id, client_batch_id)`, `transcript_shares` on
-- `(transcript_id, user_id)`) is a plain, fully Prisma-expressible unique
-- index and needed no such treatment.
-- =============================================================================

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('uploading', 'processing', 'ready', 'failed', 'deleting');

-- CreateEnum
CREATE TYPE "TranscriptionStatus" AS ENUM ('waiting_input', 'queued', 'submitting', 'submitted', 'processing', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "PlaybackStatus" AS ENUM ('pending', 'processing', 'ready', 'failed', 'not_needed');

-- CreateEnum
CREATE TYPE "WordsAlignment" AS ENUM ('exact', 'interpolated', 'none');

-- CreateEnum
CREATE TYPE "SegmentOrigin" AS ENUM ('ai', 'user');

-- CreateEnum
CREATE TYPE "TranscriptVersionKind" AS ENUM ('ai_original', 'edit', 'restore');

-- CreateEnum
CREATE TYPE "TranscriptShareRole" AS ENUM ('viewer', 'editor');

-- CreateEnum
CREATE TYPE "TranscriptExportStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "transcripts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "language" TEXT,
    "status" "TranscriptStatus" NOT NULL DEFAULT 'uploading',
    "transcription_status" "TranscriptionStatus" NOT NULL DEFAULT 'waiting_input',
    "playback_status" "PlaybackStatus" NOT NULL DEFAULT 'pending',
    "source_object_id" UUID NOT NULL,
    "playback_object_id" UUID,
    "raw_result_object_id" UUID,
    "provider" TEXT NOT NULL,
    "provider_job_id" TEXT,
    "provider_options" JSONB,
    "submitted_at" TIMESTAMPTZ,
    "last_polled_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "remote_deleted_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "duration_ms" INTEGER,
    "failure_reason" TEXT,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "speaker_count" INTEGER NOT NULL DEFAULT 0,
    "word_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_speakers" (
    "id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "label" TEXT,
    "display_name" TEXT NOT NULL,
    "color_index" INTEGER NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "transcript_speakers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "speaker_id" UUID NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "ordinal" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    "words" JSONB NOT NULL,
    "words_alignment" "WordsAlignment" NOT NULL DEFAULT 'exact',
    "confidence" DOUBLE PRECISION,
    "origin" "SegmentOrigin" NOT NULL DEFAULT 'ai',
    "rev" INTEGER NOT NULL DEFAULT 1,
    "edited_by_id" UUID,
    "edited_at" TIMESTAMPTZ,

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_versions" (
    "id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "TranscriptVersionKind" NOT NULL,
    "author_id" UUID,
    "summary" TEXT,
    "ops" JSONB NOT NULL,
    "restored_from_version" INTEGER,
    "snapshot_object_id" UUID,
    "client_batch_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_shares" (
    "id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TranscriptShareRole" NOT NULL,
    "granted_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_exports" (
    "id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "options_hash" TEXT NOT NULL,
    "status" "TranscriptExportStatus" NOT NULL DEFAULT 'pending',
    "object_id" UUID,
    "job_id" UUID,
    "requested_by_id" UUID NOT NULL,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "This owner's transcripts, newest first" — the transcript list view.
CREATE INDEX "transcripts_owner_id_updated_at_idx" ON "transcripts"("owner_id", "updated_at" DESC);

-- CreateIndex
-- "Every transcript in state X" — transcripts.housekeeping's scans (spec
-- §1.5.8) and any future admin-adjacent health check.
CREATE INDEX "transcripts_status_idx" ON "transcripts"("status");

-- =============================================================================
-- HAND-WRITTEN INDEX — INTENTIONAL SCHEMA DRIFT (issue #24, epic #19)
-- =============================================================================
-- NOT emitted by `prisma migrate dev`/`diff` and never will be: it needs a
-- partial-index `WHERE` clause, which the Prisma schema language has no
-- syntax for. See the block comment above the `Transcript` model in
-- prisma/schema.prisma for the same fact recorded where anyone reading the
-- schema without this file open will see it, and
-- 20260907120000_add_database_backup_runs/migration.sql's own header for the
-- precedent this follows to the letter.
--
-- ⚠ `prisma migrate dev` WILL WANT TO DROP THIS on the next diff. Do not
-- "reconcile" that away, and do not expect `prisma migrate diff` against a
-- live database to come back clean — this drift is deliberate and permanent
-- for as long as Prisma's DSL lacks partial indexes.
--
-- A provider-labelled speaker's `label` (e.g. "A") must be unique per
-- transcript; a user-created speaker (`speaker.create`, spec §4.1)
-- legitimately has none, so the constraint is scoped to labelled rows only.
-- =============================================================================
CREATE UNIQUE INDEX "transcript_speakers_transcript_id_label_key"
  ON "transcript_speakers" ("transcript_id", "label") WHERE "label" IS NOT NULL;

-- CreateIndex
-- The compound order a segment list and a time-window query
-- (`GET /:id/words?fromMs&toMs`) both need (spec §3.3).
CREATE INDEX "transcript_segments_transcript_id_start_ms_ordinal_idx" ON "transcript_segments"("transcript_id", "start_ms", "ordinal");

-- CreateIndex
-- The version sequence itself, and what `materialize()` (spec §4.4) looks
-- up by. A plain UNIQUE index — Postgres needs no partial clause here.
CREATE UNIQUE INDEX "transcript_versions_transcript_id_version_key" ON "transcript_versions"("transcript_id", "version");

-- CreateIndex
-- The idempotent-retry key for a batch save (spec §5). Also a plain UNIQUE
-- index, deliberately NOT hand-written like the speaker label above:
-- PostgreSQL's standard NULLS-DISTINCT behaviour already gives exactly the
-- wanted semantics for this nullable column (any number of
-- null-`client_batch_id` versions, e.g. ingest/restore, may coexist; at most
-- one per transcript for any given non-null value).
CREATE UNIQUE INDEX "transcript_versions_transcript_id_client_batch_id_key" ON "transcript_versions"("transcript_id", "client_batch_id");

-- CreateIndex
-- `POST /api/transcripts/:id/shares` (spec §6.3) upserts on this pair — one
-- role per (transcript, user), never two competing rows.
CREATE UNIQUE INDEX "transcript_shares_transcript_id_user_id_key" ON "transcript_shares"("transcript_id", "user_id");

-- CreateIndex
-- One `transcript_exports` row per rendering job — mirrors
-- `database_backup_runs_job_id_key` exactly (see that model's own `jobId`
-- comment): a second render for the SAME job is unrepresentable.
CREATE UNIQUE INDEX "transcript_exports_job_id_key" ON "transcript_exports"("job_id");

-- CreateIndex
-- The reuse-by-content-hash lookup spec §8.5 names explicitly ("the index
-- issue #24 declares for exactly this lookup"). Not unique: an expired or
-- failed row may briefly coexist with a fresh one sharing the same key
-- before housekeeping removes the stale one. Named explicitly
-- (`map: "transcript_exports_lookup_idx"` in schema.prisma) because the
-- default four-column name is 64 bytes, one over PostgreSQL's 63-byte
-- identifier limit.
CREATE INDEX "transcript_exports_lookup_idx" ON "transcript_exports"("transcript_id", "version", "format", "options_hash");

-- AddForeignKey
-- Cascade: a transcript's only reason to exist is that exactly one user
-- owns it, and this application's access model has no path to it once its
-- owner is gone (no `transcripts:read_any`, spec §6.2). See the block
-- comment above the `Transcript` model for the full reasoning, including
-- the honestly-stated consequence for storage cleanup on a raw user delete.
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, not Cascade: a storage_objects row a transcript still
-- references may never be deleted out from under it by an unrelated
-- storage cleanup. The only path that may remove it is `transcript.purge`
-- deleting the referencing transcripts row first (spec §1.5.7, §10), which
-- Restrict permits freely.
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_source_object_id_fkey" FOREIGN KEY ("source_object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_playback_object_id_fkey" FOREIGN KEY ("playback_object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_raw_result_object_id_fkey" FOREIGN KEY ("raw_result_object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_speakers" ADD CONSTRAINT "transcript_speakers_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict: a speaker may not be deleted while a segment still names it.
-- `speaker.merge` (spec §4.1) re-points every segment away first, in the
-- same transaction, before deleting the source speaker rows.
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_speaker_id_fkey" FOREIGN KEY ("speaker_id") REFERENCES "transcript_speakers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, matching AuditEvent.actorUserId / Credential.updatedByUserId:
-- "who last hand-edited this line" is an audit fact, not something the
-- segment's own existence depends on.
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_edited_by_id_fkey" FOREIGN KEY ("edited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_versions" ADD CONSTRAINT "transcript_versions_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull: a version is permanent history (spec §4.5 — nothing ever deletes
-- a transcript_versions row short of purging the whole transcript) and must
-- survive its author's own account being deleted, the same audit posture as
-- DatabaseBackupRun.createdById. NULL already means "the AI" for a
-- different reason (the ingest handler never sets an author at all) — this
-- FK action only ever fires for a human-authored version whose author was
-- later deleted.
ALTER TABLE "transcript_versions" ADD CONSTRAINT "transcript_versions_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, matching every other storage_objects FK on this feature above.
ALTER TABLE "transcript_versions" ADD CONSTRAINT "transcript_versions_snapshot_object_id_fkey" FOREIGN KEY ("snapshot_object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_shares" ADD CONSTRAINT "transcript_shares_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade: a share row has no meaning once its recipient is gone.
ALTER TABLE "transcript_shares" ADD CONSTRAINT "transcript_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade: today the granter is always the owner, whose deletion already
-- cascades the transcript (and this row via transcript_id) regardless; see
-- the schema.prisma block comment for the full reasoning.
ALTER TABLE "transcript_shares" ADD CONSTRAINT "transcript_shares_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_exports" ADD CONSTRAINT "transcript_exports_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, matching every other storage_objects FK on this feature above.
ALTER TABLE "transcript_exports" ADD CONSTRAINT "transcript_exports_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, mirroring DatabaseBackupRun.jobId exactly: job.history.purge
-- deletes jobs rows on a retention schedule independent of this row's own
-- 7-day export expiry, and losing the LINK must never mean losing the
-- EXPORT.
ALTER TABLE "transcript_exports" ADD CONSTRAINT "transcript_exports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade: unlike every SetNull audit column elsewhere in this schema, an
-- export is a disposable, byte-for-byte reproducible artifact with a 7-day
-- expiry already built in — nothing is lost by deleting a pending/ready
-- export row alongside the account that requested it.
ALTER TABLE "transcript_exports" ADD CONSTRAINT "transcript_exports_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
