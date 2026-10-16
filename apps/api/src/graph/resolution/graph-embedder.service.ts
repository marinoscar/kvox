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

import { EMBEDDING_DIMENSIONS } from '../../ai-port/embedding-catalog';
import { KVOX_AI, type KvoxAi } from '../../ai-port/kvox-ai';
import { searchReasonFor } from '../../search/indexing/job-types';

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

@Injectable()
export class GraphEmbedder {
  constructor(@Inject(KVOX_AI) private readonly ai: KvoxAi) {}

  /**
   * Whether `userId` can embed for the graph, and the function that does it.
   * `jobId` is the queue job running the call, so the usage row links to it.
   */
  async resolve(userId: string, jobId?: string): Promise<GraphEmbedderResolution> {
    const readiness = await this.ai.readiness(userId, 'graph_embed');
    const gate = searchReasonFor(readiness);
    if (gate !== null) return { ok: false, reason: gate };

    const capability = this.ai.embeddingCapability();
    const maxBatchSize = Math.max(1, capability.maxBatchSize);

    return {
      ok: true,
      providerId: readiness.provider ?? 'openai',
      model: capability.model,
      maxBatchSize,
      embed: async (texts) => {
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += maxBatchSize) {
          const batch = texts.slice(i, i + maxBatchSize);
          const result = await this.ai.embed({
            userId,
            feature: 'graph_embed',
            ...(jobId !== undefined ? { jobId } : {}),
            texts: [...batch],
          });
          if (result.vectors.length !== batch.length) {
            throw new Error(
              `The embedding provider returned ${result.vectors.length} vector(s) for a ${batch.length}-input batch.`,
            );
          }
          for (const v of result.vectors) {
            if (v.length !== EMBEDDING_DIMENSIONS || !v.every((c) => Number.isFinite(c))) {
              throw new Error(
                `The embedding provider returned an unusable ${v.length}-component vector; ` +
                  `graph embeddings are exactly ${EMBEDDING_DIMENSIONS} components.`,
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
