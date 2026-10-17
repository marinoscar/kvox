# search

Ranked hybrid search over transcripts and notes (full text fused with meaning by reciprocal rank), and the `search.index` job that makes a document searchable by meaning, as two Nest modules a host configures with `SearchModule.forRoot` and `SearchIndexingModule.forRoot`.

## Purpose and scope

What the slice owns: `GET /api/search` (the query side: stopword handling, cursors tied to the search that minted them, snippets, the `semantic`/`semanticReason` degradation), the pure helpers behind it (`search-query`, `search-cursor`, `search-fusion` with `reciprocalRankFusion` and `RRF_K`, `search-snippet`, `search-semantic`), the indexing side (the `search.index` job, `SearchIndexService` with its two verbs `enqueue` and `forget`, `GET /api/search/index-status`, `POST /api/search/index`), the pure chunkers (`chunking/`: note and transcript chunkers, the packer, the content hash), and the structural database types (`data/search-db.ts`). What it does not own: the transcripts and notes it reads (their tables are installed by `@marinoscar/kvox-db`; the slice reads them with raw SQL only and imports neither slice), the rule for which transcripts a user may see (a host extension point), any AI call of its own (everything goes through `KVOX_AI`), and anything that needs the platform: the application's span attribute and the sharing-aware visibility rule stay in the host.

