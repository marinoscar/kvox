import { AI_KEYLESS_API_KEY, AiError, type AiCallContext, type AiResponseRequest, type AiStreamEvent } from '@marinoscar/platform-ai-providers';
import { z } from 'zod';

import { createCopilotAdapter } from './copilot-adapter.js';
import { createCopilotMockTransport, type CopilotMockReply, type CopilotMockTransport } from './copilot-mock-transport.js';
import type { CopilotTransport } from './copilot-transport.js';

// =============================================================================
// THE PLANTED TOKEN (#581): no Copilot or GitHub token ever leaves the adapter
// =============================================================================
//
// A token-shaped string is planted in every place the Copilot runtime could carry
// one (session.error and model.call_failure text, thrown transport errors, the auth
// status message, cleanup failures, even the model's own malformed answer) and the
// whole observable output is swept for it: every logger entry, every AiError (message,
// details, toJSON, response body, stack) and every stream event. A second check proves
// the adapter never reads `ctx.apiKey`. The KvoxAiError that leaves `createKvoxAi` is swept
// in `test/kvox-ai-copilot-token-leak.spec.ts` (this slice imports no other slice).
// =============================================================================

const GHO = 'gho_PLANTEDcopilotTOKEN0000000000';
const GHU = 'ghu_PLANTEDcopilotTOKEN0000000000';
const TOKENS = [GHO, GHU];
const MODEL = 'gpt-5-mini';
const schema = z.object({ title: z.string() });

const ctx: AiCallContext = { apiKey: AI_KEYLESS_API_KEY, requestId: 'req-leak' };

/** Everything a caller can read off an error, as one string. */
function surfaceOf(error: unknown): string {
  const parts: unknown[] = [String(error), JSON.stringify(error)];
  if (error instanceof Error) parts.push(error.message, error.stack);
  if (AiError.isAiError(error)) parts.push(JSON.stringify(error.toJSON()), JSON.stringify(error.getResponse()), error.retryAfterMs, String(error.cause));
  return parts.map((part) => String(part)).join('\n');
}

function expectClean(what: string, text: string): void {
  for (const token of TOKENS) expect(`${what}: ${text.includes(token)}`).toBe(`${what}: false`);
  // Not even the recognisable body of the planted token survives.
  expect(`${what}: ${/PLANTEDcopilotTOKEN/.test(text)}`).toBe(`${what}: false`);
}

interface Captured {
  logs: Array<{ level: string; entry: unknown }>;
  events: AiStreamEvent[];
  errors: unknown[];
}

function harness(wrap?: (mock: CopilotMockTransport) => CopilotTransport, options: { signedIn?: boolean } = {}) {
  const mock = createCopilotMockTransport(options);
  const captured: Captured = { logs: [], events: [], errors: [] };
  const adapter = createCopilotAdapter({
    optIn: true,
    transport: wrap ? wrap(mock) : mock,
    logger: {
      info: (entry) => captured.logs.push({ level: 'info', entry }),
      warn: (entry) => captured.logs.push({ level: 'warn', entry }),
    },
  });

  /** Runs create and stream, capturing every event, error and log. */
  async function run(req: Partial<AiResponseRequest> = {}): Promise<void> {
    const request = { model: MODEL, input: 'Hi', ...req } as AiResponseRequest;
    for (const mode of ['create', 'stream'] as const) {
      try {
        if (mode === 'create') await adapter.responses.create(request, ctx);
        else for await (const event of adapter.responses.stream(request, ctx)) captured.events.push(event);
      } catch (error) {
        captured.errors.push(error);
      }
    }
  }

  function sweep(what: string): void {
    expectClean(`${what} logs`, JSON.stringify(captured.logs));
    expectClean(`${what} events`, JSON.stringify(captured.events));
    for (const error of captured.errors) expectClean(`${what} error`, surfaceOf(error));
  }
  return { mock, adapter, captured, run, sweep };
}

/** Queues the same reply for a create and a stream. */
const twice = (mock: CopilotMockTransport, reply: CopilotMockReply): void => {
  mock.queue(reply);
  mock.queue(reply);
};

