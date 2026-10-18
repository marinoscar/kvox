import type { AiCallContext, AiProviderAdapter, AiResponse, AiStreamEvent } from '@marinoscar/platform-ai-providers';
import { KvoxAiError } from '@marinoscar/kvox-api/ports';

import { createDirectRuntime } from '../src/direct/index.js';
import { createKvoxAi } from '../src/port/index.js';

// =============================================================================
// createKvoxAi over createDirectRuntime: no host behind the port (issue #579)
// =============================================================================
//
// What KVox Desktop and a plain Node script do: the port over the provider adapters,
// a key handed over per call. Lives under `test/` because it joins two slices
// (`port` and `direct`) that do not import each other.
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

function adapter() {
  const responses = {
    create: jest.fn(async () => RESPONSE),
    stream: jest.fn((_req: unknown, _ctx: AiCallContext) =>
      (async function* (): AsyncGenerator<AiStreamEvent> {
        yield { type: 'output_text.delta', delta: 'hi' };
        yield { type: 'response.completed', response: RESPONSE };
      })(),
    ),
  };
  return { adapter: { id: 'openai', displayName: 'OpenAI', responses } as unknown as AiProviderAdapter, responses };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('createKvoxAi over createDirectRuntime', () => {
  it('runs createKvoxAi end to end with no host behind it', async () => {
    const { adapter: openai, responses } = adapter();
    const ai = createKvoxAi({
      runtime: createDirectRuntime({ adapters: { openai }, keys: async () => ({ apiKey: KEY }) }),
      taskModels: {
        load: async () => ({
          provider: 'openai',
          models: [{ id: 'gpt-x', label: 'gpt-x', structuredOutput: true, toolCalling: true, contextWindow: 100_000, maxOutputTokens: 8_000 }],
          policy: { enabled: true, provider: 'openai', defaultModel: 'gpt-x', graphEnabled: false, taskModels: {}, reasoningEffort: 'none', maxInputTokens: null, maxOutputTokens: null },
        }),
      },
    });
    const ctx = { userId: 'u1', orgId: null, feature: 'notes.generate' };

    const target = await ai.resolveTask(ctx, 'notes.generate');
    const events = await collect(ai.generateText(ctx, { target, system: 's', user: 'u' }));

    expect(target).toMatchObject({ provider: 'openai', model: 'gpt-x', contextWindowTokens: 100_000, maxOutputTokens: 8_000 });
    expect(events).toEqual([
      { type: 'delta', text: 'hi' },
      { type: 'done', usage: { inputTokens: 3, outputTokens: 1 }, finishReason: 'stop' },
    ]);
    expect(responses.stream).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-x', instructions: 's', input: 'u' }), expect.any(Object));

    // A missing key surfaces through the port as the port's class.
    const keyless = createKvoxAi({
      runtime: createDirectRuntime({ adapters: { openai }, keys: async () => null }),
      taskModels: { load: async () => ({ provider: null, models: [], policy: { enabled: false, provider: null, defaultModel: null, graphEnabled: false, taskModels: {}, reasoningEffort: 'none', maxInputTokens: null, maxOutputTokens: null } }) },
    });
    await expect(collect(keyless.generateText(ctx, { target, system: 's', user: 'u' }))).rejects.toBeInstanceOf(KvoxAiError);
    await expect(collect(keyless.generateText(ctx, { target, system: 's', user: 'u' }))).rejects.toMatchObject({ errorClass: 'key_missing' });
  });
});
