import { z } from 'zod';

import { createDirectRuntime } from '../src/direct/index.js';
import { createKvoxAi } from '../src/port/index.js';
import type { KvoxAiModelState } from '../src/runtime/index.js';
import {
  collect,
  textAnswer,
  createRecordingAdapter,
  createRecordingRuntime,
  withRecordedFeatures,
} from '../src/testing/index.js';

// =============================================================================
// The recording adapter under the direct runtime and the port (issue #580)
// =============================================================================
// Kept out of `src/testing/` because the `testing` slice may not import `direct` or `port`.
// =============================================================================

const STATE: KvoxAiModelState = {
  provider: 'openai',
  models: [{ id: 'gpt-parity', label: 'gpt-parity', structuredOutput: true, toolCalling: true, contextWindow: 128_000, maxOutputTokens: 16_000 }],
  policy: {
    enabled: true,
    provider: 'openai',
    defaultModel: 'gpt-parity',
    graphEnabled: true,
    taskModels: {},
    reasoningEffort: 'low',
    maxInputTokens: null,
    maxOutputTokens: null,
  },
};

describe('createRecordingAdapter under createDirectRuntime and createKvoxAi', () => {
  it('records what the direct runtime hands the adapter and answers from the script', async () => {
    const adapter = createRecordingAdapter({
      stream: (_req, i) => textAnswer(`answer ${i}`),
      create: () => ({ parsed: { ok: true }, outputText: '{"ok":true}' }),
      embed: () => [[1, 2]],
    });
    const runtime = createDirectRuntime({ adapters: { openai: adapter }, keys: async () => ({ apiKey: 'sk-test-0000000000000000' }) });
    const recording = createRecordingRuntime(runtime);
    const ai = createKvoxAi({ runtime: recording, taskModels: { load: async () => STATE } });
    const ctx = { userId: 'u1', orgId: null, feature: 'notes.generate' };
    const target = await ai.resolveTask(ctx, 'notes.generate');

    const events = await collect(ai.generateText(ctx, { target, system: 'SYS', user: 'USER', maxOutputTokens: 100 }));
    const structured = await ai.generateStructured(
      { userId: 'u1', orgId: null, feature: 'graph.extract' },
      { target, system: 'S2', user: 'U2', schema: z.object({ ok: z.boolean() }), schemaName: 'demo' },
    );

    expect(events.some((e) => e.type === 'delta' && e.text === 'answer 0')).toBe(true);
    expect(structured.value).toEqual({ ok: true });

    const records = withRecordedFeatures(adapter.requests(), recording.requests());
    expect(records.map((r) => [r.method, r.feature, r.model])).toEqual([
      ['stream', 'note_generate', 'gpt-parity'],
      ['create', 'graph_extract', 'gpt-parity'],
    ]);
    expect(records[0].request).toEqual({ input: 'USER', instructions: 'SYS', maxOutputTokens: 100, reasoning: { effort: 'low' } });
    const second = records[1].request as { structuredOutput: { name: string; strict: boolean; schema: { properties: Record<string, unknown> } } };
    expect(second.structuredOutput.name).toBe('demo');
    expect(second.structuredOutput.strict).toBe(true);
    expect(Object.keys(second.structuredOutput.schema.properties)).toEqual(['ok']);
    expect(JSON.stringify(records)).not.toContain('sk-test');
  });
});
