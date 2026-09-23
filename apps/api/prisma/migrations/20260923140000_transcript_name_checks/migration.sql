-- =============================================================================
-- AI-assisted transcript name checks (issue #328, epic #326)
-- =============================================================================
-- Two tables. See the block comment above `TranscriptNameCheck` in
-- schema.prisma for the full reasoning: a `TranscriptNameCheck` is one AI run
-- and a `TranscriptNameSuggestion` is one proposed edit it produced. Neither
-- is a second source of truth for transcript content — accepting a
-- suggestion is recorded as an ordinary `segment.update_text` op through the
-- existing `/operations` path and `TranscriptVersion` history, never a
-- direct write to `transcript_segments.text` from this migration's tables.

-- CreateEnum
CREATE TYPE "TranscriptNameCheckMode" AS ENUM ('standard', 'thorough');

-- CreateEnum
CREATE TYPE "TranscriptNameCheckStatus" AS ENUM ('pending', 'running', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "TranscriptNameSuggestionStatus" AS ENUM ('pending', 'accepted', 'rejected', 'stale');

-- CreateTable
CREATE TABLE "transcript_name_checks" (
    "id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "mode" "TranscriptNameCheckMode" NOT NULL,
    "status" "TranscriptNameCheckStatus" NOT NULL DEFAULT 'pending',
    "based_on_version" INTEGER NOT NULL,
    "terms" JSONB NOT NULL,
    "provider_id" TEXT,
    "model" TEXT,
    "candidate_count" INTEGER NOT NULL DEFAULT 0,
    "suggestion_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "error_class" TEXT,
    "error" TEXT,
    "job_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "transcript_name_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_name_suggestions" (
    "id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "segment_rev" INTEGER NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "original" TEXT NOT NULL,
    "replacement" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "status" "TranscriptNameSuggestionStatus" NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMPTZ,
    "decided_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_name_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transcript_name_checks_job_id_key" ON "transcript_name_checks"("job_id");

-- CreateIndex
CREATE INDEX "transcript_name_checks_transcript_id_created_at_idx" ON "transcript_name_checks"("transcript_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transcript_name_suggestions_check_id_status_idx" ON "transcript_name_suggestions"("check_id", "status");

-- CreateIndex
CREATE INDEX "transcript_name_suggestions_segment_id_idx" ON "transcript_name_suggestions"("segment_id");

-- AddForeignKey
ALTER TABLE "transcript_name_checks" ADD CONSTRAINT "transcript_name_checks_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_name_checks" ADD CONSTRAINT "transcript_name_checks_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_name_checks" ADD CONSTRAINT "transcript_name_checks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_name_suggestions" ADD CONSTRAINT "transcript_name_suggestions_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "transcript_name_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_name_suggestions" ADD CONSTRAINT "transcript_name_suggestions_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "transcript_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_name_suggestions" ADD CONSTRAINT "transcript_name_suggestions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
