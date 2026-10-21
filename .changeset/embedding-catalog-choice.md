---
'@marinoscar/kvox-ai': minor
'@marinoscar/kvox-api': minor
---

The embedding model is a catalog entry the host chooses. `@marinoscar/kvox-ai` adds `KvoxEmbeddingModel` and `KVOX_LOCAL_EMBEDDING` (bge-small-en-v1.5-int8, 384 wide, keyless), `createKvoxAi({ embedding })` (default unchanged: OpenAI text-embedding-3-small, 1536), zero-padding of a narrower model to the 1536-wide column, and a `purpose` on embed requests that selects the query or document prefix. `EmbeddingShapeError` (unused) is removed. `@marinoscar/kvox-api` adds optional `nativeDimensions` and `minSimilarity` to `KvoxEmbeddingsInfo` and `purpose` to the port's `embed` request.
