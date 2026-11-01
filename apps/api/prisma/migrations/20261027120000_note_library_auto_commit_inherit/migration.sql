-- AlterTable
-- `auto_commit` becomes tri-state (#779, ADR-0007): NULL follows the owner's graph preference
-- `review.autoCommitSafeRows` (on by default), true and false are the library's own choice.
ALTER TABLE "note_libraries" ALTER COLUMN "auto_commit" DROP NOT NULL,
ALTER COLUMN "auto_commit" DROP DEFAULT;

-- HAND-WRITTEN: every existing `false` only ever meant "never opted in" (the column defaulted to
-- false and the UI had no third state), so those libraries now follow the owner's preference.
-- A library that opted in (true) keeps its own choice.
UPDATE "note_libraries" SET "auto_commit" = NULL WHERE "auto_commit" = false;
