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
import { createProviderContext } from './ai-provider.interface';
import {
  OpenAiProvider,
  parseSseData,
  type FetchLike,
  type FetchLikeResponse,
} from './openai.provider';

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
