// =============================================================================
// SearchQueryEmbedder (issue #189, epic #165)
// =============================================================================
//
// Turns `q` into one vector, using THE SEARCHER'S OWN API KEY, or says in one
// word why it could not. See `search-semantic.ts` for the whole who-embeds-what
// argument and for what each reason means.
//
// -----------------------------------------------------------------------------
// A LEAF OVER THE `KVOX_AI` PORT
// -----------------------------------------------------------------------------
//
// It composes the one port every AI call goes through (`KVOX_AI`): `capabilities`
// answers "could this searcher embed at all, and if not, why" without a vendor
// call, and `embed` spends the searcher's own key through the host's adapter.
// Nothing else in this file knows what a provider, a credential or a request
// context is.
//
// It lives in the search slice rather than in the port because the decision it
// encodes is a SEARCH decision: which failures are worth degrading for, in what
// order, and what a searcher is told. The port owns the vendor contract; this
// owns what search does with it.
//
// WHEN THE HOST HAS NO USABLE EMBEDDINGS (a Desktop on a model SDK without an
// embeddings endpoint, or a model whose vectors are not 1536 wide) the answer is
// the reason `embeddings_unavailable`, the full-text arm answers alone, and a
// wrong width is logged ONCE at warn level naming the model and the width.
//
// -----------------------------------------------------------------------------
// ⚠ IT NEVER THROWS. THAT IS THE WHOLE POINT.
// -----------------------------------------------------------------------------
//
// `KVOX_AI.embed` throws by contract (`KvoxAiError`, of any class), because its
// documented caller is a queue job where a swallowed error is a job reporting
// success having indexed nothing. This is the opposite caller: an HTTP request
// with a person waiting on it, whose lexical answer is already computed and
// already good. So every throw - an auth failure, a 429 (`KvoxAiError` of class
// `rate_limit` or a `KvoxRateLimitError`), a timeout, a socket reset, a malformed
// response - is caught HERE and becomes `embedding_failed`. Nothing in this
// file may propagate; a search box that returns 500 because a vendor is having
// an afternoon is the failure this catch exists to prevent.
//
// -----------------------------------------------------------------------------
// ⚠ THE KEY IS NOT HERE
// -----------------------------------------------------------------------------
//
// The searcher's own key is resolved by the host's adapter at the moment of the call
// and never reaches this file. The only variables permitted in any string this
// file builds are the provider id and the reason - and note that even the
// failure log below carries the reason, not the vendor's message, because a
// vendor body is the one place an echoed credential could plausibly appear.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';

import { KVOX_AI, type KvoxAiContext, type KvoxAiPort } from '../ports/index.js';
import { MIN_SEMANTIC_SIMILARITY, type SemanticQueryPlan, type SemanticQueryPlanOff } from './search-semantic.js';
import { embeddingGateFor } from './search-embedding-gate.js';
import {
  SEARCH_EMBEDDING_DIMENSIONS,
  SEARCH_MODULE_OPTIONS,
  type ResolvedSearchOptions,
} from './search.options.js';

/**
 * How long one query embedding may take.
 *
 * ⚠ DELIBERATELY NOT THE HOST'S GENERAL AI TIMEOUT, which is sized for a STREAMED
 * COMPLETION that legitimately runs for minutes. Here the whole request is a
 * search box: past a couple of seconds the right answer is to stop waiting and
 * hand back the lexical ranking, which is already in hand. A deployment that
 * wants a different number here wants a different product.
 *
 * @stability experimental
 */
export const QUERY_EMBED_TIMEOUT_MS = 5_000;

/** The feature name the host's AI adapter meters and labels the call under.
 *
 * @stability experimental
 */
export const SEARCH_EMBED_FEATURE = 'search.embed';

/**
 * Turns a query into a vector on the searcher's own key, or says why not.
 *
 * @stability experimental
 */
@Injectable()
export class SearchQueryEmbedder {
  private readonly logger = new Logger(SearchQueryEmbedder.name);

