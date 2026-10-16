// =============================================================================
// SearchQueryEmbedder (issue #189, epic #165)
// =============================================================================
//
// Turns `q` into one vector, using THE SEARCHER'S OWN API KEY, or says in one
// word why it could not. See `search-semantic.ts` for the whole who-embeds-what
// argument and for what each reason means.
//
// -----------------------------------------------------------------------------
// A LEAF OVER THE `KvoxAi` PORT
// -----------------------------------------------------------------------------
//
// It composes the one port every AI call goes through (`KVOX_AI`): `readiness`
// answers "could this searcher embed at all, and if not, why" without a vendor
// call, and `embed` spends the searcher's own key through the platform. Nothing
// else in this file knows what a provider, a credential or a request context is.
//
// It lives in `src/search/` rather than in `ai-port/` because the decision it
// encodes is a SEARCH decision: which failures are worth degrading for, in what
// order, and what a searcher is told. The port owns the vendor contract; this
// owns what search does with it.
//
// -----------------------------------------------------------------------------
// ⚠ IT NEVER THROWS. THAT IS THE WHOLE POINT.
// -----------------------------------------------------------------------------
//
// `KvoxAi.embed` throws by contract, because its documented caller is a
// queue job where a swallowed error is a job reporting success having indexed
// nothing. This is the opposite caller: an HTTP request with a person waiting
// on it, whose lexical answer is already computed and already good. So every
// throw - an auth failure, a 429, a timeout, a socket reset, a malformed
// response - is caught HERE and becomes `embedding_failed`. Nothing in this
// file may propagate; a search box that returns 500 because a vendor is having
// an afternoon is the failure this catch exists to prevent.
//
// -----------------------------------------------------------------------------
// ⚠ THE KEY IS NOT HERE
// -----------------------------------------------------------------------------
//
// The searcher's own key is resolved by the platform at the moment of the call
// and never reaches this file. The only variables permitted in any string this
// file builds are the provider id and the reason - and note that even the
// failure log below carries the reason, not the vendor's message, because a
// vendor body is the one place an echoed credential could plausibly appear.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';

import { EMBEDDING_DIMENSIONS } from '../ai-port/embedding-catalog';
import { KVOX_AI, type KvoxAi } from '../ai-port/kvox-ai';
import { searchReasonFor } from './indexing/job-types';
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

  constructor(@Inject(KVOX_AI) private readonly ai: KvoxAi) {}

  /**
   * Whether this deployment could embed a query for this searcher.
   *
   * Split out from {@link embedQuery} so `SearchService` can answer the three
   * deployment-and-caller-level reasons WITHOUT touching the database and
   * WITHOUT spending a vendor call - which is what lets the `no_indexed_content`
   * probe sit between them in the evaluation order (see `search-semantic.ts`).
   * `readiness` makes no vendor call either.
   */
  async resolve(userId: string): Promise<EmbedderResolution> {
    const readiness = await this.ai.readiness(userId, 'search_embed');

    const gate = searchReasonFor(readiness);

    if (gate !== null) return { ok: false, reason: gate };

    const provider = readiness.provider ?? 'openai';

    return {
      ok: true,
      embed: async (text: string): Promise<SemanticQueryPlan> => {
        try {
          const result = await this.ai.embed({
            userId,
            feature: 'search_embed',
            texts: [text],
            signal: AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS),
          });

          const [vector] = result.vectors;

          // ⚠ VALIDATED HERE SO `ok: true` MEANS "SAFE TO PUT IN A `vector`
          // LITERAL". A wrong width or a non-finite component would otherwise
          // reach Postgres as a malformed literal and become a 500 from a
          // `SELECT` - turning a vendor's bad day into this endpoint's, which
          // is the exact outcome this whole file exists to avoid. The port
          // already promises both; promising is not checking, and the check
          // costs one pass over 1536 numbers.
          if (
            !Array.isArray(vector) ||
            vector.length !== EMBEDDING_DIMENSIONS ||
            !vector.every((component) => Number.isFinite(component))
          ) {
            this.logger.warn(
              `Search query embedding from provider "${provider}" was unusable ` +
                `(${Array.isArray(vector) ? `${vector.length} components` : 'no vector'}); ` +
                'answering with full-text ranking only.',
            );

            return { ok: false, reason: 'embedding_failed' };
          }

          // `result.model` is what the provider REPORTED, never what was asked
          // for - a gateway that substituted a model is exactly the fact the
          // cursor fingerprint needs to carry.
          return { ok: true, provider, model: result.model, vector };
        } catch {
          // ⚠ EVERY THROW, INCLUDING A RATE LIMIT. See the header: there is no
          // job here to defer onto and somebody is waiting. The vendor's own
          // message is deliberately NOT logged - it is the one string on this
          // path that could contain an echoed credential.
          this.logger.debug(
            `Search query embedding failed against provider "${provider}"; ` +
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