Status: experimental (issue #494). Every export carries `@stability experimental`.

### Quick start

```ts
import { SearchIndexingModule, SearchModule } from '@marinoscar/kvox-api/search';

@Module({
  imports: [
    SearchModule.forRoot({ semantic: { provider: 'openai' } }),
    SearchIndexingModule.forRoot({ batchSize: 128 }),
  ],
})
export class KvoxModule {}
```

The host binds `KVOX_PRISMA`, `KVOX_AI`, `KVOX_JOBS` and `KVOX_IDENTITY` first (`KvoxPortsModule.forRoot`); nothing else is needed. A test uses `createKvoxTestingModule` from `@marinoscar/kvox-api/testing`, and `seedSearchCorpus` from `@marinoscar/kvox-api/search/testing` for a real database.

### Data

The slice owns three tables, installed by `@marinoscar/kvox-db` (`kvox.search.prisma`):

- `search_chunks`: one row per chunk of a document's text. `document_type` and `document_id` are a polymorphic reference with NO foreign key, so an orphan row is possible and the deleting document's purge job owes the sweep (`SearchIndexService.forget`, `forgetOwnerDocuments`). Content addressing (`content_hash`) is what makes re-indexing an edited document re-embed only the chunks whose text moved.
- `search_embeddings`: one `vector(1536)` per (chunk, model), with an HNSW index on `vector_cosine_ops`. The column is `Unsupported` in Prisma and REQUIRED, so every write and every comparison is raw SQL with the literal assembled by hand; `chunk_id` is a real foreign key and cascades, which is why `forget` deletes chunks and says nothing about vectors.
- `search_index_state`: one row per document saying whether it is searchable by meaning and, if not, why (`reason` is plain text that grows new values). `owner_id` is a real foreign key.

It READS, and never writes, columns owned by the transcripts and notes slices: `transcripts` (`owner_id`, `title`, `status`, `deleted_at`, `current_version`, `updated_at` and the generated `title_search_vector`), `transcript_segments` (`text`, `start_ms`, `ordinal` and the generated `search_vector`), `transcript_speakers` (`display_name`) and `notes` (`title`, `body`, `deleted_at`, `current_version` and the generated `search_vector`). The `tsvector` columns are `GENERATED ALWAYS ... STORED` (a trigger would not fire under `pg_restore`); search depends on their EXISTENCE, which kvox-db installs, not on the code that writes the rows. Do not add a code import to "make the dependency explicit".

The vector width is a contract: 1536. A host whose embeddings model returns another width cannot store vectors, so semantic search is off for it (reason `embeddings_unavailable`) and no vector of another length is ever written. A per-model column or table is a later migration in `@marinoscar/kvox-db`.

### Permissions and settings

- Permissions: none declared. `GET /api/search` and the two index routes are `@KvoxAuth()` with no permission string, on purpose. The search route needs `transcripts:read` OR `notes:read`, which a guard that requires all declared permissions cannot express, so the service narrows from `principal.permissions` (read from `@CurrentKvoxPrincipal()`): a caller holding one gets that type searched (`searchedTypes` says which), a caller holding neither gets a 403. The strings are `SearchModuleOptions.typePermissions` and default to the web edition's (`DEFAULT_SEARCH_TYPE_PERMISSIONS`). This is the permissionless-route trap: the host's identity port must return the caller's permissions on a route that declares none (the web adapter does, and `apps/api/test/search/search-permissions.integration.spec.ts` proves it through the real guard stack). The index routes act only on the caller's own documents, scoped by `ownerId` in the query.
- Settings and secrets: none. The embeddings key is the caller's own, resolved by the host's AI adapter per call; no key reaches the slice.
- Job type: `search.index` (permanent), server-only (`usesAi`), `maxAttempts: 3`, `maxRuntimeMs` 15 minutes. There is deliberately no housekeeping cron: indexing spends the owner's own key, so it is enqueued only at named content events (a transcript ingested, a note generated, a correction committed) and by the explicit `POST /api/search/index`.

### Security notes

Search never answers a document the caller cannot read: every statement carries the visibility predicate INSIDE the candidate query's `LIMIT`, in both arms (filtering the top-K afterwards gives a user who owns 1% of the corpus an empty answer with no error), and the snippet query repeats it. Notes are not shareable and have no extension point. `q` is a string a stranger typed and reaches the database only as a bound parameter; every statement on the query path is a `SELECT`. The query embedder never throws: any `KvoxAiError`, a `KvoxRateLimitError` or anything else becomes `embedding_failed` and the full-text answer stands. The vendor's own message is never logged. A cursor minted for another caller, query, type filter, ranking version or semantic axis is a 400, never a silent restart. A rate limit in the `search.index` job is thrown as a `KvoxRateLimitError` naming the OWNER's per-user bucket (`aiProviderThrottleKey`), never a shared one.

### Conformance suite

`describeSearchConformance(name, factory, { describe, it, expect }, { permissions })` from `@marinoscar/kvox-api/search/testing` runs the real `SearchService` over a statement-answering database double and checks: `search.index` is registered under its permanent type and is server-only; the query path never throws for any `KvoxAiError` class, a rate limit or a throwing model or probe, and still returns the full-text hits with a reason; a host with no embeddings model (or one of the wrong width) answers `embeddings_unavailable` with hits and never spends an embedding call; a cursor from another caller is refused with a 400; a caller with one permission gets a partial answer and one with none gets a 403; every statement is a `SELECT`. `seedSearchCorpus(db)` writes two transcripts and two notes with known nonsense terms (`SEARCH_CORPUS_TERMS`) plus a second user who owns nothing, for real-database specs; `sparseVector` builds the unit vectors that make every similarity a number written down. The package runs the suite (`test/search-conformance.spec.ts`), the real-database proof is `test/search/search.db.spec.ts` on the test host, and the web application runs the same suite over its binding (`apps/api/test/conformance.spec.ts`).

## Entry point

`@marinoscar/kvox-api/search`, and `@marinoscar/kvox-api/search/testing` for tests. The slice depends on `ports` and `core` only (`packages/kvox-slices.json`), and imports `@marinoscar/kvox-contract/search` for the wire schemas and the `SEMANTIC_REASONS` vocabulary (`embeddings_unavailable` was added by this slice: add, never rename).

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core` and `zod`, which every slice needs, plus `@nestjs/swagger` and `nestjs-zod` (optional for the package, required by this slice: the controllers' OpenAPI decorators and DTO classes). Raw SQL is built with the `Prisma` helper of `core`, which loads `@prisma/client-runtime-utils` on first use. No generated client is imported. The per-slice data is `packages/kvox-slice-peers.json`.

## Configuration

`SearchModule.forRoot(options)` and `SearchIndexingModule.forRoot(options)` return non-global dynamic modules. `SearchModule` exports `SearchService` and `SearchQueryEmbedder` (the graph's embedder reuses its gate rather than growing a second model-and-dimension contract); `SearchIndexingModule` exports `SearchIndexService` (the transcripts and notes slices import it to queue a re-index and to forget a purged document). The package reads no environment variable.

| Option | Default | What it does |
|---|---|---|
| `SearchModule` `semantic.enabled` | `true` | Switches the vector arm off for the host; the answer says `embeddings_unavailable`. On, it still runs only when `KVOX_AI.capabilities()` reports a 1536-wide embeddings model. |
| `SearchModule` `semantic.provider` | `embeddings` | The label that, with the model the host reports, names the semantic axis of a cursor's fingerprint. Changing it (like changing the model) invalidates in-flight cursors. |
| `SearchModule` `semantic.onSemanticOff` | none | Called, at most once per request, with the reason the vector arm did not run; the web edition records the span attribute `kvox.search.semantic_reason`. A throwing hook is ignored. |
| `SearchModule` `transcriptVisibility` | `OwnerOnlyTranscriptVisibility` | A `Type<SearchTranscriptVisibility>`: which transcripts a caller may see. |
| `SearchModule` `typePermissions` | `{ transcript: 'transcripts:read', note: 'notes:read' }` | The permission each type needs. |
| `SearchIndexingModule` `batchSize` | `128` | The most chunk texts one embeddings request carries. |

The routes document themselves through `documentKvoxAuth` (called by `forRoot`): the host decides how an authenticated route is described with `setKvoxAuthDocumenter` from `core`.

When the host's AI port cannot embed, search answers with full text only and says why in `semanticReason`: `ai_not_configured` (the host is not set up, or the model is not available), `ai_key_missing` (the caller has saved no key), `embeddings_unavailable` (no embeddings model, or vectors that are not 1536 wide; logged once at warn level naming the model and the width), `no_indexed_content`, or `embedding_failed` (the call failed after it was allowed to run).

## Extension-point catalog

| Symbol | What a host does with it |
|---|---|
| `SearchTranscriptVisibility`, `SearchModuleOptions.transcriptVisibility` | The host's rule for which transcripts a caller may see: `viewerFor`, `transcriptVisibleSql` (a condition on the aliased table that excludes soft-deleted rows) and `run` (the scope the statements execute in). The default is the owner's live transcripts; the web edition adds the ones shared with the caller. |
| `SEARCH_TRANSCRIPT_VISIBILITY` | The token under which the module provides the visibility rule. |
| `SearchModuleOptions.semantic.onSemanticOff` | The hook that learns why the vector arm did not run. |
| `KvoxSearchDb` | The narrowed database client the slice casts `KVOX_PRISMA` to; the host proves its client satisfies it with a compile-time assignment. |
| `describeSearchConformance`, `SearchConformanceTarget` | The conformance kit and the binding it is run against. |
| `seedSearchCorpus` | Writes the fixture corpus for a real-database spec. |

### Desktop

Search is full text offline; the semantic arm needs a 1536-dimension embedder behind `KVOX_AI.embed`, and otherwise answers `embeddings_unavailable`. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#offline-constraints-feature-by-feature).
