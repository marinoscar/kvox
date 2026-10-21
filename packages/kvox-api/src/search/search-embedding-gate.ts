import type { KvoxAiCapabilities } from '../ports/index.js';
import { SEARCH_EMBEDDING_DIMENSIONS } from './search.options.js';

// =============================================================================
// Can this caller embed at all? (issue #494, epic #491)
// =============================================================================
//
// ONE QUESTION, ANSWERED FROM ONE PORT CALL, for the three places that ask it:
// the query embedder (can this searcher's query become a vector), the index
// handler (can this document's owner's text become vectors) and the index status
// service (can this caller index their library). All three read
// `KVOX_AI.capabilities()` and spell the answer the way the published reasons
// always have been spelled; this function is the only place that spelling lives.
//
//   available: false, reason `ai_key_missing`   the person has saved no key
//   available: false, anything else             the deployment is not set up
//   available, `embeddings: null`               the host has no embeddings model
//   available, a width other than 1536          the host's model cannot be stored
//
// ⚠ A WIDTH OTHER THAN 1536 IS A REFUSAL, NEVER A TRUNCATION OR A PAD. The index
// column is `vector(1536)` and a vector of any other length is not comparable
// with the ones already stored. The AI port may zero-pad a declared narrower
// model exactly (it then reports `dimensions: 1536` and the model's true width
// as `nativeDimensions`); search itself never pads or truncates.
// =============================================================================

/** The reasons a gate can refuse with. All are published `SEMANTIC_REASONS`.
 *
 * @stability experimental
 */
export type EmbeddingGateReason = 'ai_not_configured' | 'ai_key_missing' | 'embeddings_unavailable';

/**
 * The gate let embedding through.
 *
 * @stability experimental
 */
export interface EmbeddingGateOpen {
  /** Discriminant. */
  ok: true;
  /** The embeddings model to embed with. */
  model: string;
  /** The STORAGE width of its vectors: always 1536. */
  dimensions: number;
  /** The model's true width when the port zero-pads it to 1536; recorded in `search_embeddings.dimensions`. */
  nativeDimensions?: number;
  /** The model's own cosine floor for the semantic arm; absent means the default. */
  minSimilarity?: number;
}

/**
 * The gate refused.
 *
 * @stability experimental
 */
export interface EmbeddingGateClosed {
  /** Discriminant. */
  ok: false;
  /** Why not: a published semantic reason. */
  reason: EmbeddingGateReason;
  /** Set when the host offered a model of the wrong width, so the caller can log it. */
  mismatch?: EmbeddingMismatch;
}

/**
 * A model the index cannot store, as the host reported it.
 *
 * @stability experimental
 */
export interface EmbeddingMismatch {
  /** The model id. */
  model: string;
  /** The width of its vectors. */
  dimensions: number;
}

/**
 * What {@link embeddingGateFor} decided.
 *
 * @stability experimental
 */
export type EmbeddingGate = EmbeddingGateOpen | EmbeddingGateClosed;

/**
 * Decides, from the AI port's capabilities, whether embedding can run.
 *
 * @param capabilities - the answer of `KVOX_AI.capabilities(ctx)` for the `search.embed` feature.
 * @returns the model and width to use, or the reason it cannot.
 * @stability experimental
 */
export function embeddingGateFor(capabilities: KvoxAiCapabilities): EmbeddingGate {
  if (!capabilities.available) {
    return {
      ok: false,
      reason: capabilities.reason === 'ai_key_missing' ? 'ai_key_missing' : 'ai_not_configured',
    };
  }

  const embeddings = capabilities.embeddings;

  if (embeddings === null) return { ok: false, reason: 'embeddings_unavailable' };

  if (embeddings.dimensions !== SEARCH_EMBEDDING_DIMENSIONS) {
    return {
      ok: false,
      reason: 'embeddings_unavailable',
      mismatch: { model: embeddings.model, dimensions: embeddings.dimensions },
    };
  }

  return {
    ok: true,
    model: embeddings.model,
    dimensions: embeddings.dimensions,
    ...(embeddings.nativeDimensions !== undefined && { nativeDimensions: embeddings.nativeDimensions }),
    ...(embeddings.minSimilarity !== undefined && { minSimilarity: embeddings.minSimilarity }),
  };
}
