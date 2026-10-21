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
 * One embedding model a host can choose, as a static description.
 *
 * @remarks
 * `dimensions` is the model's NATIVE output width; `storageDimensions` is the
 * width of the database column ({@link EMBEDDING_DIMENSIONS}). A model narrower
 * than the column is zero-padded by the AI port (see `createKvoxAi`), so one
 * `vector(1536)` column holds every catalog entry; the model id recorded on each
 * row keeps the spaces apart.
 *
 * @stability experimental
 */
export interface KvoxEmbeddingModel extends KvoxEmbeddingCapability {
  /** The provider that serves the model (`local` for an on-device model). */
  provider: string;
  /** The model's native output width (what the runtime returns per vector). */
  dimensions: number;
  /** The width of every STORED vector: always {@link EMBEDDING_DIMENSIONS}. */
  storageDimensions: typeof EMBEDDING_DIMENSIONS;
  /** True when the model needs no user key (an on-device model): readiness then ignores the chat provider and keys. */
  keyless: boolean;
  /** Prepended to a text embedded for a search QUERY (asymmetric retrieval models). */
  queryPrefix?: string;
  /** Prepended to a text embedded as a DOCUMENT. */
  documentPrefix?: string;
  /** The cosine similarity below which a semantic hit is noise, when the model needs a floor. */
  minSimilarity?: number;
}

/**
 * The embedding model and its limits (the web edition's: OpenAI, 1536 wide).
 *
 * @stability experimental
 */
export const KVOX_EMBEDDING: KvoxEmbeddingModel = {
  provider: KVOX_EMBEDDING_PROVIDER,
  model: 'text-embedding-3-small',
  dimensions: EMBEDDING_DIMENSIONS,
  storageDimensions: EMBEDDING_DIMENSIONS,
  maxInputTokens: 8191,
  maxBatchSize: 128,
  keyless: false,
};

/**
 * The on-device embedding model KVox Desktop plugs in: bge-small-en-v1.5, 384
 * wide, stored zero-padded in the 1536-wide column.
 *
 * @remarks
 * The id names the int8-QUANTIZED build: its vectors differ from fp32's, and the
 * id is permanent once vectors are stored under it. `minSimilarity` 0.45 was
 * measured with the query prefix: relevant pairs 0.51-0.80, unrelated 0.28-0.55.
 *
 * @stability experimental
 */
export const KVOX_LOCAL_EMBEDDING: KvoxEmbeddingModel = {
  provider: 'local',
  model: 'bge-small-en-v1.5-int8',
  dimensions: 384,
  storageDimensions: EMBEDDING_DIMENSIONS,
  maxInputTokens: 512,
  maxBatchSize: 32,
  keyless: true,
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  minSimilarity: 0.45,
};
