// =============================================================================
// `SearchQueryEmbedder` — the boundary where a vendor's bad day stops
// (issue #189, epic #165)
// =============================================================================
//
// `KvoxAi.embed` THROWS by contract, because its documented caller is a
// queue job. This caller is an HTTP request with a person waiting on it and a
// perfectly good lexical ranking already computed, so every throw has to become
// a reason string here. That inversion is the entire purpose of this class, and
// it is what these tests pin: FOR EVERY WAY THE PROVIDER CAN FAIL, THE RESULT
// IS A VALUE, NEVER AN EXCEPTION.
//
// The reason ORDER is pinned too. It is cheapest-first on purpose - three
// checks that touch neither the database nor the vendor before anything is
// spent - and a reordering would send a keyless user to an administrator's
// settings page, or charge a user's card to discover a provider that cannot
// embed at all.
// =============================================================================

import { EMBEDDING_DIMENSIONS } from '../ai-port/embedding-catalog';
import type { KvoxAi, KvoxAiReadiness } from '../ai-port/kvox-ai';
import type { KvoxAiReason } from '../ai-port/kvox-ai-errors';
import { QUERY_EMBED_TIMEOUT_MS, SearchQueryEmbedder } from './search-query-embedder.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const vector = (fill = 0.5) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);

interface HarnessOptions {
  /** The readiness reason; omit for a ready caller. */
  reason?: KvoxAiReason;
  embed?: jest.Mock;
}

function readinessOf(reason: KvoxAiReason | undefined): KvoxAiReadiness {
  return {
    ok: reason === undefined,
    reason: reason ?? null,
    provider: 'openai',
    model: 'text-embedding-3-small',
    source: 'default',
    contextWindowTokens: null,
    maxOutputTokens: null,
    reasoningEffort: 'none',
    hasKey: reason !== 'ai_key_missing' && reason !== 'ai_not_configured',
  };
}

function makeHarness(options: HarnessOptions = {}) {
  const embed =
    options.embed ??
    jest.fn().mockResolvedValue({
      vectors: [vector()],
      promptTokens: 4,
      model: 'text-embedding-3-small',
    });

  const readiness = jest.fn().mockResolvedValue(readinessOf(options.reason));

  const ai = { readiness, embed } as unknown as KvoxAi;

  return { embedder: new SearchQueryEmbedder(ai), embed, readiness };
}

/** `resolve` then `embed`, which is what `SearchService` does. */
async function plan(harness: ReturnType<typeof makeHarness>, q = 'quarterly pricing review') {
  const resolution = await harness.embedder.resolve(USER_ID);

  return resolution.ok ? resolution.embed(q) : resolution;
}

