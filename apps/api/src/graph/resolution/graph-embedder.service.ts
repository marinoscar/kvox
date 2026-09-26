// =============================================================================
// GraphEmbedder (#364, epic #346; docs/specs/ontology.md §7, §11, §15)
// =============================================================================
//
// The batch embedding path for the graph: profile vectors for `kg.embed`, and
// mention vectors for resolution's kNN arm. NOT a second embedder — it asks
// `SearchQueryEmbedder.resolve(userId)` whether embedding is possible at all
// (same reasons, same order, same model/dimension contract, §7 "a second
// embedder is rejected"), and only then batches through the same provider's
// `embed`, which the query path deliberately cannot (one text, never throws).
//
// Unlike the query path this one THROWS — its callers are queue jobs, where a
// swallowed error is a job reporting success having embedded nothing. The
// caller registers the per-user throttle key through `beforeCall` so a 429
// defers the right job on the right bucket.
//
// ⚠ The user's own key: resolved at the moment of use, never stored on a
// field, never logged.
// =============================================================================

import { Injectable } from '@nestjs/common';

import { AiProviderRegistry } from '../../ai/ai-provider.registry';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { createProviderContext, EMBEDDING_DIMENSIONS } from '../../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import { SearchQueryEmbedder } from '../../search/search-query-embedder.service';

export type GraphEmbedderResolution =
  | {
      ok: true;
      providerId: string;
      /** The provider's embedding model id — part of every profile hash. */
      model: string;
      maxBatchSize: number;
      /** One vector per text, in order. Throws on any provider failure. */
      embed: (texts: readonly string[]) => Promise<number[][]>;
    }
  | { ok: false; reason: string };

@Injectable()
export class GraphEmbedder {
  constructor(
    private readonly queryEmbedder: SearchQueryEmbedder,
    private readonly settings: AiSettingsService,
    private readonly providers: AiProviderRegistry,
    private readonly credentials: UserAiCredentialsService,
  ) {}

  async resolve(userId: string): Promise<GraphEmbedderResolution> {
    const gate = await this.queryEmbedder.resolve(userId);
    if (!gate.ok) return { ok: false, reason: gate.reason };

    const policy = await this.settings.get();
    const provider = policy.provider ? this.providers.get(policy.provider) : undefined;
    if (!provider?.embedding || typeof provider.embed !== 'function') {
      return { ok: false, reason: 'embedding_unsupported' };
    }
    const settings = provider.settingsSchema.safeParse(
      (policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );
    if (!settings.success) return { ok: false, reason: 'ai_not_configured' };
    const apiKey = await this.credentials.getSecret(userId, provider.id);
    if (!apiKey) return { ok: false, reason: 'ai_key_missing' };

    const capability = provider.embedding;
    const embed = provider.embed.bind(provider);
    return {
      ok: true,
      providerId: provider.id,
      model: capability.model,
      maxBatchSize: Math.max(1, capability.maxBatchSize),
      embed: async (texts) => {
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += capability.maxBatchSize) {
          const batch = texts.slice(i, i + capability.maxBatchSize);
          const result = await embed(createProviderContext(apiKey, settings.data), { inputs: [...batch] });
          if (result.vectors.length !== batch.length) {
            throw new Error(
              `Provider "${provider.id}" returned ${result.vectors.length} vector(s) for a ${batch.length}-input batch.`,
            );
          }
          for (const v of result.vectors) {
            if (v.length !== EMBEDDING_DIMENSIONS || !v.every((c) => Number.isFinite(c))) {
              throw new Error(
                `Provider "${provider.id}" returned an unusable ${v.length}-component vector; ` +
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
