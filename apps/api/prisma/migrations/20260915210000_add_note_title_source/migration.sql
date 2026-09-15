-- =============================================================================
-- `notes.title_source` (issue #180, epic #163)
-- =============================================================================
-- A title had no provenance until this column: nothing distinguished a name
-- the user typed from one the product guessed on the note's behalf. Without
-- it, a `regenerate` or a future bulk-retitle pass has no way to know a
-- note's owner already renamed it, and would silently overwrite a
-- human-chosen title with an AI guess — that is the failure mode this column
-- exists to make impossible rather than merely avoided.
--
-- Three values: `ai` (the model proposed it), `user` (a person typed it —
-- STICKY, the one value the AI titling path must never overwrite), and
-- `template` (nobody has chosen one yet; the note is still wearing the name
-- of the template/source it came from).
--
-- BACKFILL IS FREE. The column default applies to every existing row via a
-- single metadata change (`ADD COLUMN ... NOT NULL DEFAULT 'template'` needs
-- no table rewrite for a fixed non-null default on modern Postgres), and
-- `template` is the truthful value for every one of them: `notes.service.ts`
-- has always fallen back to the source template's `name` when generating a
-- note's initial title, so there is no row in this table today whose title
-- came from anywhere else. No data migration, no UPDATE pass, nothing to get
-- wrong.
-- =============================================================================

-- CreateEnum
CREATE TYPE "NoteTitleSource" AS ENUM ('ai', 'user', 'template');

-- AlterTable
ALTER TABLE "notes" ADD COLUMN "title_source" "NoteTitleSource" NOT NULL DEFAULT 'template';
