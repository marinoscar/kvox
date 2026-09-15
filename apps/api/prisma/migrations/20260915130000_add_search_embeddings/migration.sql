-- =============================================================================
-- Semantic search: pgvector storage for chunk embeddings (issue #181,
-- epic #165)
-- =============================================================================
--
-- Layer 1 (epic #164, the sibling migration `20260915120000_add_search_vectors`)
-- gave this application literal, lexical search over transcript/note content
-- via generated `tsvector` columns. This migration is layer 2: MEANING-based
-- search over the same content, via vectors an AI embedding model produces
-- and pgvector indexes for nearest-neighbour lookup. Nothing here replaces
-- layer 1 — a real search feature runs both and blends the results — and
-- nothing here runs any embedding model itself; this migration is storage
-- only. The pipeline that populates it (chunking, calling a provider,
-- writing rows here) is later issues in epic #165.
--
-- -----------------------------------------------------------------------------
-- `CREATE EXTENSION IF NOT EXISTS vector` IS REFUSED LOUDLY, NOT SILENTLY,
-- LONG BEFORE THIS MIGRATION EVER RUNS.
-- -----------------------------------------------------------------------------
--
-- This statement requires the `vector` extension's shared library to be
-- present on the PostgreSQL SERVER — not something any migration tool can
-- install by itself, and not something every managed-Postgres offering ships
-- by default. Issue #179 puts the check where a failure is actionable: `kvox
-- deploy`'s `database-vector-extension` preflight probes the target server
-- BEFORE any deploy proceeds, and refuses the deploy outright with a clear
-- operator-facing message if `vector` cannot be provided. By the time this
-- migration runs, that question has already been answered — this
-- `CREATE EXTENSION IF NOT EXISTS` is a re-affirmation of a fact the
-- preflight already established, not a probe of its own, and `IF NOT EXISTS`
-- only guards against re-running this migration idempotently, never against
-- the extension genuinely being unavailable.
--
-- THE REJECTED ALTERNATIVE: wrapping this statement in a `DO $$ ... $$` block
-- that catches the failure and skips creating the extension (and, by
-- extension, every table below that depends on it) when `vector` is absent.
-- That would trade one loud, pre-deploy refusal for permanent, silent,
-- PER-DEPLOYMENT schema drift: some installations would have semantic search
-- storage and some would not, indistinguishably, with nothing in the schema
-- itself recording which — and every query this feature ever issues would
-- have to probe `pg_extension` at runtime, forever, to find out which world
-- it is running in. A deployment that cannot provide `vector` should never
-- reach this migration in the first place; #179's preflight is what makes
-- that true, and this migration is written on the assumption that it did its
-- job.
--
-- -----------------------------------------------------------------------------
-- THREE TABLES
-- -----------------------------------------------------------------------------
--
-- `search_chunks` — one row per chunk of a document's text, independent of
-- any particular embedding model. `search_embeddings` — one row per
-- (chunk, model) vector, so multiple models (or a re-embed under a changed
-- model) can coexist without destroying history. `search_index_state` — one
-- row per DOCUMENT (not chunk), the legibility surface an admin/owner reads
-- to answer "is this searchable, and if not, why not".
--
-- -----------------------------------------------------------------------------
-- 1. `vector(1536)` IS A CONTRACT, NOT A DEFAULT.
-- -----------------------------------------------------------------------------
--
-- Postgres's `vector(n)` type is FIXED-WIDTH: a value produced by a model
-- with a different output dimensionality cannot be stored in this column at
-- all — not truncated, not padded, rejected outright at INSERT time. 1536 is
-- not picked because it is a good default; it is picked because it is the
-- width this deployment's embedding provider is configured to produce, and
-- the column is exactly as wide as that fact, no wider. `AiProvider`
-- (`src/ai/providers/ai-provider.interface.ts`) grows a sibling
-- `EMBEDDING_DIMENSIONS` constant as part of this same issue's line of work,
-- and `AiProviderRegistry` refuses to activate a provider whose embedding
-- model's width disagrees with it — AT APPLICATION BOOT, where an operator
-- reads a clear startup error, not inside a `search.embed` job at 3am where
-- the failure is a stack trace in a queue row nobody is watching. Say this
-- plainly: THIS COLUMN AND THAT CONSTANT ARE THE TWO HALVES OF ONE CONTRACT
-- and must always change together. Changing one without the other is not two
-- smaller changes, it is one change done incompletely — the database will
-- either reject every write (constant raised, column not) or silently accept
-- a narrower vector padded/misread by nothing in particular (this cannot
-- actually happen — pgvector rejects a width mismatch — but the point
-- stands: there is no partial, working state between them).
--
-- `search_embeddings.dimensions` is stored ANYWAY, despite the column type
-- already enforcing the width — not as a second constraint (Postgres already
-- enforces the real one) but as a RECORDED FACT about the row, independent of
-- whatever the column's declared width happens to be on the day the row is
-- read. The day a future issue widens this contract (a better model, a
-- migration to `vector(3072)` or similar), old rows and new rows will briefly
-- coexist under two different embedding models, and `dimensions` is what lets
-- a query or a backfill script tell them apart without re-deriving the width
-- from `octet_length`/array introspection every time.
--
-- -----------------------------------------------------------------------------
-- 2. `search_chunks.document_id` CARRIES NO FOREIGN KEY, IN EITHER DIRECTION —
--    THE SAME PRECEDENT `jobs.subject_type`/`subject_id` ALREADY SET.
-- -----------------------------------------------------------------------------
--
-- `document_type` (`'transcript'` | `'note'`) plus `document_id` is a
-- polymorphic reference, exactly the shape `jobs.subject_type`/`subject_id`
-- already uses in this schema (see the block comment above the `Job` model)
-- and for the identical reason: the set of document types this table indexes
-- is open-ended and code-owned, not a fixed pair of foreign keys Prisma could
-- express as two nullable relations. A fork adding a third searchable
-- document type costs this table zero migrations.
--
-- THE COST, STATED PLAINLY: an orphan row is POSSIBLE. Nothing at the
-- database level stops a `search_chunks` row from outliving the transcript
-- or note it was chunked from, the way a real foreign key would. THE
-- PROMISE, STATED EQUALLY PLAINLY: sweeping those rows is not a gap left for
-- someone to discover later, it is a responsibility handed to a named owner —
-- the deleting document's OWN purge handler. `transcript.purge` and
-- `note.purge` (both already existing, both already the sole path that
-- permanently removes a transcript or note) are wired by a later issue in
-- this epic to also delete their document's `search_chunks` rows (which
-- cascade to `search_embeddings` — see below) and its `search_index_state`
-- row, in the same job that already owns deleting everything else that
-- document's identity touches. This migration does not implement that sweep;
-- it states, here, that the sweep is owed and by whom.
--
-- -----------------------------------------------------------------------------
-- 3. HNSW, NOT IVFFLAT — CHOSEN FOR HOW EACH INDEX TYPE BEHAVES AGAINST A
--    TABLE THAT STARTS EMPTY.
-- -----------------------------------------------------------------------------
--
-- IVFFlat partitions the vector space into a fixed number of lists chosen at
-- BUILD time from the data the index is built against — building it against
-- an empty (or thinly populated) table produces a poor, effectively random
-- partitioning that keeps degrading as the real corpus grows past what the
-- index was originally trained on, and recovering good recall means
-- rebuilding the whole index from scratch against the grown corpus. HNSW
-- builds a NAVIGABLE GRAPH INCREMENTALLY, one vector at a time, and needs no
-- representative sample up front and no retraining as the corpus grows — the
-- graph a thousand vectors join is structurally the same kind of graph a
-- million will. THE INDEX BELOW IS THEREFORE CREATED ON A TABLE WITH ZERO
-- ROWS IN IT, because this migration runs before any document has ever been
-- embedded — and that is exactly fine for HNSW, and would have been a real
-- problem for IVFFlat, which is the whole reason this migration picks the
-- one it does.
--
-- -----------------------------------------------------------------------------
-- 4. `vector_cosine_ops` — MATCHED, ON PURPOSE, TO THE `<=>` OPERATOR THE
--    RANKING QUERY USES.
-- -----------------------------------------------------------------------------
--
-- This deployment's embedding provider returns NORMALISED vectors, so cosine
-- distance is what actually separates a relevant chunk from an irrelevant
-- one, and `<=>` (cosine distance) is the operator the ranking query is
-- written against. An HNSW index's operator class must MATCH the distance
-- operator a query uses, or pgvector cannot use the index for that query at
-- all — not "uses it less efficiently," SILENTLY FALLS BACK TO A SEQUENTIAL
-- SCAN, with no error, no warning, and a query plan that only reveals the
-- mismatch to someone who thinks to run `EXPLAIN`. `vector_cosine_ops` below
-- is not a stylistic pick among equivalent options; it is the specific
-- opclass that keeps this index reachable by `ORDER BY embedding <=>
-- $1 LIMIT n`, the query shape semantic search actually runs.
--
-- -----------------------------------------------------------------------------
-- 5. EMBEDDINGS ARE NOT A COLUMN ON THE DOCUMENT ROW.
-- -----------------------------------------------------------------------------
--
-- A `transcript`/`note` is a single row; its searchable content is many
-- chunks of text with independent character offsets. Storing "the"
-- embedding on the document row would force one of two bad shapes: either
-- one vector standing in for a whole document (useless for surfacing WHICH
-- part matched, which is what a search result's snippet needs), or an array
-- column of vectors with no per-chunk offsets to build that snippet from
-- and no way to re-embed one changed paragraph without rewriting the whole
-- array. A SEPARATE TABLE keyed on `(document_type, document_id, ordinal)`
-- makes re-indexing an edited document a per-chunk operation and gives every
-- match a `char_start`/`char_end` a snippet can be built from directly.
--
-- -----------------------------------------------------------------------------
-- 6. `content_hash` IS THE WHOLE POINT OF CONTENT ADDRESSING HERE.
-- -----------------------------------------------------------------------------
--
-- `content_hash` is `sha256` of a chunk's FINAL text. Re-indexing an edited
-- document re-chunks the whole thing, but only the chunks whose hash actually
-- changed need a fresh call to the embedding provider — an unchanged
-- paragraph's chunk keeps its existing embedding, no matter how far its
-- `ordinal` moved. The bill for every one of those provider calls lands on
-- the DOCUMENT OWNER'S OWN vendor account (the same strict bring-your-own-key
-- posture `docs/specs/notes.md` §9 already establishes for note generation),
-- so making a re-embed cheap is not merely an efficiency nicety, it is
-- directly what a re-index costs its owner in real vendor spend.
-- `UNIQUE (chunk_id, model)` is the constraint that makes this cheap in
-- practice: a repeat "does this (chunk, model) already have an embedding"
-- check is a single indexed lookup, not a table scan, and the pipeline this
-- migration exists to support relies on that lookup being cheap every time
-- it runs.
--
-- -----------------------------------------------------------------------------
-- STATUS: A REAL PRISMA ENUM. `document_type` AND `reason` STAY PLAIN TEXT.
-- THIS ASYMMETRY IS DELIBERATE, NOT AN OVERSIGHT.
-- -----------------------------------------------------------------------------
--
-- `search_index_state.status` (`pending`/`indexing`/`indexed`/`failed`/
-- `skipped`) is a CLOSED set this application itself owns end to end: every
-- value is written by code inside this repository, nothing external ever
-- proposes a new one, and a Prisma enum gives the compiler (not a runtime
-- check) the guarantee that every `.status` comparison in TypeScript is
-- exhaustive. `document_type` stays plain TEXT for the identical reason
-- `jobs.subject_type` does (see point 2 above and the `Job` model's own block
-- comment): the SET OF DOCUMENT TYPES is polymorphic and open to a fork's own
-- tables, which a Prisma enum — a closed set baked into the generated client
-- — is structurally the wrong tool to describe. `reason` (`ai_key_missing`,
-- `ai_not_configured`, `dimension_mismatch`, …) stays plain TEXT because it is
-- a DIAGNOSTIC STRING, not a state machine: it exists to be read by a human
-- debugging why one document did not index, it will grow new values as new
-- failure modes are discovered, and a `NULL` in this column for anything
-- other than `indexed` is itself informative (a `failed` row with no
-- `reason` is a bug in the code that set it). Three columns immediately
-- beside each other, three different answers to "should this be an enum",
-- stated here so the asymmetry reads as intentional rather than as three
-- decisions nobody thought about together.
--
-- -----------------------------------------------------------------------------
-- INTENTIONAL SCHEMA DRIFT — THE FIFTH OCCURRENCE OF THIS EXACT PATTERN.
-- -----------------------------------------------------------------------------
--
-- Prisma's schema DSL has no way to express `vector(1536)` as a column type
-- and no way to express `USING hnsw` as an index access method. In
-- `schema.prisma`, `search_embeddings.embedding` is declared
-- `Unsupported("vector(1536)")`, and the `search_embeddings_embedding_hnsw_idx`
-- index below exists ONLY in this file — `prisma migrate dev`/`diff` will
-- never regenerate it and must never be asked to "reconcile" it away. This is
-- the FIFTH occurrence of hand-written, Prisma-inexpressible schema in this
-- codebase, following (1) `jobs_active_dedup_uniq_idx` (a partial unique
-- index — `jobs` migration), (2) `database_backup_runs_active_uniq_idx` (the
-- same partial-unique pattern — `database_backup_runs` migration), (3)
-- `transcript_speakers_transcript_id_label_key` (a partial unique index over
-- labelled rows only — `transcripts` migration), and (4) the three generated
-- `tsvector` columns plus their GIN indexes in this migration's own sibling,
-- `20260915120000_add_search_vectors`. Each prior occurrence is Prisma
-- lacking DDL for a SQL feature this application genuinely needs; this one is
-- no different, and none of the five should be "fixed" by inventing a DSL
-- workaround that only obscures what is actually running against the
-- database.
--
-- -----------------------------------------------------------------------------
-- ⚠ A NOTE ON THE HNSW BUILD COST, IN THE SAME SPIRIT AS THIS MIGRATION'S
--   SIBLING'S `ACCESS EXCLUSIVE` WARNING.
-- -----------------------------------------------------------------------------
--
-- The index below is built against an empty table, so THIS MIGRATION is
-- instant — there is nothing yet to graph. That will not stay true forever:
-- rebuilding (or `REINDEX`ing) an HNSW index once `search_embeddings` holds a
-- real corpus is genuinely expensive CPU and memory work, proportional to the
-- number of rows and the graph's `m`/`ef_construction` parameters, and it is
-- governed by `maintenance_work_mem` — too small a setting during a later
-- rebuild materially slows the build and can spill to disk. An operator
-- planning a manual `REINDEX` against a populated table should raise
-- `maintenance_work_mem` for that session first, the same operational
-- awareness a large `ALTER TABLE` anywhere else in this codebase already
-- demands.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "SearchIndexStatus" AS ENUM ('pending', 'indexing', 'indexed', 'failed', 'skipped');

-- CreateTable: search_chunks — one row per chunk of a document's text. See
-- the header above (point 2) for why document_type/document_id carry no
-- foreign key, and point 5 for why chunks are not a column on the document.
CREATE TABLE "search_chunks" (
    "id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "char_start" INTEGER NOT NULL,
    "char_end" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "search_chunks_document_type_document_id_ordinal_key"
    ON "search_chunks"("document_type", "document_id", "ordinal");

-- CreateIndex
CREATE INDEX "search_chunks_document_type_document_id_idx"
    ON "search_chunks"("document_type", "document_id");

-- CreateIndex: content-addressing lookup (header point 6) — "does a chunk
-- with this exact text already exist" is a lookup this index makes cheap.
CREATE INDEX "search_chunks_content_hash_idx"
    ON "search_chunks"("content_hash");

-- CreateTable: search_embeddings — one (chunk, model) vector. See the header
-- (points 1, 3, 4, 6) for the column width contract, the HNSW choice, the
-- cosine opclass, and why UNIQUE(chunk_id, model) is what makes a repeat
-- embed cheap.
CREATE TABLE "search_embeddings" (
    "id" UUID NOT NULL,
    "chunk_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_embeddings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey: the one real FK in this migration — chunk_id points INSIDE
-- this same module's own table, unlike document_id above which points
-- sideways into another module's. See header point 2.
ALTER TABLE "search_embeddings"
    ADD CONSTRAINT "search_embeddings_chunk_id_fkey"
    FOREIGN KEY ("chunk_id") REFERENCES "search_chunks"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "search_embeddings_chunk_id_model_key"
    ON "search_embeddings"("chunk_id", "model");

-- CreateIndex: HAND-WRITTEN, Prisma-inexpressible. See the header's
-- "INTENTIONAL SCHEMA DRIFT" section (occurrence 5 of 5) and point 3 (why
-- HNSW, built empty, is correct here) and point 4 (why the opclass must be
-- vector_cosine_ops to match the `<=>` operator the ranking query uses).
CREATE INDEX "search_embeddings_embedding_hnsw_idx"
    ON "search_embeddings" USING hnsw ("embedding" vector_cosine_ops);

-- CreateTable: search_index_state — one row per DOCUMENT, the legibility
-- surface. owner_id is a REAL foreign key (it points at `users`, this
-- module's neighbour, the same way every other per-user table in this
-- schema does) and CASCADES: an index-state row for a document nobody owns
-- any more means nothing. See the header's "STATUS" section for why status
-- is an enum while document_type/reason stay plain text.
CREATE TABLE "search_index_state" (
    "id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "status" "SearchIndexStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "content_fingerprint" TEXT,
    "last_error" TEXT,
    "indexed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "search_index_state_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "search_index_state"
    ADD CONSTRAINT "search_index_state_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "search_index_state_document_type_document_id_key"
    ON "search_index_state"("document_type", "document_id");

-- CreateIndex: the unindexedCount query — "how many of this owner's
-- documents are in state X".
CREATE INDEX "search_index_state_owner_id_status_idx"
    ON "search_index_state"("owner_id", "status");
