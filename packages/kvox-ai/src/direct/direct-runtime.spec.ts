import { AiError, type AiCallContext, type AiProviderAdapter, type AiResponse, type AiStreamEvent } from '@marinoscar/platform-api/ai';

import { createDirectRuntime } from './direct-runtime.js';

// =============================================================================
// createDirectRuntime (issue #579): the provider adapters, a key per call
// =============================================================================

const KEY = 'sk-live-abcdefghij1234567890';

const RESPONSE: AiResponse = {
  id: 'r1',
  provider: 'openai',
  model: 'gpt-x',
  output: [],
  outputText: 'hi',
  usage: { inputTokens: 3, outputTokens: 1 },
  finishReason: 'stop',
};

function adapter(overrides: Partial<AiProviderAdapter> = {}) {
  const seen: AiCallContext[] = [];
  const responses = {
    create: jest.fn(async (_req: unknown, ctx: AiCallContext) => {
      seen.push(ctx);
      return RESPONSE;
    }),
    stream: jest.fn((_req: unknown, ctx: AiCallContext) => {
      seen.push(ctx);
      return (async function* (): AsyncGenerator<AiStreamEvent> {
        yield { type: 'output_text.delta', delta: 'hi' };
        yield { type: 'response.completed', response: RESPONSE };
      })();
    }),
  };
  const embeddings = {
    embed: jest.fn(async (_req: unknown, ctx: AiCallContext) => {
      seen.push(ctx);
      return { provider: 'openai', model: 'emb-1', vectors: [[0.1, 0.2]], dimensions: 2, usage: { inputTokens: 4 } };
    }),
  };
  return {
    adapter: { id: 'openai', displayName: 'OpenAI', responses, embeddings, ...overrides } as unknown as AiProviderAdapter,
    responses,
    embeddings,
    seen,
  };
}

const CALL = { userId: 'u1', feature: 'note_generate' as const, provider: 'openai', model: 'gpt-x' };

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('createDirectRuntime', () => {
  it('fetches the key per call and hands the adapter a context with a fresh request id', async () => {
    const { adapter: openai, responses, seen } = adapter();
    const keys = jest.fn(async () => ({ apiKey: KEY, baseUrl: 'https://example.test/v1' }));
    const runtime = createDirectRuntime({ adapters: { openai }, keys });
    const controller = new AbortController();

    await runtime.create({ ...CALL, signal: controller.signal }, { input: 'q' });
    await collect(runtime.stream(CALL, { input: 'q' }));

    expect(keys).toHaveBeenCalledTimes(2);
    expect(keys).toHaveBeenCalledWith('openai');
    expect(responses.create).toHaveBeenCalledWith({ input: 'q', model: 'gpt-x' }, expect.any(Object));
    expect(seen[0]).toMatchObject({ apiKey: KEY, baseUrl: 'https://example.test/v1', signal: controller.signal });
    expect(seen[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1].requestId).not.toBe(seen[0].requestId);
  });

  it('embeds with the call\'s model and reports the input tokens', async () => {
    const { adapter: openai, embeddings } = adapter();
    const runtime = createDirectRuntime({ adapters: { openai }, keys: async () => ({ apiKey: KEY }) });

    await expect(runtime.embed!({ ...CALL, model: 'emb-1' }, { input: ['a'], dimensions: 2 })).resolves.toEqual({
      vectors: [[0.1, 0.2]],
      inputTokens: 4,
      model: 'emb-1',
    });
    expect(embeddings.embed).toHaveBeenCalledWith({ model: 'emb-1', input: ['a'], dimensions: 2 }, expect.any(Object));
  });

  it('answers readiness from the key source without keeping the key', async () => {
    const keys = jest.fn(async (provider: string) => (provider === 'openai' ? { apiKey: KEY } : null));
    const runtime = createDirectRuntime({ adapters: {}, keys });

    await expect(runtime.readiness({ userId: 'u1', feature: 'note_generate', provider: 'openai' })).resolves.toEqual({ hasKey: true });
    await expect(runtime.readiness({ userId: 'u1', feature: 'note_generate', provider: 'copilot' })).resolves.toEqual({ hasKey: false });
    expect(JSON.stringify(await runtime.readiness({ userId: 'u1', feature: 'note_generate', provider: 'openai' }))).not.toContain(KEY);
  });

  it.each([
    ['no provider', { ...CALL, provider: undefined }, 'not_configured'],
    ['no model', { ...CALL, model: undefined }, 'not_configured'],
    ['an unknown provider', { ...CALL, provider: 'copilot' }, 'not_configured'],
  ] as const)('refuses a call with %s as %s', async (_label, call, errorClass) => {
    const { adapter: openai, responses } = adapter();
    const runtime = createDirectRuntime({ adapters: { openai }, keys: async () => ({ apiKey: KEY }) });

    await expect(runtime.create(call as never, { input: 'q' })).rejects.toMatchObject({ errorClass });
    expect(responses.create).not.toHaveBeenCalled();
  });

  it('refuses a provider with no key as key_missing, before the adapter is called', async () => {
    const { adapter: openai, responses } = adapter();
    const runtime = createDirectRuntime({ adapters: { openai }, keys: async () => null });

    await expect(collect(runtime.stream(CALL, { input: 'q' }))).rejects.toMatchObject({ errorClass: 'key_missing' });
    expect(responses.stream).not.toHaveBeenCalled();
  });

  it('refuses an adapter without the port a call needs as capability', async () => {
    const { adapter: openai } = adapter({ responses: undefined, embeddings: undefined });
    const runtime = createDirectRuntime({ adapters: { openai }, keys: async () => ({ apiKey: KEY }) });

    await expect(runtime.create(CALL, { input: 'q' })).rejects.toMatchObject({ errorClass: 'capability' });
    await expect(runtime.embed!(CALL, { input: ['a'] })).rejects.toMatchObject({ errorClass: 'capability' });
  });

  it('never lets the key out: an AiError passes through, anything else and every error event are scrubbed', async () => {
    const platform = new AiError('AI_KEY_INVALID', 'The provider rejected the key.');
    const { adapter: failing } = adapter({
      responses: {
        create: async () => {
          throw new Error(`401 for ${KEY}`);
        },
        stream: () =>
          (async function* (): AsyncGenerator<AiStreamEvent> {
            yield { type: 'error', code: 'AI_KEY_INVALID', message: `bad ${KEY}` };
          })(),
      },
      embeddings: {
        embed: async () => {
          throw platform;
        },
      },
    });
    const runtime = createDirectRuntime({ adapters: { openai: failing }, keys: async () => ({ apiKey: KEY }) });

    const thrown = (await runtime.create(CALL, { input: 'q' }).catch((err: unknown) => err)) as Error;
    expect(thrown.message).not.toContain(KEY);
    expect(thrown.message).toContain('[redacted]');

    const events = await collect(runtime.stream(CALL, { input: 'q' }));
    expect(JSON.stringify(events)).not.toContain(KEY);

    await expect(runtime.embed!(CALL, { input: ['a'] })).rejects.toBe(platform);
  });
});
