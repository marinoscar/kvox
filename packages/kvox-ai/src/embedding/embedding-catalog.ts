import type { KvoxEmbeddingCapability } from '../types/index.js';

// =============================================================================
// The embedding catalog (issue #475, epic #472)
// =============================================================================
//
// What this app's embedding model can do, as a static description: an indexer
// sizes its batches and refuses an over-long chunk BEFORE spending a request on
// the user's own account. Search and the graph import `EMBEDDING_DIMENSIONS` and
// `KVOX_EMBEDDING` from here; nothing else declares a width.
//
// ⚠ `EMBEDDING_DIMENSIONS` IS A CONTRACT, NOT A DEFAULT, AND IT HAS TWO HALVES.
// The other half is the database column, `vector(1536)`; the two are the same
// decision written in two places, which is why this is an exported named
// constant rather than a literal in each. A model whose output is 768 or 3072
// wide cannot be stored AT ALL: it is an `INSERT` that fails, not a degraded
// experience.
//
// ⚠ CHANGING IT IS A MIGRATION, NOT AN EDIT. Every stored vector was produced by
// a model of this width, and a corpus of mixed widths is not searchable by any
// distance function: a width change means a new column and a full re-index.
//
// ⚠ THE MODEL ID IS PERMANENT ONCE VECTORS ARE STORED UNDER IT. Two models'
// vectors are not comparable even at identical widths, so changing the id
// silently degrades every search over already-indexed content until the corpus
// is re-embedded. `search_embeddings` rows record it.
//
// ⚠ `maxBatchSize` IS 128 ON PURPOSE. The platform `embed()` accepts up to 256
// inputs; this app keeps 128 so a failed batch (the retry unit) wastes less of
// the user's money and quota.
// =============================================================================

/**
 * The width of every stored vector. Matches the `vector(1536)` columns.
 *
 * @stability experimental
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * The provider that serves the embedding model.
 *
 * @stability experimental
 */
export const KVOX_EMBEDDING_PROVIDER = 'openai';

/**
 * The embedding model and its limits.
 *
 * @stability experimental
 */
export const KVOX_EMBEDDING: KvoxEmbeddingCapability & {
  /** The provider that serves the embedding model. */
  provider: string;
} = {
  provider: KVOX_EMBEDDING_PROVIDER,
  model: 'text-embedding-3-small',
  dimensions: EMBEDDING_DIMENSIONS,
  maxInputTokens: 8191,
  maxBatchSize: 128,
};

/**
 * The embeddings provider answered with a batch this app cannot store: a different
 * number of vectors than texts (`count`), or a vector that is not exactly
 * `EMBEDDING_DIMENSIONS` finite numbers (`dimension`).
 *
 * A plain `Error` subclass, so the queue treats it as retryable like any provider
 * fault; the search indexer reads `kind` to report its `dimension_mismatch` status
 * reason. It carries counts and widths only, never a vector or a text.
  *
  * @stability experimental
 */
export class EmbeddingShapeError extends Error {
  constructor(
    /** `count`: a different number of vectors than texts; `dimension`: a vector of the wrong width. */
    readonly kind: 'count' | 'dimension',
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingShapeError';
    Object.setPrototypeOf(this, EmbeddingShapeError.prototype);
  }
}
