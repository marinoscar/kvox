import { AI_KEYLESS_API_KEY } from '@marinoscar/platform-api/ai';
import { z } from 'zod';

import { createCopilotAdapter, createCopilotMockTransport } from '../src/copilot/index.js';
import { createDirectRuntime } from '../src/direct/index.js';
import { createKvoxAi } from '../src/port/index.js';
import type { KvoxAiModelState } from '../src/runtime/index.js';
import { wrapRecordingAdapter } from '../src/testing/index.js';

// =============================================================================
// createKvoxAi over the Copilot adapter: the prompted structured path (#581)
// =============================================================================
//
// Smoke proof of the whole Desktop path: `createKvoxAi` over `createDirectRuntime`
// over the GitHub Copilot adapter over its mock transport. A `prompted` model gets
// the schema in its system prompt and ONE repair; a `native` one gets
// `responseSchema`; tool calling is off.
// =============================================================================

function state(model: string): KvoxAiModelState {
  return {
    provider: 'copilot',
    models: [{ id: model, label: model, structuredOutput: true, toolCalling: false, contextWindow: null, maxOutputTokens: null }],
    policy: {
      enabled: true,
      provider: 'copilot',
      defaultModel: model,
      graphEnabled: false,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

function build(model: string) {
  const transport = createCopilotMockTransport();
  const copilot = createCopilotAdapter({ optIn: true, transport });
  const recording = wrapRecordingAdapter(copilot);
  const ai = createKvoxAi({
    runtime: createDirectRuntime({ adapters: { copilot: recording }, keys: async () => ({ apiKey: AI_KEYLESS_API_KEY }) }),
    taskModels: { load: async () => state(model) },
    catalog: copilot.kvox.catalog,
  });
  return { ai, transport, recording };
}

const ctx = { userId: 'u1', orgId: null, feature: 'notes.generate' };
const schema = z.object({ title: z.string() });

describe('createKvoxAi over the Copilot adapter', () => {
  it('runs a prompted model with the schema in the prompt and one repair', async () => {
    const { ai, transport, recording } = build('claude-sonnet-4.5');
    transport.queue({ kind: 'answer', text: 'Sure! Here it is: {"title": 3}', usage: { inputTokens: 10, outputTokens: 4 } });
    transport.queue({ kind: 'answer', text: '```json\n{"title":"Fixed"}\n```', usage: { inputTokens: 20, outputTokens: 5 } });

    const target = await ai.resolveTask(ctx, 'notes.generate');
    const result = await ai.generateStructured(ctx, { target, system: 'Extract.', user: 'The text.', schema, schemaName: 'title' });

    expect(result).toEqual({ value: { title: 'Fixed' }, usage: { inputTokens: 30, outputTokens: 9 } });
    const sessions = transport.sessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].config.systemMessage.content).toMatch(/^Extract\.\n\nAnswer with a single JSON value only/);
    expect(sessions[0].prompts[0]).toMatchObject({ prompt: 'The text.' });
    expect(sessions[0].prompts[0].responseSchema).toBeUndefined();
    expect(sessions[1].prompts[0].prompt).toMatch(/^The text\.\n\n---\n\n/);
    expect(recording.requests().every((r) => !('structuredOutput' in (r.request as object)))).toBe(true);
  });

  it('sends responseSchema for a native model, and offers no tool calling', async () => {
    const { ai, transport } = build('gpt-5-mini');
    transport.queue({ kind: 'answer', text: '{"title":"Native"}' });

    const target = await ai.resolveTask(ctx, 'notes.generate');
    const result = await ai.generateStructured(ctx, { target, system: 'Extract.', user: 'The text.', schema, schemaName: 'title' });

    expect(result.value).toEqual({ title: 'Native' });
    expect(transport.sessions()[0].prompts[0].responseSchema).toMatchObject({ type: 'object' });
    expect(transport.sessions()[0].config.systemMessage.content).toBe('Extract.');
    await expect(ai.capabilities(ctx)).resolves.toMatchObject({ available: true, toolCalling: false, structuredOutput: true });
  });
});
