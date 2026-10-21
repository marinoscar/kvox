// =============================================================================
// `SearchQueryEmbedder` — the boundary where a vendor's bad day stops
// (issue #189, epic #165)
// =============================================================================
//
// `KVOX_AI.embed` THROWS by contract (a `KvoxAiError`), because its documented
// caller is a queue job. This caller is an HTTP request with a person waiting on it and a
// perfectly good lexical ranking already computed, so every throw has to become
// a reason string here. That inversion is the entire purpose of this class, and
// it is what these tests pin: FOR EVERY WAY THE PROVIDER CAN FAIL, THE RESULT
// IS A VALUE, NEVER AN EXCEPTION.
//
// The reason ORDER is pinned too. It is cheapest-first on purpose - the
// capability checks touch neither the database nor the vendor before anything is
// spent - and a reordering would send a keyless user to an administrator's
// settings page, or charge a user's card to discover a host that cannot embed at
// all.
//
// Issue #494 adds the host-level reason: `embeddings_unavailable` for a host with
// no embeddings model or one whose vectors are not 1536 wide (logged once at warn
// level, naming the model and the width).
// =============================================================================

import { Logger } from '@nestjs/common';

import {
  KvoxAiError,
  KvoxRateLimitError,
  type KvoxAiCapabilities,
  type KvoxAiPort,
} from '../ports/index.js';
import { QUERY_EMBED_TIMEOUT_MS, SearchQueryEmbedder } from './search-query-embedder.service.js';
import { MIN_SEMANTIC_SIMILARITY } from './search-semantic.js';
import {
  SEARCH_EMBEDDING_DIMENSIONS,
  DEFAULT_SEARCH_TYPE_PERMISSIONS,
  type ResolvedSearchOptions,
} from './search.options.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const vector = (fill = 0.5) => Array.from({ length: SEARCH_EMBEDDING_DIMENSIONS }, () => fill);

interface HarnessOptions {
  /** Overrides of what `capabilities()` answers. */
  capabilities?: Partial<KvoxAiCapabilities>;
  embed?: jest.Mock;
  options?: Partial<ResolvedSearchOptions>;
}

function capabilitiesOf(overrides: Partial<KvoxAiCapabilities> = {}): KvoxAiCapabilities {
  return {
    available: true,
    structuredOutput: true,
    toolCalling: true,
    embeddings: { model: 'text-embedding-3-small', dimensions: SEARCH_EMBEDDING_DIMENSIONS },
    graphEnabled: true,
    ...overrides,
  };
}

