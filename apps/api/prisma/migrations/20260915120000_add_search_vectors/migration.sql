-- =============================================================================
-- Full-text search: generated tsvector columns + GIN indexes (issue #174,
-- epic #164)
-- =============================================================================
--
-- ⚠ THIS MIGRATION TAKES `ACCESS EXCLUSIVE` ON THREE TABLES AND REWRITES
-- THEM: `transcript_segments`, `notes`, `transcripts`. `ADD COLUMN ...
-- GENERATED ALWAYS AS (...) STORED` is not a metadata-only change — Postgres
-- computes the expression for every existing row and rewrites the whole
-- table to store it, holding `ACCESS EXCLUSIVE` on that table for the
-- duration (no reads, no writes, nothing, from any other session). On a
-- large corpus this is MINUTES of a hard lock per table. An operator running
-- this against production must plan a maintenance window (or accept the
-- outage) exactly the way a large `ALTER TABLE` anywhere else in this
-- codebase would require — this is not a `CREATE INDEX CONCURRENTLY`
-- migration and cannot be made into one, because a generated column's
-- initial computation is inherently a table rewrite, not an index build.
--
-- AND THAT REWRITE IS THE BACKFILL. There is no job, no API key, no
-- on-demand action, no cron sweep that populates these columns after the
-- fact. The moment this migration commits, `search_vector`/
-- `title_search_vector` exist and are already correct for every row already
-- in the table, because Postgres computed them as part of the same rewrite
-- that added the column. Every transcript segment, every note, every
-- transcript title already in this database is searchable the instant this
-- lands, with zero application code ever running. That is the entire reason
-- full-text search is layer 1 of epic #164: it needed no ingestion pipeline
-- of its own, only this one migration.
--
-- GENERATED COLUMNS, NOT TRIGGERS — and the reason is RESTORE, not tidiness.
-- This repository ships a real database restore
-- (docs/specs/database-restore.md), and `pg_restore` loads data with
-- `session_replication_role = replica` in effect for the load session (the
-- same mode `pg_restore --disable-triggers` documents). A regular
-- `AFTER INSERT/UPDATE` trigger DOES NOT FIRE under that mode — so a
-- trigger-based implementation would restore a database that LOOKS whole
-- (every row present, every column present) but whose search index is
-- silently empty, with nothing anywhere — no error, no warning, no failed
-- job — telling anyone it happened. A `GENERATED ... STORED` column is
-- computed by the storage layer itself on every tuple, independent of
-- triggers and independent of `session_replication_role`, and cannot be
-- switched off by a restore path that has no idea this column exists.
--
-- THE TWO-ARGUMENT `to_tsvector(regconfig, text)` FORM IS LOAD-BEARING.
-- `to_tsvector(text)` — the one-argument form — is STABLE, not IMMUTABLE:
-- it reads `default_text_search_config` from session state to decide which
-- configuration to use, and a generated column's expression is REQUIRED by
-- Postgres to be IMMUTABLE (a value that must be recomputable identically
-- from the row alone, forever, independent of session/GUC state). Postgres
-- enforces this at `ALTER TABLE` time — `ADD COLUMN ... GENERATED ALWAYS AS
-- (to_tsvector(coalesce(text, '')))  STORED` is REJECTED outright with
-- "generation expression is not immutable". The two-argument form used
-- below, with `'english'::regconfig` as an explicit literal, has no such
-- session dependency and IS immutable — it is the ONLY form Postgres will
-- accept here. Do not "simplify" this to the one-argument form: it does not
-- merely behave differently, it does not apply at all, and the failure mode
-- is this whole migration erroring out rather than something subtly wrong.
-- A successful `prisma migrate` against a real Postgres (as this issue's
-- verification step requires) is the actual proof the expression is
-- immutable — there is no static check that substitutes for it.
--
-- THE `'english'` CONFIGURATION IS A DELIBERATE, STATED v1 LIMITATION, not
-- an oversight. `transcripts.language` exists and is nullable, so a
-- per-row configuration is technically expressible (Postgres allows a
-- generated expression to reference sibling columns) — but it would need a
-- `regconfig` cast built from arbitrary, unvalidated row data (an invalid
-- or unrecognized language string then fails the whole insert/update, not
-- just the search feature), and a GIN index built against a per-row-varying
-- configuration is effectively unusable for a query issued before the
-- caller knows which language a given row is in. One corpus-wide
-- configuration, stated plainly here, is the v1 choice; a later issue can
-- revisit it once there is a real multi-language corpus to justify the
-- complexity. The cost of this choice: English-language stemming
-- ("discussed" matching "discuss") is WRONG for non-English content —
-- `to_tsvector('english', ...)` will still tokenize non-English text, so
-- exact-token matching keeps working, but stemming, stop-word removal and
-- ranking are all tuned for English regardless of what a row actually
-- contains.
--
-- WHY `notes.search_vector` IS WEIGHTED A/B AND `transcript_segments
-- .search_vector` IS NOT: a note has a `title` the user themselves wrote
-- and a `body` the AI generated (or the user has since edited) — a hit in
-- the title is real, human-authored evidence the note is about that term,
-- and `setweight(..., 'A')` on the title plus `setweight(..., 'B')` on the
-- body lets `ts_rank`/`ts_rank_cd` reflect that when a search matches both
-- lists. A `transcript_segments` row is one line of spoken text with no
-- title of its own to weight against — there is nothing to distinguish, so
-- its vector is a single unweighted `to_tsvector` over `text`.
--
-- WHY `transcripts.title_search_vector` EXISTS AS ITS OWN COLUMN rather
-- than being folded into (or replaced by) the segment vector: a
-- transcript's title lives on the PARENT row, one string, while its
-- segments are a separate child table with a many-to-one relationship back
-- to it. A title match has to be able to surface a transcript that has NO
-- matching segment at all (a recording titled "Q3 Pricing Review" whose
-- spoken content never says the word "pricing") — which is only possible
-- if the title has its own indexed vector to match against, independent of
-- whatever its segments do or do not contain.
--
-- INTENTIONAL SCHEMA DRIFT, named the same way `jobs_active_dedup_uniq_idx`
-- and `database_backup_runs_active_uniq_idx` are named elsewhere in this
-- repository: every generation expression below, and all three GIN
-- indexes, are HAND-WRITTEN in this file only. `schema.prisma` has no DSL
-- for a generated column's expression and no DSL for an index's access
-- method (`USING gin`) — the Prisma model below can only declare the
-- columns exist (as `Unsupported("tsvector")?`) and point a reader here.
-- `prisma migrate dev`/`diff` will never regenerate this file's contents
-- and must never be asked to "reconcile" it away. This is the fourth
-- occurrence of this exact pattern in this schema (`jobs`,
-- `database_backup_runs`, `transcript_speakers` before it) — see each of
-- those tables' own migration headers for the precedent.
-- =============================================================================

-- AlterTable: transcript_segments — unweighted, one line of speech with no
-- title of its own. See the header above for why the two-argument
-- `to_tsvector` form is REQUIRED (the one-argument form is rejected as
-- non-immutable).
ALTER TABLE "transcript_segments"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("text", ''))) STORED;

-- CreateIndex
CREATE INDEX "transcript_segments_search_vector_idx"
  ON "transcript_segments" USING GIN ("search_vector");

-- AlterTable: notes — weighted A (title, human-authored) / B (body,
-- AI-generated or user-edited). See the header above for the ranking
-- argument this weighting exists to support.
ALTER TABLE "notes"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce("body", '')), 'B')
  ) STORED;

-- CreateIndex
CREATE INDEX "notes_search_vector_idx"
  ON "notes" USING GIN ("search_vector");

-- AlterTable: transcripts — the title lives on the parent row and must be
-- searchable even when no child segment matches at all. See the header
-- above for why this is a separate column rather than folded into the
-- segment vector.
ALTER TABLE "transcripts"
  ADD COLUMN "title_search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("title", ''))) STORED;

-- CreateIndex
CREATE INDEX "transcripts_title_search_vector_idx"
  ON "transcripts" USING GIN ("title_search_vector");
