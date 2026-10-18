import { AI_KEYLESS_API_KEY, AiError, type AiCallContext, type AiStreamEvent } from '@marinoscar/platform-api/ai';
import { z } from 'zod';

import { copilotSessionConfig, createCopilotAdapter } from './copilot-adapter.js';
import { copilotErrorFromData, redactTokens } from './copilot-errors.js';
import { createCopilotMockTransport } from './copilot-mock-transport.js';

// =============================================================================
// Smoke specs of the GitHub Copilot adapter over the mock transport (#581)
// =============================================================================
//
// A first proof that the adapter works; the full suite (the error table, every
// suppression, the tripwire, the planted-token sweep, conformance) is written
// separately.
// =============================================================================

const ctx: AiCallContext = { apiKey: AI_KEYLESS_API_KEY, requestId: 'req-1' };
const PLANTED = 'gho_PLANTEDcopilotTOKEN0000000000';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('createCopilotAdapter (smoke)', () => {
  it('refuses to build without the opt-in', () => {
    expect(() => createCopilotAdapter({ optIn: false, transport: createCopilotMockTransport() })).toThrow(/switched off/);
  });

  it('freezes the session template: zero tools, replace mode', () => {
    const config = copilotSessionConfig({ model: 'gpt-5-mini', instructions: 'S', workingDirectory: '/empty' });
    expect(config).toMatchObject({
      availableTools: [],
      systemMessage: { mode: 'replace', content: 'S' },
      enableSkills: false,
      skipCustomInstructions: true,
      enableConfigDiscovery: false,
      infiniteSessions: { enabled: false },
    });
    expect(config.onPermissionRequest()).toEqual({ kind: 'reject' });
    expect(config.hooks.onUserPromptTransformed({ prompt: 'p', transformedPrompt: 'x\n\np' })).toEqual({ modifiedTransformedPrompt: 'p' });
  });

  it('answers a create and deletes the session, the prompt reaching the model unprefixed', async () => {
    const transport = createCopilotMockTransport();
    transport.queue({ kind: 'answer', text: 'Hello there.', usage: { inputTokens: 5, outputTokens: 3 } });
    const adapter = createCopilotAdapter({ optIn: true, transport });

    const response = await adapter.responses.create({ model: 'gpt-5-mini', instructions: 'Be brief.', input: 'Hi' }, ctx);

    expect(response).toMatchObject({ provider: 'copilot', outputText: 'Hello there.', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } });
    const [session] = transport.sessions();
    expect(session.config.systemMessage).toEqual({ mode: 'replace', content: 'Be brief.' });
    expect(session.prompts[0].sentPrompt).toBe('Hi');
    expect(session).toMatchObject({ disconnected: true, deleted: true, modelRequests: 1 });
  });

  it('streams well-formed events', async () => {
    const transport = createCopilotMockTransport();
    transport.queue({ kind: 'answer', text: 'abcdefghijkl', chunkSize: 5 });
    const events: AiStreamEvent[] = await collect(createCopilotAdapter({ optIn: true, transport }).responses.stream({ model: 'gpt-5-mini', input: 'Hi' }, ctx));

    expect(events[0].type).toBe('response.created');
    expect(events.at(-1)?.type).toBe('response.completed');
    const deltas = events.flatMap((e) => (e.type === 'output_text.delta' ? [e.delta] : []));
    expect(deltas.join('')).toBe('abcdefghijkl');
  });

  it('aborts at a length finish, so the runtime makes no continuation request', async () => {
    const transport = createCopilotMockTransport();
    transport.queue({ kind: 'lengthThenContinue', text: 'cut off' });
    const response = await createCopilotAdapter({ optIn: true, transport }).responses.create({ model: 'gpt-5-mini', input: 'Hi' }, ctx);

    expect(response.finishReason).toBe('length');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.sessions()[0]).toMatchObject({ aborted: true, modelRequests: 1, deleted: true });
  });

  it('stops a session that offers the model a tool (the tripwire)', async () => {
    const transport = createCopilotMockTransport({ liveTools: ['bash'] });
    await expect(createCopilotAdapter({ optIn: true, transport }).responses.create({ model: 'gpt-5-mini', input: 'Hi' }, ctx)).rejects.toMatchObject({
      code: 'AI_CAPABILITY_UNSUPPORTED',
    });
    expect(transport.sessions()[0]).toMatchObject({ prompts: [], deleted: true });
  });

  it('refuses tools and assistant items before a session exists', async () => {
    const transport = createCopilotMockTransport();
    const adapter = createCopilotAdapter({ optIn: true, transport });
    await expect(
      adapter.responses.create(
        { model: 'gpt-5-mini', input: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'x' }] }] },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'AI_CAPABILITY_UNSUPPORTED' });
    expect(transport.sessions()).toHaveLength(0);
  });

  it('says AI_KEY_REQUIRED when nobody is signed in', async () => {
    const transport = createCopilotMockTransport({ signedIn: false });
    const adapter = createCopilotAdapter({ optIn: true, transport });
    await expect(adapter.responses.create({ model: 'gpt-5-mini', input: 'Hi' }, ctx)).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
    await expect(adapter.verifyKey(ctx)).resolves.toMatchObject({ ok: false, code: 'AI_KEY_REQUIRED' });
  });

  it('validates a native structured answer and refuses one for a prompted model', async () => {
    const transport = createCopilotMockTransport();
    transport.queue({ kind: 'answer', text: '{"title":"T"}' });
    const adapter = createCopilotAdapter({ optIn: true, transport });
    const schema = z.object({ title: z.string() });

    const response = await adapter.responses.create({ model: 'gpt-5-mini', input: 'Hi', structuredOutput: { name: 't', schema, strict: true } }, ctx);
    expect(response.parsed).toEqual({ title: 'T' });
    expect(transport.sessions()[0].prompts[0].responseSchema).toMatchObject({ type: 'object' });

    await expect(
      adapter.responses.create({ model: 'claude-sonnet-4.5', input: 'Hi', structuredOutput: { name: 't', schema } }, ctx),
    ).rejects.toMatchObject({ code: 'AI_CAPABILITY_UNSUPPORTED' });
  });

  it('maps and redacts a session error; no planted token leaves in an error, event or log', async () => {
    const transport = createCopilotMockTransport();
    const logs: unknown[] = [];
    const logger = { info: (e: unknown) => logs.push(e), warn: (e: unknown) => logs.push(e) };
    transport.queue({ kind: 'sessionError', errorType: 'rate_limit', statusCode: 429, message: `slow down ${PLANTED}` });
    const adapter = createCopilotAdapter({ optIn: true, transport, logger });

    const events = await collect(adapter.responses.stream({ model: 'gpt-5-mini', input: 'Hi' }, ctx));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'error', code: 'AI_RATE_LIMITED' });
    expect(JSON.stringify({ events, logs })).not.toContain(PLANTED);
    expect(redactTokens(`Bearer abc.def ${PLANTED} ghs_x github_pat_y sk-abcdefgh`)).not.toMatch(/abc\.def|gho_|ghs_x|github_pat_y|sk-abcdefgh/);
    expect(copilotErrorFromData({ errorType: 'authentication', message: 'no' })).toBeInstanceOf(AiError);
    expect(copilotErrorFromData({ errorType: 'authentication', message: 'no' }).code).toBe('AI_KEY_INVALID');
  });

  it('rethrows the signal reason when the caller aborts a hung session', async () => {
    const transport = createCopilotMockTransport();
    transport.queue({ kind: 'hang' });
    const controller = new AbortController();
    const pending = createCopilotAdapter({ optIn: true, transport }).responses.create({ model: 'gpt-5-mini', input: 'Hi' }, { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller gave up')), 10);

    await expect(pending).rejects.toThrow('caller gave up');
    expect(transport.sessions()[0]).toMatchObject({ aborted: true, deleted: true });
  });

  it('classifies models without the tools capability and answers the kvox catalog', () => {
    const adapter = createCopilotAdapter({ optIn: true, transport: createCopilotMockTransport() });
    expect(adapter.classifyModel('claude-sonnet-4.5')?.capabilities).not.toContain('tools');
    expect(adapter.kvox.catalog.lookup('copilot', 'claude-sonnet-4.5')).toMatchObject({ toolCalling: false, structuredOutputMode: 'prompted' });
    expect(adapter.kvox.catalog.lookup('openai', 'gpt-5-mini')).toBeNull();
  });
});
