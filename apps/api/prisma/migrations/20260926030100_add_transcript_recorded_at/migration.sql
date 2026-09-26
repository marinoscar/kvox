-- Issue #352: when the recording was made. Additive, backfilled from
-- `created_at` (the upload instant) so the column is total and the fallback
-- is explicit and editable rather than implicit in every consumer.
ALTER TABLE "transcripts" ADD COLUMN "recorded_at" TIMESTAMPTZ;
UPDATE "transcripts" SET "recorded_at" = "created_at";
ALTER TABLE "transcripts"
  ALTER COLUMN "recorded_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "recorded_at" SET NOT NULL;
CREATE INDEX "transcripts_owner_id_recorded_at_idx" ON "transcripts" ("owner_id", "recorded_at" DESC);