function makeHarness(harness: HarnessOptions = {}) {
  const embed =
    harness.embed ??
    jest.fn().mockResolvedValue({
      model: 'text-embedding-3-small',
      dimensions: SEARCH_EMBEDDING_DIMENSIONS,
      vectors: [vector()],
    });

  const capabilities = jest.fn().mockResolvedValue(capabilitiesOf(harness.capabilities));

  const ai = { capabilities, embed } as unknown as KvoxAiPort;
  const options: ResolvedSearchOptions = {
    semanticEnabled: true,
    provider: 'openai',
    typePermissions: DEFAULT_SEARCH_TYPE_PERMISSIONS,
    ...harness.options,
  };

  return { embedder: new SearchQueryEmbedder(ai, options), embed, capabilities };
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

  describe('a usable host and a caller with a key', () => {
    it('returns the vector, the provider label and the model the host REPORTED', async () => {
      const harness = makeHarness({
        embed: jest.fn().mockResolvedValue({
          // ⚠ NOT the model that was asked for. A gateway that silently
          // substitutes one is exactly the fact the cursor fingerprint must
          // carry, so this value is reported rather than echoed.
          model: 'text-embedding-3-small-2026',
          dimensions: SEARCH_EMBEDDING_DIMENSIONS,
          vectors: [vector(0.25)],
        }),
      });

      const result = await plan(harness);

      expect(result).toEqual({
        ok: true,
        provider: 'openai',
        model: 'text-embedding-3-small-2026',
        // The SQL filter id is the GATE's model, never the reported one.
        indexModel: 'text-embedding-3-small',
        minSimilarity: MIN_SEMANTIC_SIMILARITY,
        vector: vector(0.25),
      });
    });

    it('sends the query as a batch of one, under the search timeout', async () => {
      const harness = makeHarness();

      await plan(harness, 'the call about refunds');

      expect(harness.embed).toHaveBeenCalledTimes(1);

      const [ctx, request] = harness.embed.mock.calls[0];

      expect(ctx).toMatchObject({ userId: USER_ID, orgId: null, feature: 'search.embed' });
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(request).toEqual({ inputs: ['the call about refunds'], purpose: 'query' });
    });

    it('carries the capability floor when the model declares one', async () => {
      const harness = makeHarness({
        capabilities: {
          embeddings: { model: 'bge', dimensions: SEARCH_EMBEDDING_DIMENSIONS, nativeDimensions: 384, minSimilarity: 0.55 },
        },
      });

      expect(await plan(harness)).toMatchObject({ ok: true, indexModel: 'bge', minSimilarity: 0.55 });
    });

    it('bounds its patience far below a streamed completion', async () => {
      // A streamed completion legitimately runs for minutes; a search box does
      // not. Asserted as a number rather than described, so a later "reuse the
      // AI timeout" tidy-up fails here instead of in production.
      expect(QUERY_EMBED_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    });

    it('asks capabilities for the SEARCHER, under the search.embed feature', async () => {
      const harness = makeHarness();

      await plan(harness);

      expect(harness.capabilities).toHaveBeenCalledWith({
        userId: USER_ID,
        orgId: null,
        feature: 'search.embed',
      });
    });

    it('never puts a key anywhere in the request', async () => {
      const harness = makeHarness();

      await plan(harness);

      const [ctx, request] = harness.embed.mock.calls[0];

      expect(Object.keys(ctx).sort()).toEqual(['feature', 'orgId', 'signal', 'userId']);
      expect(Object.keys(request).sort()).toEqual(['inputs', 'purpose']);
    });
  });

  // ==========================================================================
  // Every way it declines, in the order it declines them
  // ==========================================================================

  describe('reasons', () => {
    it('reports ai_not_configured when the deployment is not set up', async () => {
      await expect(
        plan(makeHarness({ capabilities: { available: false, reason: 'ai_not_configured' } })),
      ).resolves.toEqual({ ok: false, reason: 'ai_not_configured' });
    });

    it('reports ai_not_configured for any unavailable reason that is not the key', async () => {
      for (const reason of ['graph_disabled', undefined] as const) {
        await expect(
          plan(makeHarness({ capabilities: { available: false, reason } })),
        ).resolves.toEqual({ ok: false, reason: 'ai_not_configured' });
      }
    });

    it('reports ai_key_missing when the CALLER has saved no key', async () => {
      // The one reason on the list whose fix belongs to the person reading it.
      const harness = makeHarness({ capabilities: { available: false, reason: 'ai_key_missing' } });

      await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'ai_key_missing' });
      expect(harness.embed).not.toHaveBeenCalled();
    });

    it('reports embeddings_unavailable when the host has no embeddings model', async () => {
      // A Desktop on a model SDK without an embeddings endpoint: full-text only,
      // and the response says why.
      const harness = makeHarness({ capabilities: { embeddings: null } });

      await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'embeddings_unavailable' });
      expect(harness.embed).not.toHaveBeenCalled();
    });

    it('prefers ai_not_configured to embeddings_unavailable when the host is not available at all', async () => {
      const harness = makeHarness({
        capabilities: { available: false, reason: 'ai_not_configured', embeddings: null },
      });

      await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'ai_not_configured' });
    });

    it('reports embeddings_unavailable for a model whose vectors are not 1536 wide, and logs ONCE', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        const harness = makeHarness({
          capabilities: { embeddings: { model: 'embed-3-large', dimensions: 3072 } },
        });

        await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'embeddings_unavailable' });
        await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'embeddings_unavailable' });

        // Never a call to embed, never a vector of another length.
        expect(harness.embed).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('embed-3-large');
        expect(String(warn.mock.calls[0]![0])).toContain('3072');
      } finally {
        warn.mockRestore();
      }
    });

    it('reports embeddings_unavailable when the host switched the semantic arm off', async () => {
      const harness = makeHarness({ options: { semanticEnabled: false } });

      await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'embeddings_unavailable' });
      expect(harness.capabilities).not.toHaveBeenCalled();
    });

    it('answers ai_not_configured, rather than throwing, when capabilities itself throws', async () => {
      const harness = makeHarness();
      harness.capabilities.mockRejectedValue(new Error('boom'));

      await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'ai_not_configured' });
    });

    it('decides BEFORE spending anything', async () => {
      for (const capabilities of [
        { available: false, reason: 'ai_not_configured' as const },
        { available: false, reason: 'ai_key_missing' as const },
        { embeddings: null },
      ]) {
        const harness = makeHarness({ capabilities });

        await plan(harness);

        expect(harness.embed).not.toHaveBeenCalled();
      }
    });
  });

  // ==========================================================================
  // ⚠ THE INVERSION: `embed` throws, this returns
  // ==========================================================================

  describe('a provider that fails', () => {
    it('turns every class of KvoxAiError into embedding_failed', async () => {
      for (const errorClass of [
        'auth',
        'refusal',
        'rate_limit',
        'budget',
        'timeout',
        'not_configured',
        'key_missing',
        'capability',
        'other',
      ] as const) {
        const harness = makeHarness({
          embed: jest.fn().mockRejectedValue(new KvoxAiError(errorClass, `scripted ${errorClass}`)),
        });

        await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'embedding_failed' });
      }
    });

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
      // ⚠ NO JOB, NO DEFERRAL. In a job a 429 is a `KvoxRateLimitError` that
      // defers work onto a throttle key; here somebody is waiting on an HTTP
      // response and the lexical ranking is already computed, so the only two
      // options are "answer now" and "make them wait for a retry that may also
      // be throttled".
      for (const thrown of [
        new KvoxRateLimitError('ai-provider:' + USER_ID, 1000),
        new KvoxAiError('rate_limit', '429 Too Many Requests', 1000),
      ]) {
        const harness = makeHarness({ embed: jest.fn().mockRejectedValue(thrown) });

        await expect(plan(harness)).resolves.toEqual({
          ok: false,
          reason: 'embedding_failed',
        });
      }
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
          model: 'text-embedding-3-small',
          dimensions: 768,
          vectors: [Array.from({ length: 768 }, () => 0.1)],
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
          model: 'text-embedding-3-small',
          dimensions: SEARCH_EMBEDDING_DIMENSIONS,
          vectors: [broken],
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
        embed: jest.fn().mockResolvedValue({
          model: 'text-embedding-3-small',
          dimensions: SEARCH_EMBEDDING_DIMENSIONS,
          vectors: [],
        }),
      });

      await expect(plan(harness)).resolves.toEqual({
        ok: false,
        reason: 'embedding_failed',
      });
    });
  });
});
