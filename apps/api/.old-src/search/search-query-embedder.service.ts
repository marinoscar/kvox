// =============================================================================
// SearchQueryEmbedder (issue #189, epic #165)
// =============================================================================
//
// Turns `q` into one vector, using THE SEARCHER'S OWN API KEY, or says in one
// word why it could not. See `search-semantic.ts` for the whole who-embeds-what
// argument and for what each reason means.
//
// -----------------------------------------------------------------------------
// A LEAF, LIKE `AiConfigService` AND `AiModelDiscoveryService`
// -----------------------------------------------------------------------------
//
// It composes `AiSettingsService` (the deployment policy), `AiProviderRegistry`
// (which vendor this build implements) and `UserAiCredentialsService` (the
// caller's own key), and none of the three knows it exists. That is the
// established shape in this codebase for "a small service that needs all three"
// and it is what keeps `UserAiCredentialsService` - which already injects
// `AiSettingsService` - out of a `forwardRef` cycle.
//
// It lives in `src/search/` rather than in `src/ai/` because the decision it
// encodes is a SEARCH decision: which failures are worth degrading for, in what
// order, and what a searcher is told. `src/ai/` owns the vendor contract; this
// owns what search does with it.
//
// -----------------------------------------------------------------------------
// ⚠ IT NEVER THROWS. THAT IS THE WHOLE POINT.
// -----------------------------------------------------------------------------
//
// `AiProvider.embed` throws by contract, because its documented caller is a
// queue job where a swallowed error is a job reporting success having indexed
// nothing. This is the opposite caller: an HTTP request with a person waiting
// on it, whose lexical answer is already computed and already good. So every
// throw - an auth failure, a 429, a timeout, a socket reset, a malformed
// response - is caught HERE and becomes `embedding_failed`. Nothing in this
// file may propagate; a search box that returns 500 because a vendor is having
// an afternoon is the failure this catch exists to prevent.
//
// -----------------------------------------------------------------------------
// ⚠ `ctx.apiKey` IS THE CALLER'S OWN CREDENTIAL
// -----------------------------------------------------------------------------
//
// Resolved at the moment of use, passed into one provider context, dropped. It
// is never stored on an instance field, never logged, never put in an error
// message and never returned. The ONLY variables permitted in any string this
// file builds are the provider id and the reason - and note that even the
// failure log below carries the reason, not the vendor's message, because a
// vendor body is the one place an echoed credential could plausibly appear.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { AiProviderRegistry } from '../ai/ai-provider.registry';
import { AiSettingsService } from '../ai/ai-settings.service';
import {
  createProviderContext,
  EMBEDDING_DIMENSIONS,
} from '../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../ai/user-ai-credentials.service';
import type { SemanticQueryPlan } from './search-semantic';

/**
 * How long one query embedding may take.
 *
 * ⚠ DELIBERATELY NOT `ai.requestTimeoutMs`, which is bounded at an hour and is
 * sized for a STREAMED COMPLETION that legitimately runs for minutes. Here the
 * whole request is a search box: past a couple of seconds the right answer is
 * to stop waiting and hand back the lexical ranking, which is already in hand.
 * A deployment that wants a different number here wants a different product.
 */
export const QUERY_EMBED_TIMEOUT_MS = 5_000;

@Injectable()
export class SearchQueryEmbedder {
  private readonly logger = new Logger(SearchQueryEmbedder.name);

  constructor(
    private readonly settings: AiSettingsService,
    private readonly registry: AiProviderRegistry,
    private readonly credentials: UserAiCredentialsService,
  ) {}

  /**
   * Whether this deployment could embed a query for anybody at all.
   *
   * Split out from {@link embedQuery} so `SearchService` can answer the three
   * deployment-and-caller-level reasons WITHOUT touching the database and
   * WITHOUT spending a vendor call - which is what lets the `no_indexed_content`
   * probe sit between them in the evaluation order (see `search-semantic.ts`).
   */
  async resolve(userId: string): Promise<EmbedderResolution> {
    const policy = await this.settings.get();

    if (!policy.enabled || !policy.provider) return { ok: false, reason: 'ai_not_configured' };

    const provider = this.registry.get(policy.provider);

    if (!provider) return { ok: false, reason: 'ai_not_configured' };

    // BOTH HALVES CHECKED even though `AiProviderRegistry.register` refuses a
    // provider where they disagree: the registry's guarantee is about what was
    // REGISTERED, and `embed` is optional on the interface, so TypeScript needs
    // the second test before the call below is allowed.
    if (!provider.embedding || !provider.embed) {
      return { ok: false, reason: 'embedding_unsupported' };
    }

    const settings = provider.settingsSchema.safeParse(
      (policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );

    if (!settings.success) {
      // The DEPLOYMENT's configuration is unusable - there is no base URL to
      // call. Same bucket as "no provider chosen": same page, same person.
      return { ok: false, reason: 'ai_not_configured' };
    }

    // ⚠ THE CALLER'S OWN KEY, and the only thing there is. This deployment
    // stores no AI credential of any kind (docs/specs/notes.md §9).
    const apiKey = await this.credentials.getSecret(userId, provider.id);

    if (!apiKey) return { ok: false, reason: 'ai_key_missing' };

    return {
      ok: true,
      embed: async (text: string): Promise<SemanticQueryPlan> => {
        try {
          const result = await provider.embed!(
            // The only place a plaintext key enters a provider context on this
            // path. Built here, passed down, dropped.
            createProviderContext(apiKey, settings.data),
            { inputs: [text], timeoutMs: QUERY_EMBED_TIMEOUT_MS },
          );

          const [vector] = result.vectors;

          // ⚠ VALIDATED HERE SO `ok: true` MEANS "SAFE TO PUT IN A `vector`
          // LITERAL". A wrong width or a non-finite component would otherwise
          // reach Postgres as a malformed literal and become a 500 from a
          // `SELECT` - turning a vendor's bad day into this endpoint's, which
          // is the exact outcome this whole file exists to avoid. The provider
          // contract already promises both; promising is not checking, and the
          // check costs one pass over 1536 numbers.
          if (
            !Array.isArray(vector) ||
            vector.length !== EMBEDDING_DIMENSIONS ||
            !vector.every((component) => Number.isFinite(component))
          ) {
            this.logger.warn(
              `Search query embedding from provider "${provider.id}" was unusable ` +
                `(${Array.isArray(vector) ? `${vector.length} components` : 'no vector'}); ` +
                'answering with full-text ranking only.',
            );

            return { ok: false, reason: 'embedding_failed' };
          }

          // `result.model` is what the provider REPORTED, never what was asked
          // for - a gateway that substituted a model is exactly the fact the
          // cursor fingerprint needs to carry.
          return { ok: true, provider: provider.id, model: result.model, vector };
        } catch {
          // ⚠ EVERY THROW, INCLUDING A RATE LIMIT. See the header: there is no
          // job here to defer onto and somebody is waiting. The vendor's own
          // message is deliberately NOT logged - it is the one string on this
          // path that could contain an echoed credential.
          this.logger.debug(
            `Search query embedding failed against provider "${provider.id}"; ` +
              'answering with full-text ranking only.',
          );

          return { ok: false, reason: 'embedding_failed' };
        }
      },
    };
  }
}

/** What {@link SearchQueryEmbedder.resolve} answers. */
export type EmbedderResolution =
  | {
      ok: true;
      /** Spends one vendor call on the caller's key. NEVER throws. */
      embed: (text: string) => Promise<SemanticQueryPlan>;
    }
  | Extract<SemanticQueryPlan, { ok: false }>;
