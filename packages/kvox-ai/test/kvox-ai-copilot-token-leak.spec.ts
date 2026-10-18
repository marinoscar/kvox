import { AI_KEYLESS_API_KEY, AiError } from '@marinoscar/platform-api/ai';
import { KvoxAiError, type KvoxAiContext } from '@marinoscar/kvox-api/ports';
import { z } from 'zod';

import { createCopilotAdapter, createCopilotMockTransport, type CopilotMockReply } from '../src/copilot/index.js';
import { createDirectRuntime } from '../src/direct/index.js';
import { createKvoxAi } from '../src/port/index.js';
import type { KvoxAiModelState } from '../src/runtime/index.js';

// =============================================================================
// The planted token does not leave createKvoxAi either (#581)
// =============================================================================
//
// The adapter-level sweep is `src/copilot/copilot-token-leak.spec.ts`. Here the same
// token-shaped strings are planted in what the Copilot runtime reports and the
// KvoxAiError that leaves the port (message, JSON, own fields) is checked, on a route
// and in a job, for text, structured and a signed-out runtime.
// =============================================================================

const GHO = 'gho_PLANTEDcopilotTOKEN0000000000';
const GHU = 'ghu_PLANTEDcopilotTOKEN0000000000';
const MODEL = 'gpt-5-mini';
const schema = z.object({ title: z.string() });

/** Everything a caller can read off an error, as one string. */
function surfaceOf(error: unknown): string {
  const parts: unknown[] = [String(error), JSON.stringify(error)];
  if (error instanceof Error) parts.push(error.message, error.stack);
  if (error instanceof KvoxAiError) parts.push(JSON.stringify({ ...error, message: error.message }));
  return parts.map((part) => String(part)).join('\n');
}

function expectClean(what: string, text: string): void {
  for (const token of [GHO, GHU]) expect(`${what}: ${text.includes(token)}`).toBe(`${what}: false`);
  expect(`${what}: ${/PLANTEDcopilotTOKEN/.test(text)}`).toBe(`${what}: false`);
}

describe('the planted token does not leave createKvoxAi', () => {
  function build(reply: CopilotMockReply | { signedOut: true }) {
    const mock = createCopilotMockTransport();
    if ('signedOut' in reply) mock.setSignedIn(false);
    else mock.queue(reply);
    const copilot = createCopilotAdapter({ optIn: true, transport: mock });
    const state: KvoxAiModelState = {
      provider: 'copilot',
      models: [{ id: MODEL, label: MODEL, structuredOutput: true, toolCalling: false, contextWindow: 128_000, maxOutputTokens: 16_384 }],
      policy: {
        enabled: true,
        provider: 'copilot',
        defaultModel: MODEL,
        graphEnabled: false,
        taskModels: {},
        reasoningEffort: 'none',
        maxInputTokens: null,
        maxOutputTokens: null,
      },
    };
    const ai = createKvoxAi({
      runtime: createDirectRuntime({ adapters: { copilot }, keys: async () => ({ apiKey: AI_KEYLESS_API_KEY }) }),
      taskModels: { load: async () => state },
      catalog: copilot.kvox.catalog,
    });
    return ai;
  }

  const kctx: KvoxAiContext = { userId: 'u1', orgId: null, feature: 'notes.generate' };

  it.each([
    ['a session.error', { kind: 'sessionError', errorType: 'query', statusCode: 500, message: `bad ${GHO}` } as const],
    ['a rate limit', { kind: 'sessionError', errorType: 'rate_limit', statusCode: 429, message: `slow ${GHU}` } as const],
    ['a call failure', { kind: 'callFailure', statusCode: 500, message: `fail ${GHO}` } as const],
    ['a thrown transport error', { kind: 'throw', error: new Error(`thrown ${GHU}`) } as const],
    ['a thrown string', { kind: 'throw', error: `string ${GHO}` } as const],
  ])('on %s, for text, structured and a job context', async (_what, reply) => {
    for (const context of [kctx, { ...kctx, orgId: 'org', jobId: 'job' } as KvoxAiContext]) {
      const text = build(reply);
      const target = await text.resolveTask(context, 'notes.generate');
      const textError = await (async () => {
        try {
          for await (const _event of text.generateText(context, { target, system: 's', user: 'u' })) void _event;
        } catch (error) {
          return error;
        }
        throw new Error('expected a failure');
      })();
      expect(textError).toBeInstanceOf(KvoxAiError);
      expectClean('generateText', surfaceOf(textError));

      const structured = build(reply);
      const structuredError = await structured
        .generateStructured(context, { target, system: 's', user: 'u', schema, schemaName: 'title' })
        .then(
          () => {
            throw new Error('expected a failure');
          },
          (error: unknown) => error,
        );
      expect(structuredError).toBeInstanceOf(KvoxAiError);
      expectClean('generateStructured', surfaceOf(structuredError));
    }
  });

  it('on a malformed structured answer', async () => {
    const ai = build({ kind: 'answer', text: `{"title": ${GHO}` });
    const target = await ai.resolveTask(kctx, 'notes.generate');
    const error = await ai.generateStructured(kctx, { target, system: 's', user: 'u', schema, schemaName: 'title' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KvoxAiError);
    expectClean('malformed answer', surfaceOf(error));
  });

  it('on a signed-out runtime', async () => {
    const ai = build({ signedOut: true });
    const target = await ai.resolveTask(kctx, 'notes.generate');
    const error = await ai.generateStructured(kctx, { target, system: 's', user: 'u', schema, schemaName: 'title' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ errorClass: 'key_missing' });
    expectClean('signed out', surfaceOf(error));
  });
});
