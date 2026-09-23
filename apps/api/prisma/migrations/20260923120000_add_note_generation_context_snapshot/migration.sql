-- =============================================================================
-- `note_generations` context snapshot (issue #307)
-- =============================================================================
-- A snapshot of WHAT WAS SENT to the AI provider — the exact
-- `assemblePrompt()` output (apps/api/src/notes/generation/prompt.ts) —
-- written BEFORE the provider call so a failed generation still records it.
--
-- `system_prompt`/`user_content` are the two halves of the assembled prompt.
-- `source_version` is the transcript `currentVersion` / source note
-- `currentVersion` actually materialized for the prompt; NULL for a document
-- source, which carries no version. `context_captured_at` is when the
-- snapshot was taken, not when the generation itself completed.
--
-- NULL across all four columns means the generation predates issue #307 —
-- deliberately no backfill, because re-materializing the source today would
-- fabricate history: the source transcript/note may have been corrected
-- since, and the template may have been edited since.
-- =============================================================================

-- AlterTable
ALTER TABLE "note_generations" ADD COLUMN "system_prompt" TEXT,
ADD COLUMN "user_content" TEXT,
ADD COLUMN "source_version" INTEGER,
ADD COLUMN "context_captured_at" TIMESTAMPTZ;
