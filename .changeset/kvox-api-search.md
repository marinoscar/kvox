---
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-contract': minor
---

Add `@marinoscar/kvox-api/search` and `/search/testing`: `SearchModule.forRoot` (`GET /api/search`, the hybrid full-text and semantic ranking fused by reciprocal rank, snippets and cursors) and `SearchIndexingModule.forRoot` (the server-only `search.index` job, `SearchIndexService` with `enqueue` and `forget`, `GET /api/search/index-status` and `POST /api/search/index`) over the database, AI, jobs and identity ports, with a `SearchTranscriptVisibility` extension point for which transcripts a caller may see (the default is the owner's), configurable permission strings, a conformance kit (`describeSearchConformance`) and a fixture corpus (`seedSearchCorpus`) for the real-database test host. The routes declare no permission and narrow the searched types from the principal's `transcripts:read` and `notes:read`.

When the host's AI port reports no embeddings model, or one whose vectors are not 1536 wide (the width of the index column), search answers with full text only and says so.

`@marinoscar/kvox-contract/search` and `/errors`: `SEMANTIC_REASONS` and `KVOX_ERROR_CODES` gain `embeddings_unavailable` (added, never renamed); it is an additional value of the `semanticReason` enum in the generated API document.
