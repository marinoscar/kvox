-- =============================================================================
-- `body_format` on `note_templates` and `notes` (issue #334)
-- =============================================================================
-- The markdown-vs-plain-text SYNTAX a note body is written in — a separate
-- axis from `output_format`, which names the document TYPE (meeting notes,
-- summary, …) rather than how its text is styled. Plain TEXT column, not an
-- enum, same reasoning as `output_format`: validated by Zod in the API
-- ('markdown' | 'plain_text'), not by a database enum.
--
-- `note_templates.body_format` is the author's choice, read by
-- `assemblePrompt` alongside the other structured fields (spec §2.x).
-- `notes.body_format` is SNAPSHOTTED from the generating template's
-- `body_format` at generation time, never a live read of the template — so a
-- later edit to a template's body format never changes how an
-- already-generated note renders, the identical snapshot reasoning
-- `note_generations`'s context columns (#307) already establish for prompts.
--
-- Defaulted to 'markdown' for both existing rows and new ones: every
-- built-in and custom template predating this issue already asks the AI to
-- write markdown in practice, and every existing note's body is markdown.
-- =============================================================================

-- AlterTable
ALTER TABLE "note_templates" ADD COLUMN "body_format" TEXT NOT NULL DEFAULT 'markdown';

-- AlterTable
ALTER TABLE "notes" ADD COLUMN "body_format" TEXT NOT NULL DEFAULT 'markdown';