describe('SearchQueryEmbedder', () => {
  // ==========================================================================
  // The happy path
  // ==========================================================================

  describe('a usable deployment and a caller with a key', () => {
    it('returns the vector, the provider and the model the provider REPORTED', async () => {
      const harness = makeHarness({
        embed: jest.fn().mockResolvedValue({
          vectors: [vector(0.25)],
          promptTokens: 4,
          // ⚠ NOT the model that was asked for. A gateway that silently
          // substitutes one is exactly the fact the cursor fingerprint must
          // carry, so this value is reported rather than echoed.
          model: 'text-embedding-3-small-2026',
        }),
      });

      const result = await plan(harness);

      expect(result).toEqual({
        ok: true,
        provider: 'openai',
        model: 'text-embedding-3-small-2026',
        vector: vector(0.25),
      });
    });

    it('sends the query as a batch of one, under the search timeout', async () => {
      const harness = makeHarness();

      await plan(harness, 'the call about refunds');

      expect(harness.embed).toHaveBeenCalledTimes(1);

      const [request] = harness.embed.mock.calls[0];

      expect(request).toMatchObject({
        userId: USER_ID,
        feature: 'search_embed',
        texts: ['the call about refunds'],
      });
      // No job: this is an HTTP request.
      expect(request.jobId).toBeUndefined();
      expect(request.signal).toBeInstanceOf(AbortSignal);
    });

    it('bounds its patience far below `ai.requestTimeoutMs`', async () => {
      // A streamed completion legitimately runs for minutes; a search box does
      // not. Asserted as a number rather than described, so a later "reuse the
      // AI timeout" tidy-up fails here instead of in production.
      expect(QUERY_EMBED_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    });

    it('asks readiness for the SEARCHER, under the search_embed feature', async () => {
      const harness = makeHarness();

      await plan(harness);

      expect(harness.readiness).toHaveBeenCalledWith(USER_ID, 'search_embed');
    });

    it('never puts a key anywhere in the request', async () => {
      const harness = makeHarness();

      await plan(harness);

      const [request] = harness.embed.mock.calls[0];

      expect(Object.keys(request).sort()).toEqual(['feature', 'signal', 'texts', 'userId']);
    });
  });

  // ==========================================================================
  // Every way it declines, in the order it declines them
  // ==========================================================================

  describe('reasons', () => {
    it('reports ai_not_configured when the deployment is not set up', async () => {
      await expect(plan(makeHarness({ reason: 'ai_not_configured' }))).resolves.toEqual({
        ok: false,
        reason: 'ai_not_configured',
      });
    });

    it('reports ai_not_configured for any reason that is not the key or the model', async () => {
      for (const reason of ['model_not_permitted', 'graph_disabled'] as const) {
        await expect(plan(makeHarness({ reason }))).resolves.toEqual({
          ok: false,
          reason: 'ai_not_configured',
        });
      }
    });

    it('reports embedding_unsupported when the embeddings model cannot embed', async () => {
      // Distinct from `ai_not_configured` because the fix differs: change the
      // model catalog, do not finish configuring AI.
      await expect(plan(makeHarness({ reason: 'model_lacks_capability' }))).resolves.toEqual({
        ok: false,
        reason: 'embedding_unsupported',
      });
    });

    it('reports ai_key_missing when the CALLER has saved no key', async () => {
      // The one reason on the list whose fix belongs to the person reading it.
      const harness = makeHarness({ reason: 'ai_key_missing' });

      await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'ai_key_missing' });
      expect(harness.embed).not.toHaveBeenCalled();
    });

    it('decides BEFORE spending anything', async () => {
      for (const reason of [
        'ai_not_configured',
        'model_lacks_capability',
        'ai_key_missing',
      ] as const) {
        const harness = makeHarness({ reason });

        await plan(harness);

        expect(harness.embed).not.toHaveBeenCalled();
      }
    });
  });

  // ==========================================================================
  // ⚠ THE INVERSION: `embed` throws, this returns
  // ==========================================================================

  describe('a provider that fails', () => {
    it('turns a thrown vendor error into embedding_failed', async () => {
      const harness = makeHarness({
        embed: jest.fn().mockRejectedValue(new Error('401 Incorrect API key provided')),
      });

      await expect(plan(harness)).resolves.toEqual({
        ok: false,
        reason: 'embedding_failed',
      });
    });

    it('turns a RATE LIMIT into embedding_failed rather than deferring', async () => {
      // ⚠ NO JOB, NO DEFERRAL. Everywhere else in this codebase a 429 is a
      // `RateLimitError` that defers work onto a throttle key; here somebody is
      // waiting on an HTTP response and the lexical ranking is already
      // computed, so the only two options are "answer now" and "make them
      // wait for a retry that may also be throttled".
      class RateLimited extends Error {}

      const harness = makeHarness({
        embed: jest.fn().mockRejectedValue(new RateLimited('429 Too Many Requests')),
      });

      await expect(plan(harness)).resolves.toEqual({
        ok: false,
        reason: 'embedding_failed',
      });
    });

    it('never rejects, whatever was thrown', async () => {
      for (const thrown of [new Error('boom'), 'a string', null, undefined, { code: 500 }]) {
        const harness = makeHarness({ embed: jest.fn().mockRejectedValue(thrown) });

        await expect(plan(harness)).resolves.toMatchObject({ ok: false });
      }
    });

    it('rejects a vector of the wrong width rather than handing it to Postgres', async () => {
      // ⚠ `ok: true` MUST MEAN "SAFE IN A `vector` LITERAL". A 768-wide vector
      // would reach `search.service.ts` as a malformed literal and become a 500
      // from a `SELECT` — turning the vendor's bad day into this endpoint's,
      // which is the whole thing this class exists to prevent.
      const harness = makeHarness({
        embed: jest.fn().mockResolvedValue({
          vectors: [Array.from({ length: 768 }, () => 0.1)],
          promptTokens: 4,
          model: 'text-embedding-3-small',
        }),
      });

      await expect(plan(harness)).resolves.toEqual({
        ok: false,
        reason: 'embedding_failed',
      });
    });

    it('rejects a vector carrying a non-finite component', async () => {
      const broken = vector();
      broken[17] = Number.NaN;

      const harness = makeHarness({
        embed: jest.fn().mockResolvedValue({
          vectors: [broken],
          promptTokens: 4,
          model: 'text-embedding-3-small',
        }),
      });

      // `[0.5,0.5,NaN,...]` is not a pgvector literal; it is a syntax error
      // with a user's search query attached to it.
      await expect(plan(harness)).resolves.toEqual({
        ok: false,
        reason: 'embedding_failed',
      });
    });

    it('rejects an empty response rather than reading undefined as a vector', async () => {
      const harness = makeHarness({
        embed: jest
          .fn()
          .mockResolvedValue({ vectors: [], promptTokens: null, model: 'text-embedding-3-small' }),
      });

      await expect(plan(harness)).resolves.toEqual({
        ok: false,
        reason: 'embedding_failed',
      });
    });
  });
});