describe('the planted token never leaves the Copilot adapter', () => {
  it.each(TOKENS)('in a session.error message, errorCode and errorType (%s)', async (token) => {
    for (const errorType of ['rate_limit', 'authentication', 'context_limit', 'query']) {
      const h = harness();
      twice(h.mock, { kind: 'sessionError', errorType, statusCode: 500, errorCode: `code-${token}`, message: `upstream said ${token} is bad; Bearer ${token}` });
      await h.run();
      expect(h.captured.errors.length + h.captured.events.length).toBeGreaterThan(0);
      h.sweep(`session.error ${errorType}`);
    }
    const typeLeak = harness();
    twice(typeLeak.mock, { kind: 'sessionError', errorType: `weird-${token}`, message: 'm' });
    await typeLeak.run();
    typeLeak.sweep('errorType carrying a token');
  });

  it.each(TOKENS)('in a model.call_failure errorMessage (%s)', async (token) => {
    const h = harness();
    twice(h.mock, { kind: 'callFailure', statusCode: 502, message: `gateway failed for ${token}`, thenRetrySucceeds: true });
    await h.run();
    expect(h.captured.errors).toHaveLength(1);
    h.sweep('model.call_failure');
  });

  it('in a model.call_failure whose type and code carry it', async () => {
    const h = harness();
    twice(h.mock, {
      kind: 'events',
      events: [{ type: 'model.call_failure', data: { errorType: GHO, errorCode: GHU, statusCode: 500, errorMessage: `x ${GHO}` } }],
    });
    await h.run();
    h.sweep('model.call_failure fields');
  });

  it('in errors thrown by send (an Error, a string, an object, an AiError)', async () => {
    const h = harness();
    for (const error of [
      new Error(`socket closed for ${GHO}`),
      `plain string ${GHU}`,
      { message: `object message ${GHO}` },
      new AiError('AI_PROVIDER_UNAVAILABLE', 'own error without a token'),
    ]) {
      twice(h.mock, { kind: 'throw', error });
    }
    for (let i = 0; i < 4; i += 1) await h.run();
    expect(h.captured.errors.length).toBeGreaterThanOrEqual(4);
    h.sweep('send throws');
  });

  it('in errors thrown by createSession, getAuthStatus and listModels', async () => {
    const create = harness();
    create.mock.failNextCreate(new Error(`create failed ${GHO}`));
    await create.run();
    create.sweep('createSession');

    const auth = harness((mock) => ({
      ...mock,
      getAuthStatus: async () => {
        throw new Error(`auth probe failed ${GHU}`);
      },
    }));
    await auth.run();
    const verdict = await auth.adapter.verifyKey(ctx);
    expectClean('verifyKey verdict', JSON.stringify(verdict));
    try {
      await auth.adapter.authStatus();
    } catch (error) {
      auth.captured.errors.push(error);
    }
    auth.sweep('getAuthStatus');

    const list = harness((mock) => ({
      ...mock,
      listModels: async () => {
        throw new Error(`listing failed ${GHO}`);
      },
    }));
    try {
      await list.adapter.listModels(ctx);
    } catch (error) {
      list.captured.errors.push(error);
    }
    expect(list.captured.errors).toHaveLength(1);
    list.sweep('listModels');
  });

  it('in the auth status message of a signed-out runtime', async () => {
    const hostile = (mock: CopilotMockTransport): CopilotTransport => ({
      ...mock,
      getAuthStatus: async () =>
        ({ isAuthenticated: false, login: 'octocat', authType: 'token', statusMessage: `Not signed in: token ${GHO}`, host: GHU }) as never,
    });
    const h = harness(hostile);
    await h.run();
    const verdict = await h.adapter.verifyKey(ctx);
    expectClean('verifyKey', JSON.stringify(verdict));
    expect(verdict).toMatchObject({ ok: false, code: 'AI_KEY_REQUIRED' });
    expectClean('authStatus', JSON.stringify(await h.adapter.authStatus()));
    h.sweep('auth statusMessage');
    expect(h.captured.errors.every((e) => AiError.isAiError(e) && e.code === 'AI_KEY_REQUIRED')).toBe(true);
  });

  it('in the status message of a signed-in runtime (never echoed by authStatus or the listing)', async () => {
    const h = harness((mock) => ({
      ...mock,
      getAuthStatus: async () => ({ isAuthenticated: true, login: 'octocat', authType: 'user', statusMessage: `ok ${GHO}` }) as never,
    }));
    expectClean('authStatus', JSON.stringify(await h.adapter.authStatus()));
    expectClean('models', JSON.stringify(await h.adapter.listModels(ctx)));
    await h.run();
    h.sweep('signed-in statusMessage');
  });

  it('in the failure of every cleanup step (abort, disconnect, delete)', async () => {
    const h = harness((mock) => ({
      ...mock,
      async createSession(config) {
        const session = await mock.createSession(config);
        return {
          ...session,
          abort: async () => {
            throw new Error(`abort failed ${GHO}`);
          },
          disconnect: async () => {
            throw new Error(`disconnect failed ${GHU}`);
          },
        };
      },
      deleteSession: async () => {
        throw new Error(`delete failed ${GHO}`);
      },
    }));
    twice(h.mock, { kind: 'sessionError', errorType: 'query', statusCode: 500, message: `failed ${GHU}` });
    await h.run();
    h.sweep('cleanup failures');
    expect(h.captured.logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('in the model answer when a structured answer is malformed (parser messages quote the text)', async () => {
    const h = harness();
    twice(h.mock, { kind: 'answer', text: `{"title": ${GHO}` });
    twice(h.mock, { kind: 'answer', text: `{"title": "${GHU}", "extra": ${GHO}` });
    await h.run({ structuredOutput: { name: 't', schema, strict: true } });
    await h.run({ structuredOutput: { name: 't', schema, strict: true } });
    expect(h.captured.errors.length + h.captured.events.length).toBeGreaterThan(0);
    h.sweep('malformed structured answer');
  });

  it('in an in-band stream error event, which is the redacted message', async () => {
    const h = harness();
    h.mock.queue({
      kind: 'events',
      events: [
        { type: 'assistant.message_delta', data: { deltaContent: 'partial' } },
        { type: 'session.error', data: { errorType: 'query', statusCode: 500, message: `Authorization: Bearer ${GHU} failed` } },
      ],
    });
    for await (const event of h.adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx)) h.captured.events.push(event);
    expect(h.captured.events.at(-1)).toMatchObject({ type: 'error', code: 'AI_PROVIDER_UNAVAILABLE' });
    h.sweep('in-band error');
  });

  it('keeps a token out of the tripwire failure', async () => {
    const h = harness();
    h.mock.queue({ kind: 'events', events: [{ type: 'tool.execution_start', data: { toolName: GHO, arguments: { token: GHU } } }] });
    h.mock.queue({ kind: 'events', events: [{ type: 'tool.execution_start', data: { toolName: GHO } }] });
    await h.run();
    h.sweep('tripwire');
  });
});

describe('the adapter never reads ctx.apiKey', () => {
  const SENTINEL = 'sk-SENTINELapiKEY1234567890abcdef';

  /** A context whose `apiKey` counts reads. */
  function watchedContext(): { ctx: AiCallContext; reads: () => number } {
    let reads = 0;
    const watched = { requestId: 'req-key', baseUrl: 'https://example.invalid', providerSettings: { note: SENTINEL } } as unknown as AiCallContext;
    Object.defineProperty(watched, 'apiKey', {
      enumerable: true,
      get() {
        reads += 1;
        return SENTINEL;
      },
    });
    return { ctx: watched, reads: () => reads };
  }

  it('reads nothing on a successful create, a stream, a failure, verifyKey and listModels', async () => {
    const { ctx: watched, reads } = watchedContext();
    const h = harness();
    await h.adapter.responses.create({ model: MODEL, input: 'Hi' }, watched);
    for await (const event of h.adapter.responses.stream({ model: MODEL, input: 'Hi' }, watched)) void event;
    h.mock.queue({ kind: 'sessionError', errorType: 'query', statusCode: 500, message: 'm' });
    await h.adapter.responses.create({ model: MODEL, input: 'Hi' }, watched).catch(() => undefined);
    await h.adapter.verifyKey(watched);
    await h.adapter.listModels(watched);
    expect(reads()).toBe(0);
  });

  it('sends the sentinel to no session, no prompt, no log and no response', async () => {
    const ctxWithKey: AiCallContext = { apiKey: SENTINEL, requestId: 'req-key' };
    const h = harness();
    h.mock.queue({ kind: 'sessionError', errorType: 'query', statusCode: 500, message: 'failed' });
    await h.adapter.responses.create({ model: MODEL, input: 'Hi' }, ctxWithKey).catch((e: unknown) => h.captured.errors.push(e));
    const response = await h.adapter.responses.create({ model: MODEL, input: 'Hi', instructions: 'S' }, ctxWithKey);

    const everything = JSON.stringify({
      sessions: h.mock.sessions().map((s) => ({ ...s, config: { ...s.config, hooks: undefined, onPermissionRequest: undefined } })),
      logs: h.captured.logs,
      response,
    });
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain('SENTINELapiKEY');
    for (const error of h.captured.errors) expect(surfaceOf(error)).not.toContain('SENTINELapiKEY');
  });
});
