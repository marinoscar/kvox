// =============================================================================
// GraphEmbedder (#364, epic #346; docs/specs/ontology.md §7, §11, §15)
// =============================================================================
//
// The batch embedding path for the graph: profile vectors for `kg.embed`, and
// mention vectors for resolution's kNN arm. It asks `KvoxAi.readiness` whether
// embedding is possible at all (same reasons the search indexer reports, same
// model/dimension contract, §7 "a second embedder is rejected"), and only then
// batches through `KvoxAi.embed`, which the search query path deliberately does
// one text at a time and never throws.
//
// Unlike the query path this one THROWS — its callers are queue jobs, where a
// swallowed error is a job reporting success having embedded nothing. The
// caller registers the per-user throttle key immediately before `embed`, so a
// 429 defers the right job on the right bucket.
//
// ⚠ The user's own key is resolved by the platform at the moment of the call;
// it never reaches this file.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';

import { KVOX_AI, type KvoxAiContext, type KvoxAiPort } from '../../ports/index.js';
import { SEARCH_EMBEDDING_DIMENSIONS, embeddingGateFor } from '../../search/index.js';
import {
  GRAPH_EXTRACTION_OPTIONS,
  type ResolvedGraphExtractionOptions,
} from '../graph-extraction.options.js';

/**
 * Whether the graph can embed for a user, and how.
 *
 * @stability experimental
 */
export type GraphEmbedderResolution =
  | {
      ok: true;
      providerId: string;
      /** The embedding model id — part of every profile hash. */
      model: string;
      maxBatchSize: number;
      /** One vector per text, in order. Throws on any provider failure. */
      embed: (texts: readonly string[]) => Promise<number[][]>;
    }
  | { ok: false; reason: string };

/**
 * GraphEmbedder: wiring the slice registers itself; a host configures it through `GraphExtractionModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphEmbedder {
  constructor(
    @Inject(KVOX_AI) private readonly ai: KvoxAiPort,
    @Inject(GRAPH_EXTRACTION_OPTIONS) private readonly options: ResolvedGraphExtractionOptions,
  ) {}

  /**
   * Whether `userId` can embed for the graph, and the function that does it.
   * `jobId` is the queue job running the call, so the usage row links to it.
   */
  async resolve(userId: string, jobId?: string): Promise<GraphEmbedderResolution> {
    const ctx: KvoxAiContext = { userId, orgId: null, feature: 'graph.embed', ...(jobId !== undefined ? { jobId } : {}) };

    // The search slice's gate: the host's embeddings model, and only when its vectors are
    // exactly as wide as the `vector(1536)` columns.
    let gate: ReturnType<typeof embeddingGateFor>;
    try {
      gate = embeddingGateFor(await this.ai.capabilities(ctx));
    } catch {
      // `capabilities` never throws by contract; a port that does is not configured.
      return { ok: false, reason: 'ai_not_configured' };
    }
    if (!gate.ok) return { ok: false, reason: gate.reason };

    const maxBatchSize = this.options.embeddingBatchSize;

    return {
      ok: true,
      providerId: 'openai',
      model: gate.model,
      maxBatchSize,
      embed: async (texts) => {
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += maxBatchSize) {
          const batch = texts.slice(i, i + maxBatchSize);
          const result = await this.ai.embed(ctx, { inputs: [...batch] });
          if (result.vectors.length !== batch.length) {
            throw new Error(
              `The embedding provider returned ${result.vectors.length} vector(s) for a ${batch.length}-input batch.`,
            );
          }
          for (const v of result.vectors) {
            if (v.length !== SEARCH_EMBEDDING_DIMENSIONS || !v.every((c) => Number.isFinite(c))) {
              throw new Error(
                `The embedding provider returned an unusable ${v.length}-component vector; ` +
                  `graph embeddings are exactly ${SEARCH_EMBEDDING_DIMENSIONS} components.`,
              );
            }
          }
          out.push(...result.vectors);
        }
        return out;
      },
    };
  }
}

/** pgvector's text input format, for a `${literal}::vector` bound parameter. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
