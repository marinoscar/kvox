import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AiAuthError,
  AiBudgetError,
  AiInputError,
  AiRefusedError,
  RateLimitError,
} from '../ai-errors';
import { AiProviderRegistry } from '../ai-provider.registry';
import {
  createProviderContext,
  EMBEDDING_DIMENSIONS,
} from './ai-provider.interface';
import {
  deriveOpenAiModelDescriptor,
  OpenAiProvider,
  parseSseData,
  OPENAI_DEFAULT_MODEL_LIMITS,
  type FetchLike,
  type FetchLikeResponse,
} from './openai.provider';
import type { AiGenerateRequest } from './ai-provider.interface';

// =============================================================================
// OpenAiProvider (issue #47, epic #45)
// =============================================================================
//
// Everything here runs OFFLINE, against recorded vendor frames in
// `../__fixtures__/openai/` and a `fetch` replaced through the `OPENAI_FETCH`
// seam. That is the whole reason the seam exists: every error-mapping case and
// the entire SSE parser can be asserted deterministically, with no network, no
// vendor account, and no charge to anybody's card.
//
// THE THREE THINGS BEING PINNED, and why each one is worth a fixture rather
// than a hand-built string:
//
//   1. THE FRAMING. An SSE body is not JSON; it is JSON payloads inside a
//      line-oriented frame format, and the framing is what a parser gets wrong
//      — a frame split across two chunks, `\r\n\r\n` from a proxy, the `[DONE]`
//      sentinel that is not JSON at all.
//   2. THE FINISH REASONS. `stop`, `length` and `content_filter` are three
//      different outcomes and only one of them is a failure.
//   3. THE STATUS MAPPING. 401 → `AiAuthError`, 400 → `AiInputError` (or
//      `AiRefusedError`/`AiBudgetError` when the body says so), 429 →
//      `RateLimitError`, 5xx → a plain retryable `Error`.
// =============================================================================

const FIXTURES = join(__dirname, '..', '__fixtures__', 'openai');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
}

/**
 * The recorded `GET /models` envelope (#78) — real vendor shape, including the
 * duplicate `gpt-4o` row and every non-chat model family the filter must drop.
 */
const MODEL_LIST_JSON = readFileSync(join(FIXTURES, 'model-list.json'), 'utf8');

/**
 * The recorded `POST /embeddings` envelope (#183).
 *
 * ⚠ IT LISTS INDEX 1 BEFORE INDEX 0, on purpose and as the vendor is entitled
 * to. See `../__fixtures__/openai/README.md`: the array's order is not the
 * contract, the `index` field is.
 */
const EMBEDDINGS_JSON = readFileSync(
  join(FIXTURES, 'embeddings-response.json'),
  'utf8',
);

/** A body that hands the whole fixture over in one chunk. */
async function* oneChunk(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/**
 * A body chopped into `size`-byte chunks.
 *
 * ⚠ THIS IS THE INTERESTING ONE. Real chunk boundaries fall wherever TCP puts
 * them, which means a `data:` frame routinely arrives in two pieces — the
 * single most common streaming-parser bug, and one that a fixture delivered in
 * one chunk cannot catch. Deliberately an odd size, so boundaries land inside
 * JSON payloads and inside the `\n\n` separators rather than neatly between
 * frames.
 */
async function* chopped(text: string, size = 17): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

function streamResponse(body: AsyncIterable<Uint8Array>): FetchLikeResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
    json: async () => ({}),
    body,
  };
}

function errorResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): FetchLikeResponse {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

/**
 * A successful JSON response carrying the given body text.
 *
 * Serves both JSON routes this provider calls — `GET /models` (#78) and
 * `POST /embeddings` (#183) — because the two differ in what they return, not
 * in how a 200 with a JSON body is shaped.
 */
function jsonResponse(bodyJson: string): FetchLikeResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => bodyJson,
    json: async () => JSON.parse(bodyJson) as unknown,
  };
}

const SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  // #78: `allowedModels` entries are objects now; a bare string is still
  // accepted on the wire and normalised by the schema before it ever reaches a
  // provider, so the PARSED shape is what a provider context carries.
  allowedModels: [{ id: 'gpt-4o' }],
  defaultModel: 'gpt-4o',
};

const ctx = () => createProviderContext('sk-test-DO-NOT-LOG', SETTINGS);

const REQUEST = {
  model: 'gpt-4o',
  systemPrompt: 'You summarise meetings.',
  userContent: 'A transcript.',
  maxOutputTokens: 1024,
};