  /** The `model:dimensions` pairs already warned about, so the log has one line each. */
  private readonly warned = new Set<string>();

  constructor(
    @Inject(KVOX_AI) private readonly ai: KvoxAiPort,
    @Inject(SEARCH_MODULE_OPTIONS) private readonly options: ResolvedSearchOptions,
  ) {}

  /**
   * Whether this deployment could embed a query for this searcher.
   *
   * Split out from the returned `embed` so `SearchService` can answer the
   * deployment-and-caller-level reasons WITHOUT touching the database and
   * WITHOUT spending a vendor call - which is what lets the `no_indexed_content`
   * probe sit between them in the evaluation order (see `search-semantic.ts`).
   * `capabilities` makes no vendor call either.
   *
   * @param userId - the searcher.
   */
  async resolve(userId: string): Promise<EmbedderResolution> {
    if (!this.options.semanticEnabled) return { ok: false, reason: 'embeddings_unavailable' };

    const ctx: KvoxAiContext = { userId, orgId: null, feature: SEARCH_EMBED_FEATURE };
    let gate: ReturnType<typeof embeddingGateFor>;

    try {
      gate = embeddingGateFor(await this.ai.capabilities(ctx));
    } catch {
      // `capabilities` never throws by contract; a port that does is not configured.
      return { ok: false, reason: 'ai_not_configured' };
    }

    if (!gate.ok) {
      if (gate.mismatch) this.warnOnce(gate.mismatch.model, gate.mismatch.dimensions);

      return { ok: false, reason: gate.reason };
    }

    const provider = this.options.provider;

    return {
      ok: true,
      indexModel: gate.model,
      embed: async (text: string): Promise<SemanticQueryPlan> => {
        try {
          const result = await this.ai.embed(
            { ...ctx, signal: AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS) },
            { inputs: [text], purpose: 'query' },
          );

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
            vector.length !== SEARCH_EMBEDDING_DIMENSIONS ||
            !vector.every((component) => Number.isFinite(component))
          ) {
            this.logger.warn(
              `Search query embedding from provider "${provider}" was unusable ` +
                `(${Array.isArray(vector) ? `${vector.length} components` : 'no vector'}); ` +
                'answering with full-text ranking only.',
            );

            return { ok: false, reason: 'embedding_failed' };
          }

          // `result.model` is what the host REPORTED, never what was asked
          // for - a gateway that substituted a model is exactly the fact the
          // cursor fingerprint needs to carry.
          return {
            ok: true,
            provider,
            model: result.model,
            indexModel: gate.model,
            minSimilarity: gate.minSimilarity ?? MIN_SEMANTIC_SIMILARITY,
            vector,
          };
        } catch {
          // ⚠ EVERY THROW (a `KvoxAiError` of any class, a `KvoxRateLimitError`,
          // anything else), INCLUDING A RATE LIMIT. See the header: there is no
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

  private warnOnce(model: string, dimensions: number): void {
    const key = `${model}:${dimensions}`;

    if (this.warned.has(key)) return;

    this.warned.add(key);
    this.logger.warn(
      `The embeddings model "${model}" returns ${dimensions}-dimension vectors, but the search index ` +
        `stores exactly ${SEARCH_EMBEDDING_DIMENSIONS}; semantic search is off and the full-text ranking answers alone.`,
    );
  }
}

/**
 * The embedder can run: `embed` spends one call on the caller's key.
 *
 * @stability experimental
 */
export interface EmbedderReady {
  /** Discriminant. */
  ok: true;
  /** The model the index stores vectors under, for the SQL filter (the gate's model). */
  indexModel: string;
  /** Embeds one query. NEVER throws: every failure is a plan with a reason. */
  embed: (text: string) => Promise<SemanticQueryPlan>;
}

/**
 * What {@link SearchQueryEmbedder.resolve} answers.
 *
 * @stability experimental
 */
export type EmbedderResolution = EmbedderReady | SemanticQueryPlanOff;
