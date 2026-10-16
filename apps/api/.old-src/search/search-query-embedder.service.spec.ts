// =============================================================================
// `SearchQueryEmbedder` — the boundary where a vendor's bad day stops
// (issue #189, epic #165)
// =============================================================================
//
// `AiProvider.embed` THROWS by contract, because its documented caller is a
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

import { z } from 'zod';

import type { AiProviderRegistry } from '../ai/ai-provider.registry';
import type { AiSettingsService } from '../ai/ai-settings.service';
import { EMBEDDING_DIMENSIONS } from '../ai/providers/ai-provider.interface';
import type { UserAiCredentialsService } from '../ai/user-ai-credentials.service';
import { QUERY_EMBED_TIMEOUT_MS, SearchQueryEmbedder } from './search-query-embedder.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const API_KEY = 'sk-the-callers-own-secret-key';

const vector = (fill = 0.5) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);

interface HarnessOptions {
  enabled?: boolean;
  provider?: string | null;
  registered?: boolean;
  /** Omit both `embedding` and `embed`, as a chat-only vendor does. */
  embeds?: boolean;
  apiKey?: string | null;
  /** The stored per-provider settings block; `{ bad: true }` fails the schema. */
  providerBlock?: unknown;
  embed?: jest.Mock;
}

function makeHarness(options: HarnessOptions = {}) {
  const embed =
    options.embed ??
    jest.fn().mockResolvedValue({
      vectors: [vector()],
      promptTokens: 4,
      model: 'text-embedding-3-small',
    });

  const provider = {
    id: 'openai',
    settingsSchema: z.object({ baseUrl: z.string().optional() }),
    ...(options.embeds === false
      ? {}
      : {
          embedding: {
            model: 'text-embedding-3-small',
            dimensions: EMBEDDING_DIMENSIONS,
            maxInputTokens: 8191,
            maxBatchSize: 128,
          },
          embed,
        }),
  };

  const settings = {
    get: jest.fn().mockResolvedValue({
      enabled: options.enabled ?? true,
      provider: options.provider === undefined ? 'openai' : options.provider,
      providers: { openai: options.providerBlock ?? { baseUrl: 'https://api.example.test' } },
    }),
  } as unknown as AiSettingsService;

  const registry = {
    get: jest.fn().mockReturnValue((options.registered ?? true) ? provider : undefined),
  } as unknown as AiProviderRegistry;

  const credentials = {
    getSecret: jest
      .fn()
      .mockResolvedValue(options.apiKey === undefined ? API_KEY : options.apiKey),
  } as unknown as UserAiCredentialsService;

  return {
    embedder: new SearchQueryEmbedder(settings, registry, credentials),
    embed,
    credentials,
  };
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
      expect(harness.embed.mock.calls[0][1]).toEqual({
        inputs: ['the call about refunds'],
        timeoutMs: QUERY_EMBED_TIMEOUT_MS,
      });
    });

    it('bounds its patience far below `ai.requestTimeoutMs`', async () => {
      // A streamed completion legitimately runs for minutes; a search box does
      // not. Asserted as a number rather than described, so a later "reuse the
      // AI timeout" tidy-up fails here instead of in production.
      expect(QUERY_EMBED_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    });

    it('passes the CALLER’S own key into the provider context and nowhere else', async () => {
      const harness = makeHarness();

      await plan(harness);

      const [ctx] = harness.embed.mock.calls[0];

      expect(ctx.apiKey).toBe(API_KEY);
      expect(harness.credentials.getSecret).toHaveBeenCalledWith(USER_ID, 'openai');
      // `createProviderContext` makes an accidental serialisation harmless.
      expect(JSON.stringify(ctx)).not.toContain(API_KEY);
      expect(JSON.stringify(ctx)).toContain('[redacted]');
    });
  });

  // ==========================================================================
  // Every way it declines, in the order it declines them
  // ==========================================================================

  describe('reasons', () => {
    it('reports ai_not_configured when the master switch is off', async () => {
      await expect(plan(makeHarness({ enabled: false }))).resolves.toEqual({
        ok: false,
        reason: 'ai_not_configured',
      });
    });

    it('reports ai_not_configured when no provider is chosen', async () => {
      await expect(plan(makeHarness({ provider: null }))).resolves.toEqual({
        ok: false,
        reason: 'ai_not_configured',
      });
    });

    it('reports ai_not_configured when the chosen provider is not in this build', async () => {
      // A deployment rolled back across the addition of a provider. Ordinary,
      // and not an error.
      await expect(plan(makeHarness({ registered: false }))).resolves.toEqual({
        ok: false,
        reason: 'ai_not_configured',
      });
    });

    it('reports ai_not_configured when the stored provider block does not parse', async () => {
      await expect(plan(makeHarness({ providerBlock: { baseUrl: 42 } }))).resolves.toEqual({
        ok: false,
        reason: 'ai_not_configured',
      });
    });

    it('reports embedding_unsupported for a chat-only provider', async () => {
      // A vendor with no embeddings endpoint is a perfectly registrable chat
      // provider. Distinct from `ai_not_configured` because the fix differs:
      // switch providers, do not finish configuring this one.
      await expect(plan(makeHarness({ embeds: false }))).resolves.toEqual({
        ok: false,
        reason: 'embedding_unsupported',
      });
    });

    it('reports ai_key_missing when the CALLER has saved no key', async () => {
      // The one reason on the list whose fix belongs to the person reading it.
      const harness = makeHarness({ apiKey: null });

      await expect(plan(harness)).resolves.toEqual({ ok: false, reason: 'ai_key_missing' });
      expect(harness.embed).not.toHaveBeenCalled();
    });

    it('checks the deployment and the key BEFORE spending anything', async () => {
      for (const options of [{ enabled: false }, { embeds: false }, { apiKey: null }]) {
        const harness = makeHarness(options);

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