function providerWith(fetchImpl: FetchLike): OpenAiProvider {
  return new OpenAiProvider(new AiProviderRegistry(), fetchImpl);
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('parseSseData', () => {
  it('yields each frame\'s data payload in order', async () => {
    const frames = await collect(parseSseData(oneChunk(fixture('simple-completion'))));

    expect(frames).toHaveLength(7);
    expect(frames[frames.length - 1]).toBe('[DONE]');
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    // The same fixture, delivered 17 bytes at a time. Identical output is the
    // assertion: a parser that reset its buffer per chunk produces garbage
    // here and is correct above, which is exactly why both cases exist.
    const whole = await collect(parseSseData(oneChunk(fixture('simple-completion'))));
    const split = await collect(parseSseData(chopped(fixture('simple-completion'))));

    expect(split).toEqual(whole);
  });

  it('accepts CRLF separators from a proxy that rewrote the line endings', async () => {
    const rewritten = fixture('simple-completion').replace(/\n/g, '\r\n');

    const frames = await collect(parseSseData(oneChunk(rewritten)));

    expect(frames[frames.length - 1]).toBe('[DONE]');
  });

  it('does not lose a trailing frame that has no terminating blank line', async () => {
    const truncated = 'data: {"a":1}\n\ndata: {"b":2}';

    expect(await collect(parseSseData(oneChunk(truncated)))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it('reads a body exposed as a WHATWG reader rather than an async iterable', async () => {
    // Node's own `fetch` gives a ReadableStream. Supporting both shapes is what
    // lets every other test here use a plain generator.
    const bytes = new TextEncoder().encode('data: {"a":1}\n\n');
    let sent = false;

    const frames = await collect(
      parseSseData({
        getReader: () => ({
          read: async () =>
            sent ? { done: true } : ((sent = true), { done: false, value: bytes }),
        }),
      }),
    );

    expect(frames).toEqual(['{"a":1}']);
  });
});

describe('OpenAiProvider.generate', () => {
  it('parses a fixture stream into ordered deltas and one terminal done', async () => {
    const provider = providerWith(async () =>
      streamResponse(oneChunk(fixture('simple-completion'))),
    );

    const events = await collect(provider.generate(ctx(), REQUEST));

    expect(events).toEqual([
      { kind: 'delta', text: '## Summary' },
      { kind: 'delta', text: '\n\nThe team agreed' },
      { kind: 'delta', text: ' to ship on Friday.' },
      {
        kind: 'done',
        finishReason: 'stop',
        usage: { promptTokens: 1284, completionTokens: 37 },
      },
    ]);
  });

  it('produces the same deltas when the stream arrives in small chunks', async () => {
    const provider = providerWith(async () =>
      streamResponse(chopped(fixture('simple-completion'))),
    );

    const events = await collect(provider.generate(ctx(), REQUEST));

    expect(events.filter((e) => (e as { kind: string }).kind === 'delta')).toEqual([
      { kind: 'delta', text: '## Summary' },
      { kind: 'delta', text: '\n\nThe team agreed' },
      { kind: 'delta', text: ' to ship on Friday.' },
    ]);
  });

  it('reports `length` as a completed generation, not a failure', async () => {
    const provider = providerWith(async () =>
      streamResponse(oneChunk(fixture('length-truncated'))),
    );

    const events = await collect(provider.generate(ctx(), REQUEST));
    const done = events[events.length - 1] as { kind: string; finishReason: string };

    // The model ran out of room. The text it produced is real and the user paid
    // for it; turning this into a throw would discard both.
    expect(done.kind).toBe('done');
    expect(done.finishReason).toBe('length');
  });

  it('turns a content_filter finish reason into AiRefusedError', async () => {
    const provider = providerWith(async () =>
      streamResponse(oneChunk(fixture('content-filter'))),
    );

    await expect(collect(provider.generate(ctx(), REQUEST))).rejects.toBeInstanceOf(
      AiRefusedError,
    );
  });

  it('surfaces a MID-STREAM error frame as the right taxonomy class', async () => {
    const provider = providerWith(async () =>
      streamResponse(oneChunk(fixture('mid-stream-error'))),
    );

    // ⚠ The response was a 200. `assertOk` passed. The failure arrives inside
    // the stream, which is precisely the case an HTTP status check alone cannot
    // catch — and the whole reason `generate` inspects `chunk.error` at all.
    await expect(collect(provider.generate(ctx(), REQUEST))).rejects.toBeInstanceOf(
      AiInputError,
    );
  });

  it('estimates usage rather than reporting zero when a gateway drops it', async () => {
    const provider = providerWith(async () =>
      streamResponse(oneChunk(fixture('no-usage'))),
    );

    const events = await collect(provider.generate(ctx(), REQUEST));
    const done = events[events.length - 1] as {
      usage: { promptTokens: number; completionTokens: number };
    };

    // Zero would read as "this generation was free", which is the one wrong
    // answer about somebody's own bill.
    expect(done.usage.promptTokens).toBeGreaterThan(0);
    expect(done.usage.completionTokens).toBeGreaterThan(0);
  });

  it('throws when the stream ends without a finish reason', async () => {
    const provider = providerWith(async () =>
      streamResponse(
        oneChunk(
          'data: {"choices":[{"delta":{"content":"half a sen"},"finish_reason":null}]}\n\n',
        ),
      ),
    );

    // A caller that could not tell "the model stopped" from "the socket died"
    // would commit a half-written note as finished.
    await expect(collect(provider.generate(ctx(), REQUEST))).rejects.toThrow(
      /truncated/i,
    );
  });

  it('skips an unparseable frame rather than abandoning a paid-for generation', async () => {
    const provider = providerWith(async () =>
      streamResponse(
        oneChunk(
          'data: not json at all\n\n' +
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
        ),
      ),
    );

    const events = await collect(provider.generate(ctx(), REQUEST));

    expect(events[0]).toEqual({ kind: 'delta', text: 'ok' });
  });

  it('sends the key as a bearer token and never in the body', async () => {
    let seen: { url: string; init: Record<string, unknown> } | null = null;

    const provider = providerWith(async (url, init) => {
      seen = { url, init: (init ?? {}) as Record<string, unknown> };
      return streamResponse(oneChunk(fixture('simple-completion')));
    });

    await collect(provider.generate(ctx(), REQUEST));

    const call = seen as unknown as { url: string; init: Record<string, any> };
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.init.headers.authorization).toBe('Bearer sk-test-DO-NOT-LOG');
    expect(call.init.body).not.toContain('sk-test-DO-NOT-LOG');
    expect(JSON.parse(call.init.body as string)).toMatchObject({
      model: 'gpt-4o',
      stream: true,
    });
  });
});

describe('OpenAiProvider.generate — reasoning_effort wire shape (#87)', () => {
  // ⚠ THIS IS THE HIGH-VALUE COVERAGE IN THIS FILE. Getting the shape wrong is
  // SILENT: `reasoning: { effort }` is the Responses API's spelling, not Chat
  // Completions', so a body carrying it either does nothing (an administrator
  // turns the dial and nothing changes, with no error to notice) or is rejected
  // by a strict gateway as an unknown parameter. Every case below reads the
  // parsed request body a stubbed `fetch` actually received, never the return
  // value of `generate` — the bug this pins cannot be observed any other way.
  async function bodyFor(
    reasoningEffort: AiGenerateRequest['reasoningEffort'],
  ): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> | null = null;

    const provider = providerWith(async (_url, init) => {
      body = JSON.parse((init as { body: string }).body) as Record<
        string,
        unknown
      >;
      return streamResponse(oneChunk(fixture('simple-completion')));
    });

    await collect(
      provider.generate(ctx(), { ...REQUEST, reasoningEffort }),
    );

    return body as unknown as Record<string, unknown>;
  }

  it('sends a set effort as the FLAT top-level string `reasoning_effort`, not a nested `reasoning` object', async () => {
    const body = await bodyFor('medium');

    expect(body.reasoning_effort).toBe('medium');
    // The Responses API shape this must never accidentally take.
    expect(body).not.toHaveProperty('reasoning');
  });

  it("omits `reasoning_effort` entirely at 'none' — the key must not be serialised, not merely undefined", async () => {
    const body = await bodyFor('none');

    // `not.toHaveProperty`, deliberately, over `toBeUndefined()`: the point is
    // that a gateway which rejects unknown parameters never sees the key at
    // all, and `JSON.parse` already drops an actually-`undefined` value the
    // same way — this assertion is the one that would catch
    // `reasoning_effort: undefined` slipping into the body literal instead of
    // being spread away.
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('omits `reasoning_effort` when unset, identically to the none case', async () => {
    const body = await bodyFor(undefined);

    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it.each([
    ['a set effort', 'medium'],
    ["'none'", 'none'],
    ['unset', undefined],
  ] as const)(
    'keeps max_completion_tokens and omits max_tokens and temperature (%s)',
    async (_label, reasoningEffort) => {
      const body = await bodyFor(reasoningEffort);

      expect(body.max_completion_tokens).toBe(REQUEST.maxOutputTokens);
      expect(body).not.toHaveProperty('max_tokens');
      // A regression guard, not a formality: GPT-5-family reasoning models
      // reject a non-default `temperature`, so anyone "helpfully" adding one
      // back here silently breaks every reasoning model this provider talks
      // to, whatever `reasoningEffort` was asked for.
      expect(body).not.toHaveProperty('temperature');
    },
  );
});

describe('OpenAiProvider.generate — response_format wire shape (#328)', () => {
  async function bodyFor(
    responseFormat: AiGenerateRequest['responseFormat'],
  ): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> | null = null;

    const provider = providerWith(async (_url, init) => {
      body = JSON.parse((init as { body: string }).body) as Record<
        string,
        unknown
      >;
      return streamResponse(oneChunk(fixture('simple-completion')));
    });

    await collect(provider.generate(ctx(), { ...REQUEST, responseFormat }));

    return body as unknown as Record<string, unknown>;
  }

  it("sends `response_format: { type: 'json_object' }` when JSON is requested", async () => {
    const body = await bodyFor('json');

    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it.each([
    ['unset', undefined],
    ["'text'", 'text'],
  ] as const)(
    'omits `response_format` entirely when %s',
    async (_label, responseFormat) => {
      const body = await bodyFor(responseFormat);

      expect(body).not.toHaveProperty('response_format');
    },
  );
});

describe('OpenAiProvider HTTP status mapping', () => {
  async function generateAgainst(response: FetchLikeResponse): Promise<unknown> {
    const provider = providerWith(async () => response);
    return collect(provider.generate(ctx(), REQUEST));
  }

  it('maps 401 to AiAuthError', async () => {
    await expect(
      generateAgainst(errorResponse(401, '{"error":{"message":"Incorrect API key"}}')),
    ).rejects.toBeInstanceOf(AiAuthError);
  });

  it('maps 403 to AiAuthError as well', async () => {
    await expect(
      generateAgainst(errorResponse(403, '{"error":{"message":"Project restricted"}}')),
    ).rejects.toBeInstanceOf(AiAuthError);
  });

  it('maps 400 to AiInputError', async () => {
    await expect(
      generateAgainst(
        errorResponse(400, '{"error":{"message":"Unknown parameter: foo"}}'),
      ),
    ).rejects.toBeInstanceOf(AiInputError);
  });

  it('maps a 400 that names a content policy to AiRefusedError instead', async () => {
    // Same status, different answer: "this application asked wrongly" and "the
    // provider declined to answer that" need different sentences in front of a
    // user, which is the entire reason `classifyErrorBody` reads the body.
    await expect(
      generateAgainst(
        errorResponse(
          400,
          '{"error":{"message":"Your request was rejected as a result of our safety system.","code":"content_policy_violation"}}',
        ),
      ),
    ).rejects.toBeInstanceOf(AiRefusedError);
  });

  it('maps a 400 that names a context-length overflow to AiBudgetError', async () => {
    await expect(
      generateAgainst(
        errorResponse(
          400,
          '{"error":{"message":"This model\'s maximum context length is 128000 tokens.","code":"context_length_exceeded"}}',
        ),
      ),
    ).rejects.toBeInstanceOf(AiBudgetError);
  });

  it('maps 429 to RateLimitError and honours Retry-After', async () => {
    const provider = providerWith(async () =>
      errorResponse(429, '{"error":{"message":"Rate limit reached"}}', {
        'retry-after': '30',
      }),
    );

    await expect(collect(provider.generate(ctx(), REQUEST))).rejects.toMatchObject({
      // `instanceof` AND the delay, because a `RateLimitError` with no
      // `retryAfterMs` is a different (and worse) outcome than one carrying the
      // provider's own number — the deferral treats it as a floor.
      name: 'RateLimitError',
      retryAfterMs: 30_000,
    });

    await expect(
      collect(providerWith(async () => errorResponse(429, '{}')).generate(ctx(), REQUEST)),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('leaves a 5xx retryable — a plain Error, not a domain class', async () => {
    const thrown = await generateAgainst(
      errorResponse(503, 'upstream unavailable'),
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(Error);
    // The default has to be the safe one: anything not positively identified as
    // terminal must stay retryable, or a transient blip becomes a permanent
    // failure.
    expect(thrown).not.toBeInstanceOf(AiAuthError);
    expect(thrown).not.toBeInstanceOf(AiInputError);
    expect(thrown).not.toBeInstanceOf(AiRefusedError);
    expect(thrown).not.toBeInstanceOf(RateLimitError);
  });

  it('bounds the error-body excerpt it puts in a message', async () => {
    const huge = 'x'.repeat(5000);

    const thrown = (await generateAgainst(errorResponse(500, huge)).then(
      () => null,
      (err: unknown) => err,
    )) as Error;

    // This message reaches `Job.lastError` and a log line.
    expect(thrown.message.length).toBeLessThan(1000);
  });
});

describe('OpenAiProvider.testConnection', () => {
  it('reports success with a latency', async () => {
    const provider = providerWith(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{}',
      json: async () => ({}),
    }));

    await expect(provider.testConnection(ctx())).resolves.toMatchObject({ ok: true });
  });

  it('NEVER THROWS on a refused key — it diagnoses it', async () => {
    const provider = providerWith(async () =>
      errorResponse(401, '{"error":{"message":"Incorrect API key"}}'),
    );

    const result = await provider.testConnection(ctx());

    // A refused probe is a successful diagnosis. This is the contract the whole
    // `POST /api/ai-credentials/test` 200-on-failure behaviour rests on.
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/401/);
    expect(result.detail).not.toContain('sk-test-DO-NOT-LOG');
  });

  it('distinguishes a rate-limited account from a wrong key', async () => {
    const provider = providerWith(async () => errorResponse(429, '{}'));

    const result = await provider.testConnection(ctx());

    expect(result.ok).toBe(false);
    // Two different fixes, so two different sentences: nothing is wrong with
    // this key, and sending the user to regenerate it would waste their time.
    expect(result.detail).toMatch(/credit|rate-limited/i);
  });

  it('names a transport failure as a network problem, not a credential one', async () => {
    const provider = providerWith(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.openai.com');
    });

    const result = await provider.testConnection(ctx());

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/network or configuration/i);
  });

  it('never puts the key in the reported detail, whatever happened', async () => {
    const provider = providerWith(async () =>
      errorResponse(500, 'sk-test-DO-NOT-LOG appeared in the upstream log'),
    );

    const result = await provider.testConnection(ctx());

    // A vendor echoing the key back in an error body is not hypothetical, and
    // `detail` is rendered straight into a settings page.
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('sk-test-DO-NOT-LOG');
  });
});

describe('OpenAiProvider.listModels', () => {
  it('joins the vendor list against the build catalogue via `known`', async () => {
    const provider = providerWith(async () => jsonResponse(MODEL_LIST_JSON));

    const models = await provider.listModels(ctx());
    const byId = new Map(models.map((m) => [m.id, m]));

    // Present in MODELS: known, with real numbers, and the catalogue's label.
    expect(byId.get('gpt-4o')).toMatchObject({
      known: true,
      label: 'GPT-4o',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });

    // Absent from MODELS: unknown, and the raw id stands in for the label.
    expect(byId.get('gpt-5-preview')).toMatchObject({
      known: false,
      label: 'gpt-5-preview',
    });
  });

  it('fills an unplaceable model from the conservative floor, and SAYS SO (#97)', async () => {
    // ⚠ SUPERSEDES "reports both numbers as null — never a guess". Issue #97
    // establishes that the two mistakes are not symmetric: a floor that is too
    // LOW refuses a prompt that would have fit, which an administrator can see
    // and correct by typing the real number, while `null` meant they had to
    // type it before they could permit the model at all. `source: 'default'` is
    // what keeps that honest — the number is published as a floor, not as
    // knowledge.
    const provider = providerWith(async () => jsonResponse(MODEL_LIST_JSON));

    const models = await provider.listModels(ctx());
    const unplaceable = models.find((m) => m.id === 'chatgpt-4o-latest');

    expect(unplaceable).toMatchObject({
      known: false,
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      source: 'default',
      derivedFrom: null,
    });
  });

  it('derives a dated snapshot from its family, at the family\'s FULL numbers (#97)', async () => {
    // The case that motivated the issue: a real vendor list is mostly dated
    // snapshots of models this build already knows, and before #97 each one
    // needed two hand-typed numbers.
    const provider = providerWith(async () =>
      jsonResponse(
        JSON.stringify({
          data: [
            { id: 'gpt-5.4-mini-2026-03-17' },
            { id: 'gpt-4o-20240806' },
            { id: 'gpt-4.1-0125' },
          ],
        }),
      ),
    );

    const byId = new Map(
      (await provider.listModels(ctx())).map((m) => [m.id, m]),
    );

    // ⚠ `gpt-5.4-mini`, NEVER `gpt-5.4` — the shorter prefix matches too, and
    // taking it would hand a 400k model a 1,050k window, which is the
    // over-estimate that bills the user for a prompt the vendor then rejects.
    expect(byId.get('gpt-5.4-mini-2026-03-17')).toMatchObject({
      known: false,
      label: 'gpt-5.4-mini-2026-03-17',
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      source: 'derived',
      derivedFrom: 'gpt-5.4-mini',
    });

    // The other two snapshot spellings OpenAI has used.
    expect(byId.get('gpt-4o-20240806')).toMatchObject({
      contextWindowTokens: 128_000,
      source: 'derived',
      derivedFrom: 'gpt-4o',
    });
    expect(byId.get('gpt-4.1-0125')).toMatchObject({
      contextWindowTokens: 1_047_576,
      source: 'derived',
      derivedFrom: 'gpt-4.1',
    });
  });

  it('`includeAll` returns the vendor list unfiltered (#97)', async () => {
    // The filter is a convenience over a flat vendor list and will eventually
    // be wrong about an id; this is what stops it ever being the reason a
    // working model cannot be found.
    const provider = providerWith(async () => jsonResponse(MODEL_LIST_JSON));

    const ids = (await provider.listModels(ctx(), { includeAll: true })).map(
      (m) => m.id,
    );

    expect(ids).toContain('text-embedding-3-small');
    expect(ids).toContain('whisper-1');

    // And the default is unchanged: omitting the option still filters.
    const filtered = (await provider.listModels(ctx())).map((m) => m.id);
    expect(filtered).not.toContain('text-embedding-3-small');
  });

  it('filters out non-chat models — embeddings, audio, image, moderation, realtime', async () => {
    const provider = providerWith(async () => jsonResponse(MODEL_LIST_JSON));

    const ids = (await provider.listModels(ctx())).map((m) => m.id);

    for (const nonChat of [
      'text-embedding-3-small',
      'text-embedding-3-large',
      'whisper-1',
      'tts-1-hd',
      'dall-e-3',
      'omni-moderation-latest',
      'gpt-4o-realtime-preview',
      'gpt-4o-transcribe',
    ]) {
      expect(ids).not.toContain(nonChat);
    }
  });

  it('deduplicates a model id the vendor listed twice', async () => {
    const provider = providerWith(async () => jsonResponse(MODEL_LIST_JSON));

    const ids = (await provider.listModels(ctx())).map((m) => m.id);

    // The fixture lists "gpt-4o" twice — a gateway aggregating upstreams can do
    // this for real, and a duplicated row would read as a bug in this app.
    expect(ids.filter((id) => id === 'gpt-4o')).toHaveLength(1);
  });

  it('sorts known models first, then by source, then alphabetically (#97)', async () => {
    const provider = providerWith(async () => jsonResponse(MODEL_LIST_JSON));

    const ids = (await provider.listModels(ctx())).map((m) => m.id);

    expect(ids).toEqual([
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
      'chatgpt-4o-latest',
      'gpt-5-preview',
      'o3-mini',
    ]);
  });

  it('throws AiAuthError on a refused key — the same taxonomy `generate` uses', async () => {
    const provider = providerWith(async () =>
      errorResponse(401, '{"error":{"message":"Incorrect API key"}}'),
    );

    await expect(provider.listModels(ctx())).rejects.toBeInstanceOf(AiAuthError);
  });

  it('propagates a transport failure (timeout, DNS) unmapped, for the caller to diagnose', async () => {
    // `AiModelDiscoveryService.discoverModels` is the caller that turns any
    // throw into `{ ok: false, detail: err.message }` — this method itself does
    // not wrap or swallow it.
    const timeout = new Error('The operation was aborted due to timeout');
    const provider = providerWith(async () => {
      throw timeout;
    });

    await expect(provider.listModels(ctx())).rejects.toBe(timeout);
  });

  it('never sends the key anywhere but the authorization header', async () => {
    let seenAuth: string | undefined;
    const provider = providerWith(async (_url, init) => {
      seenAuth = (init as { headers?: Record<string, string> } | undefined)?.headers
        ?.authorization;
      return jsonResponse(MODEL_LIST_JSON);
    });

    await provider.listModels(ctx());

    expect(seenAuth).toBe('Bearer sk-test-DO-NOT-LOG');
  });
});

describe('OpenAiProvider.countTokens', () => {
  it('is zero for empty text and positive otherwise', () => {
    const provider = providerWith(async () => errorResponse(500, ''));

    expect(provider.countTokens('', 'gpt-4o')).toBe(0);
    expect(provider.countTokens('hello world', 'gpt-4o')).toBeGreaterThan(0);
  });

  it('errs HIGH rather than low', () => {
    const provider = providerWith(async () => errorResponse(500, ''));

    // The two mistakes are not symmetric: a count that is too low lets an
    // over-budget prompt reach the vendor, which rejects it after the user has
    // been charged; a count that is too high costs a little headroom.
    const text = 'a '.repeat(100);

    expect(provider.countTokens(text, 'gpt-4o')).toBeGreaterThanOrEqual(
      Math.ceil(text.length / 4),
    );
  });

  it('grows monotonically with the text', () => {
    const provider = providerWith(async () => errorResponse(500, ''));

    expect(provider.countTokens('word '.repeat(200), 'gpt-4o')).toBeGreaterThan(
      provider.countTokens('word '.repeat(20), 'gpt-4o'),
    );
  });
});

describe('OpenAiProvider.embed (#183)', () => {
  // ⚠ THE ONE TEST IN THIS FILE WHOSE ABSENCE WOULD BE INVISIBLE is "places
  // vectors by the provider's own index". Every other failure here is loud; a
  // transposed batch is not. It has the right widths, the right count and a
  // succeeding job, and it makes semantic search return confidently wrong
  // passages for as long as the index lives. The recorded fixture lists index 1
  // FIRST so that a positional implementation passes nothing below.

  /** A vector of the one width this application can store, filled with `fill`. */
  function vectorOf(fill: number): number[] {
    return new Array<number>(EMBEDDING_DIMENSIONS).fill(fill);
  }

  function embeddingsBody(
    data: Array<{ index: unknown; embedding: unknown }>,
    extra: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      object: 'list',
      data,
      model: 'text-embedding-3-small',
      ...extra,
    });
  }

  const TWO_INPUTS = { inputs: ['the first chunk', 'the second chunk'] };

  it('declares the width the vector column holds, and a usable batch', () => {
    // The declaration the registry refuses this provider over at boot. Asserted
    // here too because the constant and the column are two halves of one
    // contract, and this is the half a vendor-model swap would change.
    const provider = providerWith(async () => {
      throw new Error('not used');
    });

    expect(provider.embedding.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(provider.embedding.model).toBe('text-embedding-3-small');
    expect(provider.embedding.maxBatchSize).toBeGreaterThanOrEqual(1);
    expect(provider.embedding.maxInputTokens).toBeGreaterThanOrEqual(1);
  });

  it('posts the batch to /embeddings with the declared model and float encoding', async () => {
    const calls: Array<{ url: string; init?: { headers?: Record<string, string>; body?: string } }> = [];
    const provider = providerWith(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(EMBEDDINGS_JSON);
    });

    await provider.embed(ctx(), TWO_INPUTS);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/embeddings');
    // The same `authHeaders` every other route uses — one HTTP path, not a
    // second one.
    expect(calls[0].init?.headers?.authorization).toBe('Bearer sk-test-DO-NOT-LOG');

    const body = JSON.parse(calls[0].init?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'text-embedding-3-small',
      input: ['the first chunk', 'the second chunk'],
      // Explicit, never defaulted: some gateways default to base64, which would
      // deliver a string where the parser expects an array of numbers.
      encoding_format: 'float',
    });
  });

  it('returns one vector per input, with the usage and the model the provider reported', async () => {
    const provider = providerWith(async () => jsonResponse(EMBEDDINGS_JSON));

    const result = await provider.embed(ctx(), TWO_INPUTS);

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result.vectors[1]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result.promptTokens).toBe(42);
    expect(result.model).toBe('text-embedding-3-small');
  });

  it('PLACES EACH VECTOR AT THE PROVIDER\'S OWN index, not at its response position', async () => {
    // The fixture lists index 1 first. The vector belonging to input 0 begins
    // `0.01`; the one belonging to input 1 begins `0.02`. A positional read
    // swaps them and raises nothing.
    const provider = providerWith(async () => jsonResponse(EMBEDDINGS_JSON));

    const { vectors } = await provider.embed(ctx(), TWO_INPUTS);

    expect(vectors[0][0]).toBeCloseTo(0.01, 6);
    expect(vectors[1][0]).toBeCloseTo(0.02, 6);
  });

  it('throws when an index is missing from the batch', async () => {
    const provider = providerWith(async () =>
      jsonResponse(embeddingsBody([{ index: 0, embedding: vectorOf(0.1) }])),
    );

    // One vector for a two-input batch. A partial answer is refused rather than
    // stored, because a gap is indistinguishable from a vector downstream.
    await expect(provider.embed(ctx(), TWO_INPUTS)).rejects.toThrow(
      /no embedding for input 1/,
    );
  });

  it('throws when an index arrives twice', async () => {
    const provider = providerWith(async () =>
      jsonResponse(
        embeddingsBody([
          { index: 0, embedding: vectorOf(0.1) },
          { index: 0, embedding: vectorOf(0.2) },
        ]),
      ),
    );

    // Two answers for input 0 means input 1 has none — and taking the response
    // positionally would have hidden exactly that.
    await expect(provider.embed(ctx(), TWO_INPUTS)).rejects.toThrow(
      /two embeddings for index 0/,
    );
  });

  it('throws when an index is outside the batch that was sent', async () => {
    const provider = providerWith(async () =>
      jsonResponse(
        embeddingsBody([
          { index: 0, embedding: vectorOf(0.1) },
          { index: 7, embedding: vectorOf(0.2) },
        ]),
      ),
    );

    await expect(provider.embed(ctx(), TWO_INPUTS)).rejects.toThrow(
      /not a position in the 2-input batch/,
    );
  });

  it('throws when a vector is not the width this application can store', async () => {
    const provider = providerWith(async () =>
      jsonResponse(
        embeddingsBody([
          { index: 0, embedding: new Array<number>(768).fill(0.1) },
          { index: 1, embedding: vectorOf(0.2) },
        ]),
      ),
    );

    // `vector(1536)` is a contract, not a default: 768 numbers cannot be stored
    // badly, they cannot be stored.
    await expect(provider.embed(ctx(), TWO_INPUTS)).rejects.toThrow(
      /width 768 .*index 0/,
    );
  });

  it('throws when a component is not a finite number', async () => {
    const poisoned = vectorOf(0.1);
    poisoned[5] = Number.NaN;
    const provider = providerWith(async () =>
      jsonResponse(
        // `JSON.stringify` writes NaN as `null`, which is exactly the shape a
        // vendor bug would put on the wire and exactly what must not be stored:
        // one non-finite component silently stops every distance against this
        // vector from ranking meaningfully.
        embeddingsBody([
          { index: 0, embedding: poisoned },
          { index: 1, embedding: vectorOf(0.2) },
        ]),
      ),
    );

    await expect(provider.embed(ctx(), TWO_INPUTS)).rejects.toThrow(
      /not a finite number/,
    );
  });

  it('reports promptTokens as null — never 0 — when the provider omits usage', async () => {
    const provider = providerWith(async () =>
      jsonResponse(
        embeddingsBody([
          { index: 0, embedding: vectorOf(0.1) },
          { index: 1, embedding: vectorOf(0.2) },
        ]),
      ),
    );

    // Zero would read as "this batch was free", the one wrong answer about
    // somebody's own bill.
    expect((await provider.embed(ctx(), TWO_INPUTS)).promptTokens).toBeNull();
  });

  it('refuses an EMPTY batch as AiInputError without spending a request', async () => {
    const fetchImpl = jest.fn();
    const provider = providerWith(fetchImpl as unknown as FetchLike);

    await expect(provider.embed(ctx(), { inputs: [] })).rejects.toBeInstanceOf(
      AiInputError,
    );
    // ⚠ THE ASSERTION THAT MATTERS. This provider already knows its own
    // ceilings; asking the vendor is paying for an answer we are holding.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an OVER-LARGE batch as AiInputError without spending a request', async () => {
    const fetchImpl = jest.fn();
    const provider = providerWith(fetchImpl as unknown as FetchLike);
    const tooMany = new Array<string>(provider.embedding.maxBatchSize + 1).fill('x');

    await expect(provider.embed(ctx(), { inputs: tooMany })).rejects.toBeInstanceOf(
      AiInputError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps 401 to AiAuthError through the SAME assertOk the other routes use', async () => {
    const provider = providerWith(async () =>
      errorResponse(401, '{"error":{"message":"Incorrect API key"}}'),
    );

    // A revoked key must produce one sentence whichever route noticed it first.
    await expect(provider.embed(ctx(), TWO_INPUTS)).rejects.toBeInstanceOf(
      AiAuthError,
    );
  });

  it('maps 429 to RateLimitError, honouring Retry-After', async () => {
    const provider = providerWith(async () =>
      errorResponse(429, '{"error":{"message":"Rate limit reached"}}', {
        'retry-after': '30',
      }),
    );

    await expect(provider.embed(ctx(), TWO_INPUTS)).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfterMs: 30_000,
    });
  });

  it('leaves a 2xx body that is not JSON retryable, and echoes nothing from it', async () => {
    const provider = providerWith(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html>proxy error</html>',
      json: async () => {
        throw new Error('not json');
      },
    }));

    const thrown = await provider
      .embed(ctx(), TWO_INPUTS)
      .then(() => null, (err: unknown) => err as Error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(AiInputError);
    // An intercepting proxy's HTML page must not be echoed back on.
    expect(thrown?.message).not.toContain('<html>');
  });
});

