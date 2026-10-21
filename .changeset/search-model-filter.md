---
'@marinoscar/kvox-api': patch
---

Semantic search only compares vectors of the active embedding model (the vector candidates and the indexed-content probe filter on `search_embeddings.model`); the similarity floor is per model (`capabilities().embeddings.minSimilarity`, default 0.25); queries embed with `purpose: 'query'` and chunks with `purpose: 'document'`; `search_embeddings.dimensions` records the model's native width; re-indexing deletes a document's vectors of other models.