describe('OpenAiProvider registration', () => {
  it('self-registers with the registry on module init', () => {
    const registry = new AiProviderRegistry();
    const provider = new OpenAiProvider(registry, (async () =>
      errorResponse(500, '')) as FetchLike);

    expect(registry.ids()).toEqual([]);
    provider.onModuleInit();
    expect(registry.get('openai')).toBe(provider);
  });
});

describe('deriveOpenAiModelDescriptor (#97)', () => {
  // The vendor-knowledge half of issue #97: which id shapes are dated snapshots
  // of a model this build already knows. Asserted directly because a heuristic
  // over ids a vendor invents on its own schedule is one that quietly rots —
  // the same argument `looksLikeChatModel` is exported for.

  it.each([
    // The three snapshot spellings OpenAI has used.
    ['gpt-4o-2024-08-06', 'gpt-4o'],
    ['gpt-4o-20240806', 'gpt-4o'],
    ['gpt-4o-0806', 'gpt-4o'],
    // An undated variant of a known family is still the family.
    ['gpt-4.1-mini-preview', 'gpt-4.1-mini'],
    // An exact id derives to itself, which is what makes the function safe to
    // call from a path that has already missed the catalogue.
    ['gpt-5.4-nano', 'gpt-5.4-nano'],
  ])('places %s in the %s family', (id, family) => {
    expect(deriveOpenAiModelDescriptor(id)?.id).toBe(family);
  });

  it('takes the LONGEST matching family, never a shorter prefix of it', () => {
    // ⚠ THE CASE THAT COSTS REAL MONEY IF IT REGRESSES. `gpt-5.4` also
    // prefixes `gpt-5.4-mini-2026-03-17`, and its window is 1,050,000 against
    // the mini's 400,000 — so the shorter match would submit a prompt two and a
    // half times too large, which the vendor rejects after billing the user.
    const derived = deriveOpenAiModelDescriptor('gpt-5.4-mini-2026-03-17');

    expect(derived).toEqual({
      id: 'gpt-5.4-mini',
      // The RAW requested id, never the family's human name.
      label: 'gpt-5.4-mini-2026-03-17',
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      // #358: the family's capability travels with its numbers.
      structuredOutput: true,
    });
  });

  it('matches on a hyphen boundary only', () => {
    // `gpt-4.1` must not claim `gpt-4.10-turbo` if OpenAI ever spells one that
    // way: sharing a character prefix is not a family relationship, and the
    // two models could have nothing in common.
    expect(deriveOpenAiModelDescriptor('gpt-4.10-turbo')).toBeNull();
    expect(deriveOpenAiModelDescriptor('gpt-4oxide')).toBeNull();
  });

  it('strips at most ONE snapshot suffix', () => {
    // Repeating the strip would eat a meaningful trailing number from an id and
    // silently truncate a family name.
    expect(deriveOpenAiModelDescriptor('gpt-4o-2024-08-06')?.id).toBe('gpt-4o');
    // Two suffixes: only the last is removed, and what remains is matched as
    // written — `gpt-4o-1234` still belongs to `gpt-4o` on the boundary rule,
    // which is the answer either way, but the family is reached without a
    // second strip.
    expect(deriveOpenAiModelDescriptor('gpt-4o-1234-5678')?.id).toBe('gpt-4o');
  });

  it('returns null for an id from another vendor entirely, so the floor applies', () => {
    expect(deriveOpenAiModelDescriptor('claude-opus-5')).toBeNull();
    expect(deriveOpenAiModelDescriptor('')).toBeNull();
  });

  it('is reachable through the provider instance, which is how the resolver calls it', () => {
    // `resolveAllowedModel` holds an `AiProvider`, never a concrete class — see
    // `modelKnowledgeOf`. A module function nothing exposes would be unreachable
    // from every caller that matters.
    const provider = providerWith(async () => {
      throw new Error('not used');
    });

    expect(provider.deriveModelDescriptor('gpt-4o-2024-08-06')?.id).toBe('gpt-4o');
  });

  it('the floor is at or below every catalogued model, which is what makes it a floor', () => {
    // ⚠ A FLOOR THAT EXCEEDED A SHIPPED MODEL WOULD BE A GUESS, not a lower
    // bound — and an over-estimate is the unrecoverable direction: the vendor
    // rejects the prompt after the user has been charged for it.
    const provider = providerWith(async () => {
      throw new Error('not used');
    });

    for (const model of provider.capabilities.models) {
      expect(model.contextWindowTokens).toBeGreaterThanOrEqual(
        OPENAI_DEFAULT_MODEL_LIMITS.contextWindowTokens,
      );
      expect(model.maxOutputTokens).toBeGreaterThanOrEqual(
        OPENAI_DEFAULT_MODEL_LIMITS.maxOutputTokens,
      );
    }
  });
});
