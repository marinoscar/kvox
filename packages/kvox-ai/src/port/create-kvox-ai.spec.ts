import { z } from 'zod';

import { AiError, type AiErrorCode, type AiStreamEvent } from '@marinoscar/platform-api/ai';
import { KvoxAiError, type KvoxAiContext, type KvoxAiTarget } from '@marinoscar/kvox-api/ports';

import { EMBEDDING_DIMENSIONS, KVOX_EMBEDDING } from '../embedding/index.js';
import type { KvoxAiFeatureId } from '../features/index.js';
import type { KvoxAiModelState } from '../runtime/index.js';
import { createKvoxAi } from './create-kvox-ai.js';
import { createKvoxAiReadiness } from './readiness.js';

// =============================================================================
// createKvoxAi (issue #579, from PlatformKvoxAi #475): the port over a scripted runtime
// =============================================================================
//
// Moved from `apps/api/src/ai-port/platform-kvox-ai.spec.ts` with the class it
// pinned. Every case is kept; the assertions are translated at the port boundary:
// the platform client (`AiService.forUser(...)`) is now the host runtime, and an
// app error class (`AiAuthError`, `RateLimitError`, `KvoxAiConflict`, ...) is now
// the `KvoxAiError` class the port adapter turned it into (`auth`, `rate_limit`,
// `key_missing`, ...). The readiness cases run against `createKvoxAiReadiness`,
// the reader `createKvoxAi` uses.
// =============================================================================

const USER = 'user-1';
const ORG = 'org-1';
const JOB = 'job-1';

// -- Fixtures ---------------------------------------------------------------

function model(id: string, extra: Partial<KvoxAiModelState['models'][number]> = {}) {
  return {
    id,
    label: id,
    contextWindow: 200_000 as number | null,
    maxOutputTokens: 32_000 as number | null,
    structuredOutput: true,
    toolCalling: true,
    ...extra,
  };
}

function state(overrides: {
  policy?: Partial<KvoxAiModelState['policy']>;
  provider?: string | null;
  models?: KvoxAiModelState['models'];
} = {}): KvoxAiModelState {
  const provider = overrides.provider === undefined ? 'openai' : overrides.provider;
  return {
    provider,
    models: overrides.models ?? [model('gpt-5.4'), model('gpt-5.4-mini')],
    policy: {
      enabled: provider !== null,
      provider,
      defaultModel: 'gpt-5.4-mini',
      graphEnabled: true,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
      ...overrides.policy,
    },
  };
}

function aiError(code: AiErrorCode, extra: ConstructorParameters<typeof AiError>[2] = {}): AiError {
  return new AiError(code, `platform ${code}`, extra);
}

const RESPONSE = {
  id: 'resp-1',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  output: [],
  outputText: '',
  usage: { inputTokens: 12, outputTokens: 7 },
  finishReason: 'stop' as const,
};

async function* events(...list: AiStreamEvent[]): AsyncGenerator<AiStreamEvent> {
  for (const event of list) yield event;
}

function completed(overrides: Partial<typeof RESPONSE> = {}): AiStreamEvent {
  return { type: 'response.completed', response: { ...RESPONSE, ...overrides } };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function vector(width = EMBEDDING_DIMENSIONS, fill = 0.5): number[] {
  return Array.from({ length: width }, () => fill);
}

// -- Harness ------------------------------------------------------------------

function build(opts: { state?: KvoxAiModelState; hasKey?: boolean; timeoutMs?: number } = {}) {
  const runtime = {
    stream: jest.fn(),
    create: jest.fn(),
    embed: jest.fn(),
    readiness: jest.fn().mockResolvedValue({ hasKey: opts.hasKey !== false }),
  };
  const load = jest.fn().mockResolvedValue(opts.state ?? state());
  const requestTimeoutMs = jest.fn().mockResolvedValue(opts.timeoutMs ?? 600_000);
  const warn = jest.fn();

  const port = createKvoxAi({ runtime, taskModels: { load }, requestTimeoutMs, logger: { warn } });
  const reader = createKvoxAiReadiness({ runtime, taskModels: { load } });

  return { port, reader, runtime, load, requestTimeoutMs, warn };
}

/** A target as `resolveTask` hands it back, on the default model. */
function target(extra: Partial<KvoxAiTarget> = {}): KvoxAiTarget {
  return {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
    source: 'default',
    ...extra,
  };
}

/** A job's context (org and job set). */
const jobCtx = (feature = 'notes.generate', extra: Partial<KvoxAiContext> = {}): KvoxAiContext => ({
  userId: USER,
  orgId: ORG,
  jobId: JOB,
  feature,
  ...extra,
});

/** A route's context (no org, no job). */
const routeCtx = (feature = 'notes.generate'): KvoxAiContext => ({ userId: USER, orgId: null, feature });

const text = (extra: { maxOutputTokens?: number; target?: KvoxAiTarget } = {}) => ({
  target: extra.target ?? target(),
  system: 'SYSTEM',
  user: 'USER',
  ...(extra.maxOutputTokens !== undefined ? { maxOutputTokens: extra.maxOutputTokens } : {}),
});

async function failure(run: () => Promise<unknown>): Promise<KvoxAiError> {
  try {
    await run();
  } catch (error) {
    return error as KvoxAiError;
  }
  throw new Error('expected a failure');
}

describe('createKvoxAi', () => {
  // ---------------------------------------------------------------------------
  describe('readiness', () => {
    it('is ready on the default model, with that model\'s own numbers, for a feature with no task', async () => {
      const { reader, runtime } = build();

      await expect(reader.readiness(USER, 'note_generate')).resolves.toEqual({
        ok: true,
        reason: null,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        source: 'default',
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
        reasoningEffort: 'none',
        hasKey: true,
      });
      // Existence only: the runtime is asked whether a key exists for the provider.
      expect(runtime.readiness).toHaveBeenCalledWith({ userId: USER, feature: 'note_generate', provider: 'openai' });
    });

    it('prefers a requested enabled model, and refuses one the deployment has not enabled', async () => {
      const { reader } = build();

      await expect(reader.readiness(USER, 'note_generate', 'gpt-5.4')).resolves.toMatchObject({
        ok: true,
        model: 'gpt-5.4',
        source: 'requested',
      });
      await expect(reader.readiness(USER, 'note_generate', 'gpt-0')).resolves.toMatchObject({
        ok: false,
        reason: 'model_not_permitted',
        model: 'gpt-0',
      });
    });

    it('floors the numbers of a model whose row carries none', async () => {
      const { reader } = build({
        state: state({ models: [model('gpt-5.4-mini', { contextWindow: null, maxOutputTokens: null })] }),
      });

      await expect(reader.readiness(USER, 'note_generate')).resolves.toMatchObject({
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
      });
    });

    it('reports a missing key without throwing', async () => {
      const { reader } = build({ hasKey: false });

      await expect(reader.readiness(USER, 'note_generate')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_key_missing',
        hasKey: false,
        model: 'gpt-5.4-mini',
      });
    });

    it('is not configured when the provider slot is off, with no model to quote', async () => {
      const { reader } = build({ state: state({ provider: null, models: [] }) });

      await expect(reader.readiness(USER, 'note_generate')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_not_configured',
        provider: null,
        model: null,
        contextWindowTokens: null,
        maxOutputTokens: null,
      });
    });

    it('is not configured when no default model is usable and none was requested', async () => {
      const { reader } = build({ state: state({ policy: { defaultModel: null } }) });

      await expect(reader.readiness(USER, 'note_generate')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_not_configured',
        model: null,
      });
    });

    it('answers graph_disabled before anything else for a task feature', async () => {
      const { reader } = build({ state: state({ policy: { graphEnabled: false } }), hasKey: false });

      await expect(reader.readiness(USER, 'graph_extract')).resolves.toMatchObject({
        ok: false,
        reason: 'graph_disabled',
      });
    });

    it('uses the task model and its own reasoning effort for a task feature', async () => {
      const { reader } = build({
        state: state({
          policy: { taskModels: { 'graph.extract': { model: 'gpt-5.4', reasoningEffort: 'high' } } },
        }),
      });

      await expect(reader.readiness(USER, 'graph_extract')).resolves.toMatchObject({
        ok: true,
        model: 'gpt-5.4',
        source: 'task',
        reasoningEffort: 'high',
      });
    });

    it('checks the key before the requested model is judged, as the retired resolver did', async () => {
      const { reader } = build({ hasKey: false });

      await expect(reader.readiness(USER, 'graph_extract', 'gpt-0')).resolves.toMatchObject({
        reason: 'ai_key_missing',
      });
    });

    it('refuses a model that lacks a capability the task requires', async () => {
      const { reader } = build({
        state: state({
          models: [model('gpt-5.4-mini', { structuredOutput: false })],
        }),
      });

      await expect(reader.readiness(USER, 'graph_extract')).resolves.toMatchObject({
        ok: false,
        reason: 'model_lacks_capability',
        model: 'gpt-5.4-mini',
      });
    });

    it('answers the catalog embeddings model for an embedding feature, with no chat numbers', async () => {
      const { reader } = build();

      await expect(reader.readiness(USER, 'search_embed')).resolves.toMatchObject({
        ok: true,
        model: KVOX_EMBEDDING.model,
        contextWindowTokens: null,
        maxOutputTokens: null,
      });
    });

    it('reports a missing key for an embedding feature', async () => {
      const { reader } = build({ hasKey: false });

      await expect(reader.readiness(USER, 'graph_embed')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_key_missing',
      });
    });

    it('fills a row with no numbers from the catalog before the floors', async () => {
      const runtime = { stream: jest.fn(), create: jest.fn(), readiness: jest.fn().mockResolvedValue({ hasKey: true }) };
      const reader = createKvoxAiReadiness({
        runtime,
        taskModels: { load: async () => state({ models: [model('gpt-5.4-mini', { contextWindow: null, maxOutputTokens: null })] }) },
        catalog: {
          lookup: (provider, id) =>
            provider === 'openai' && id === 'gpt-5.4-mini'
              ? { id, contextWindow: 400_000, maxOutputTokens: 64_000, structuredOutput: true, toolCalling: true }
              : null,
        },
      });

      await expect(reader.readiness(USER, 'note_generate')).resolves.toMatchObject({
        contextWindowTokens: 400_000,
        maxOutputTokens: 64_000,
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('generateText', () => {
    it('makes one runtime call bound to user, org, feature and job, and maps deltas and the done event', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(
        events(
          { type: 'response.created', id: 'r' },
          { type: 'output_text.delta', delta: 'Hello ' },
          { type: 'reasoning_summary.delta', delta: 'thinking' },
          { type: 'output_text.delta', delta: 'world' },
          completed(),
        ),
      );

      const out = await collect(port.generateText(jobCtx(), text({ maxOutputTokens: 900 })));

      expect(out).toEqual([
        { type: 'delta', text: 'Hello ' },
        { type: 'delta', text: 'world' },
        { type: 'done', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 7 } },
      ]);
      expect(runtime.stream).toHaveBeenCalledTimes(1);
      expect(runtime.stream).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER, orgId: ORG, jobId: JOB, feature: 'note_generate' }),
        expect.objectContaining({ instructions: 'SYSTEM', input: 'USER', maxOutputTokens: 900 }),
      );
      expect(runtime.stream.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    });

    it('leaves the org and job out of the call when the caller has none (a route)', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(completed()));

      await collect(port.generateText(routeCtx(), { target: target(), system: 's', user: 'u' }));

      const call = runtime.stream.mock.calls[0][0];
      expect(call).toMatchObject({ userId: USER, feature: 'note_generate' });
      expect(call).not.toHaveProperty('orgId');
      expect(call).not.toHaveProperty('jobId');
    });

    it('sends the target\'s model, and nothing when the target names none so the host resolver decides', async () => {
      const { port, runtime } = build();
      runtime.stream.mockImplementation(() => events(completed()));

      await collect(port.generateText(jobCtx(), text({ target: target({ model: 'gpt-5.4' }) })));
      await collect(port.generateText(jobCtx(), text({ target: target({ model: '' }) })));

      expect(runtime.stream.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.4', provider: 'openai' });
      expect(runtime.stream.mock.calls[1][0]).not.toHaveProperty('model');
      // The model is the call's, never the request's: the two cannot disagree.
      expect(runtime.stream.mock.calls[0][1]).not.toHaveProperty('model');
    });

    it('maps a length finish to length, and an absent usage to null (never 0)', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(completed({ finishReason: 'length' as never, usage: {} as never })));

      const out = await collect(port.generateText(jobCtx(), text()));

      expect(out).toEqual([{ type: 'done', finishReason: 'length', usage: { inputTokens: null, outputTokens: null } }]);
    });

    it('answers refusal in a job on a content-filter finish', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(completed({ finishReason: 'content_filter' as never })));

      await expect(collect(port.generateText(jobCtx(), text()))).rejects.toMatchObject({ errorClass: 'refusal' });
    });

    it('maps an in-band error event by the job/route table', async () => {
      const { port, runtime } = build();
      runtime.stream.mockImplementation(() => events({ type: 'error', code: 'AI_KEY_REQUIRED', message: 'no key' }));

      // A job: the old AiAuthError. A route: the old 409 `ai_key_missing`.
      await expect(collect(port.generateText(jobCtx(), text()))).rejects.toMatchObject({ errorClass: 'auth' });
      await expect(collect(port.generateText(routeCtx(), text()))).rejects.toMatchObject({ errorClass: 'key_missing' });
    });

    it('maps a rate limit to rate_limit carrying the provider\'s retry-after', async () => {
      const { port, runtime } = build();
      runtime.stream.mockImplementation(() => {
        throw aiError('AI_RATE_LIMITED', { retryAfterMs: 4_000 });
      });

      const error = await failure(() => collect(port.generateText(jobCtx(), text())));

      expect(error).toBeInstanceOf(KvoxAiError);
      expect(error.errorClass).toBe('rate_limit');
      expect(error.retryAfterMs).toBe(4_000);
    });

    it('treats a stream that ends without a completion as a retryable other', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events({ type: 'output_text.delta', delta: 'half' }));

      const error = await failure(() => collect(port.generateText(jobCtx(), text())));

      expect(error.errorClass).toBe('other');
      expect(error.message).toMatch(/truncated/);
    });

    it('omits the reasoning parameter for none, clamps xhigh to high, and passes the rest', async () => {
      const cases: Array<['none' | 'low' | 'medium' | 'high' | 'xhigh', string | undefined]> = [
        ['none', undefined],
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['xhigh', 'high'],
      ];

      for (const [configured, sent] of cases) {
        const { port, runtime } = build({ state: state({ policy: { reasoningEffort: configured } }) });
        runtime.stream.mockReturnValue(events(completed()));

        await collect(port.generateText(jobCtx(), text()));

        const request = runtime.stream.mock.calls[0][1];
        if (sent === undefined) expect(request).not.toHaveProperty('reasoning');
        else expect(request.reasoning).toEqual({ effort: sent });
      }
    });

    it('lets the target\'s reasoningEffort override the deployment policy, and none omits reasoning', async () => {
      const { port, runtime } = build({ state: state({ policy: { reasoningEffort: 'high' } }) });
      runtime.stream.mockImplementation(() => events(completed()));

      await collect(port.generateText(jobCtx(), text({ target: target({ reasoningEffort: 'none' }) })));
      await collect(port.generateText(jobCtx(), text({ target: target({ reasoningEffort: 'xhigh' }) })));
      await collect(port.generateText(jobCtx(), text({ target: target({ reasoningEffort: 'low' }) })));
      await collect(port.generateText(jobCtx(), text()));

      expect(runtime.stream.mock.calls[0][1]).not.toHaveProperty('reasoning');
      expect(runtime.stream.mock.calls[1][1].reasoning).toEqual({ effort: 'high' });
      expect(runtime.stream.mock.calls[2][1].reasoning).toEqual({ effort: 'low' });
      expect(runtime.stream.mock.calls[3][1].reasoning).toEqual({ effort: 'high' });
    });

    it('surfaces the caller\'s own abort reason', async () => {
      const { port, runtime } = build();
      const controller = new AbortController();
      const reason = new DOMException('stop', 'AbortError');
      runtime.stream.mockImplementation(async function* () {
        controller.abort(reason);
        throw aiError('AI_PROVIDER_UNAVAILABLE', { details: { aborted: true } });
      });

      const error = await failure(() => collect(port.generateText(jobCtx('notes.generate', { signal: controller.signal }), text())));

      // The reason itself, in the port's vocabulary: its message, not the runtime's.
      expect(error).toMatchObject({ errorClass: 'other', message: 'stop' });

      const timedOut = new AbortController();
      runtime.stream.mockImplementation(async function* () {
        timedOut.abort(new DOMException('caller deadline', 'TimeoutError'));
        throw aiError('AI_PROVIDER_UNAVAILABLE');
      });
      await expect(
        collect(port.generateText(jobCtx('notes.generate', { signal: timedOut.signal }), text())),
      ).rejects.toMatchObject({ errorClass: 'timeout', message: 'caller deadline' });
    });

    it('turns the request-timeout backstop into a timeout', async () => {
      const { port, runtime } = build({ timeoutMs: 1_000 });
      runtime.stream.mockImplementation(async function* (call: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => call.signal.addEventListener('abort', () => resolve()));
        throw aiError('AI_PROVIDER_UNAVAILABLE', { details: { aborted: true } });
      });
      jest.useFakeTimers();

      try {
        const pending = failure(() => collect(port.generateText(jobCtx(), text())));
        await jest.advanceTimersByTimeAsync(1_001);
        const error = await pending;

        expect(error.errorClass).toBe('timeout');
        expect(error.message).toMatch(/timed out after 1000 ms/);
      } finally {
        jest.useRealTimers();
      }
    });

    it('still runs when the timeout setting cannot be read', async () => {
      const { port, runtime, requestTimeoutMs } = build();
      requestTimeoutMs.mockRejectedValue(new Error('db down'));
      runtime.stream.mockReturnValue(events(completed()));

      await expect(collect(port.generateText(jobCtx(), text()))).resolves.toHaveLength(1);
    });

    it('reads the timeout setting once per call', async () => {
      const { port, runtime, requestTimeoutMs } = build();
      runtime.stream.mockImplementation(() => events(completed()));

      await collect(port.generateText(jobCtx(), text()));
      await collect(port.generateText(jobCtx(), text()));

      expect(requestTimeoutMs).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  describe('generateStructured', () => {
    const schema = z.object({ verdict: z.enum(['same', 'different']) });
    const structured = (
      extra: {
        maxOutputTokens?: number;
        jsonSchema?: Record<string, unknown>;
        target?: KvoxAiTarget;
      } = {},
    ) => ({
      target: extra.target ?? target({ source: 'task' }),
      system: 'SYSTEM',
      user: 'USER',
      schemaName: 'kg_adjudication',
      schema,
      ...(extra.maxOutputTokens !== undefined ? { maxOutputTokens: extra.maxOutputTokens } : {}),
      ...(extra.jsonSchema !== undefined ? { jsonSchema: extra.jsonSchema } : {}),
    });
    const adjudicate = () => jobCtx('graph.adjudicate');

    it('sends the caller schema strict, validates, and returns value and usage', async () => {
      const { port, runtime } = build();
      runtime.create.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      const out = await port.generateStructured(adjudicate(), structured({ maxOutputTokens: 500 }));

      expect(out).toEqual({ value: { verdict: 'same' }, usage: { inputTokens: 12, outputTokens: 7 } });
      expect(runtime.create).toHaveBeenCalledTimes(1);
      expect(runtime.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER, orgId: ORG, jobId: JOB, feature: 'graph_adjudicate', signal: expect.any(AbortSignal) }),
        expect.objectContaining({
          instructions: 'SYSTEM',
          input: 'USER',
          structuredOutput: { name: 'kg_adjudication', schema, strict: true },
          maxOutputTokens: 500,
        }),
      );
    });

    it('converts a JSON Schema with z.fromJSONSchema and validates again with the caller\'s schema', async () => {
      const { port, runtime } = build();
      const jsonSchema = {
        type: 'object',
        properties: { verdict: { type: 'string', enum: ['same', 'different'] } },
        required: ['verdict'],
        additionalProperties: false,
      };
      runtime.create.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      await port.generateStructured(adjudicate(), structured({ jsonSchema }));

      const sent = runtime.create.mock.calls[0][1].structuredOutput;
      // Not the caller's schema: the one converted from the JSON Schema.
      expect(sent.schema).not.toBe(schema);
      expect(sent.strict).toBe(true);
      expect(sent.schema.safeParse({ verdict: 'same' }).success).toBe(true);
      expect(sent.schema.safeParse({ verdict: 'maybe' }).success).toBe(false);
      expect(sent.schema.safeParse({ verdict: 'same', extra: 1 }).success).toBe(false);
    });

    it('falls back to the caller\'s schema when the JSON Schema cannot be converted', async () => {
      const { port, runtime, warn } = build();
      const unreadable = { type: 'object', properties: { a: { $ref: '#/definitions/nowhere' } } };
      runtime.create.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      await port.generateStructured(adjudicate(), structured({ jsonSchema: unreadable }));

      expect(runtime.create.mock.calls[0][1].structuredOutput.schema).toBe(schema);
      expect(runtime.create.mock.calls[0][1].structuredOutput.strict).toBe(true);
      // Reported, without the schema or any prompt.
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('did not round-trip') }));
    });

    it('runs the caller\'s own validation on what the platform parsed', async () => {
      const { port, runtime } = build();
      // The platform's converted schema let it through; the caller's stricter one does not.
      runtime.create.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'maybe' } });

      const error = await failure(() => port.generateStructured(adjudicate(), structured()));

      expect(error.errorClass).toBe('invalid_output');
      expect(error.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    });

    it('answers truncated when the response finished on length, with what it consumed', async () => {
      const { port, runtime } = build();
      runtime.create.mockResolvedValue({ ...RESPONSE, finishReason: 'length', parsed: undefined });

      const error = await failure(() => port.generateStructured(adjudicate(), structured()));

      expect(error.errorClass).toBe('truncated');
      expect(error.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    });

    it('reads a not-valid-JSON platform failure as a truncation when an output ceiling was set', async () => {
      const { port, runtime } = build();
      runtime.create.mockRejectedValue(
        aiError('AI_STRUCTURED_OUTPUT_INVALID', {
          details: { issues: [{ path: [], code: 'invalid_json', message: 'Unexpected end of JSON input' }] },
        }),
      );

      const error = await failure(() => port.generateStructured(adjudicate(), structured({ maxOutputTokens: 500 })));

      expect(error.errorClass).toBe('truncated');
    });

    it('reads the same failure as invalid_output when no ceiling was set', async () => {
      const { port, runtime } = build();
      runtime.create.mockRejectedValue(
        aiError('AI_STRUCTURED_OUTPUT_INVALID', {
          details: { issues: [{ path: [], code: 'invalid_json', message: 'Unexpected end of JSON input' }] },
        }),
      );

      const error = await failure(() => port.generateStructured(adjudicate(), structured()));

      expect(error.errorClass).toBe('invalid_output');
    });

    it('reads a schema mismatch as invalid_output even with a ceiling', async () => {
      const { port, runtime } = build();
      runtime.create.mockRejectedValue(
        aiError('AI_STRUCTURED_OUTPUT_INVALID', {
          details: { issues: [{ path: ['verdict'], code: 'invalid_value', message: 'bad' }] },
        }),
      );

      const error = await failure(() => port.generateStructured(adjudicate(), structured({ maxOutputTokens: 500 })));

      expect(error.errorClass).toBe('invalid_output');
    });

    it('never puts model output in an error message', async () => {
      const { port, runtime } = build();
      runtime.create.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'SECRET-OUTPUT' } });

      const error = await failure(() => port.generateStructured(adjudicate(), structured()));

      expect(error.message).not.toContain('SECRET-OUTPUT');
    });

    it.each<[AiErrorCode, string]>([
      ['AI_KEY_REQUIRED', 'auth'],
      ['AI_KEY_INVALID', 'auth'],
      ['AI_MODEL_NOT_ENABLED', 'other'],
      ['AI_CAPABILITY_UNSUPPORTED', 'other'],
      ['AI_CONTENT_FILTERED', 'refusal'],
      ['AI_RATE_LIMITED', 'rate_limit'],
    ])('maps %s in a job to %s (the old job error class)', async (code, expected) => {
      const { port, runtime } = build();
      runtime.create.mockRejectedValue(aiError(code, { retryAfterMs: 1_000 }));

      await expect(port.generateStructured(adjudicate(), structured())).rejects.toMatchObject({ errorClass: expected });
    });

    it('answers a provider outage with a retryable other', async () => {
      const { port, runtime } = build();
      runtime.create.mockRejectedValue(aiError('AI_PROVIDER_UNAVAILABLE'));

      const error = await failure(() => port.generateStructured(adjudicate(), structured()));

      expect(error).toBeInstanceOf(KvoxAiError);
      expect(error.errorClass).toBe('other');
    });

    it('lets the target\'s reasoningEffort override the task and policy effort', async () => {
      const { port, runtime } = build({
        state: state({
          policy: {
            reasoningEffort: 'low',
            taskModels: { 'graph.adjudicate': { model: 'gpt-5.4', reasoningEffort: 'high' } },
          },
        }),
      });
      runtime.create.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      await port.generateStructured(adjudicate(), structured({ target: target({ model: 'gpt-5.4', reasoningEffort: 'none' }) }));
      await port.generateStructured(adjudicate(), structured({ target: target({ model: 'gpt-5.4', reasoningEffort: 'medium' }) }));

      expect(runtime.create.mock.calls[0][1]).not.toHaveProperty('reasoning');
      expect(runtime.create.mock.calls[1][1].reasoning).toEqual({ effort: 'medium' });
    });

    it('uses the task\'s reasoning effort only when it is the task\'s configured model', async () => {
      const { port, runtime } = build({
        state: state({
          policy: {
            reasoningEffort: 'low',
            taskModels: { 'graph.adjudicate': { model: 'gpt-5.4', reasoningEffort: 'high' } },
          },
        }),
      });
      runtime.create.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      // The target on the task's configured model, then on another enabled model.
      await port.generateStructured(adjudicate(), structured({ target: target({ model: 'gpt-5.4' }) }));
      await port.generateStructured(adjudicate(), structured({ target: target({ model: 'gpt-5.4-mini' }) }));

      expect(runtime.create.mock.calls[0][1].reasoning).toEqual({ effort: 'high' });
      expect(runtime.create.mock.calls[1][1].reasoning).toEqual({ effort: 'low' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('embed', () => {
    const embedCtx = (extra: Partial<KvoxAiContext> = {}) => jobCtx('search.embed', extra);

    it('sends the catalog model and width, and returns vectors in input order with the model', async () => {
      const { port, runtime } = build();
      const first = vector(EMBEDDING_DIMENSIONS, 0.1);
      const second = vector(EMBEDDING_DIMENSIONS, 0.2);
      runtime.embed.mockResolvedValue({ model: 'text-embedding-3-small-0001', vectors: [first, second], inputTokens: 33 });

      const out = await port.embed(embedCtx(), { inputs: ['a', 'b'] });

      expect(out).toEqual({ vectors: [first, second], dimensions: 1536, model: 'text-embedding-3-small-0001' });
      expect(runtime.embed).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER,
          orgId: ORG,
          jobId: JOB,
          feature: 'search_embed',
          provider: 'openai',
          model: 'text-embedding-3-small',
          signal: expect.any(AbortSignal),
        }),
        { input: ['a', 'b'], dimensions: 1536 },
      );
    });

    it('falls back to the catalog model when the runtime names none', async () => {
      const { port, runtime } = build();
      runtime.embed.mockResolvedValue({ vectors: [vector()], inputTokens: null });

      await expect(port.embed(embedCtx(), { inputs: ['a'] })).resolves.toMatchObject({ model: KVOX_EMBEDDING.model });
    });

    it('refuses an empty batch locally, spending nothing', async () => {
      const { port, runtime } = build();

      await expect(port.embed(embedCtx(), { inputs: [] })).rejects.toMatchObject({ errorClass: 'other' });
      expect(runtime.embed).not.toHaveBeenCalled();
    });

    it('refuses a batch above the catalog maximum locally, and accepts exactly the maximum', async () => {
      const { port, runtime } = build();
      const max = KVOX_EMBEDDING.maxBatchSize;
      runtime.embed.mockResolvedValue({ model: KVOX_EMBEDDING.model, vectors: Array.from({ length: max }, () => vector()), inputTokens: null });

      await expect(port.embed(embedCtx(), { inputs: Array.from({ length: max + 1 }, () => 'x') })).rejects.toMatchObject({
        errorClass: 'other',
      });
      expect(runtime.embed).not.toHaveBeenCalled();

      await expect(port.embed(embedCtx(), { inputs: Array.from({ length: max }, () => 'x') })).resolves.toBeDefined();
    });

    it('fails when the vector count does not match the text count', async () => {
      const { port, runtime } = build();
      runtime.embed.mockResolvedValue({ model: 'm', vectors: [vector()], inputTokens: null });

      const error = await failure(() => port.embed(embedCtx(), { inputs: ['a', 'b'] }));

      expect(error.errorClass).toBe('other');
      expect(error.message).toMatch(/1 vectors for 2 texts/);
    });

    it('fails when a vector is not exactly 1536 wide', async () => {
      const { port, runtime } = build();
      runtime.embed.mockResolvedValue({ model: 'm', vectors: [vector(768)], inputTokens: null });

      const error = await failure(() => port.embed(embedCtx(), { inputs: ['a'] }));

      expect(error.errorClass).toBe('other');
      // Widths only; never a vector or a text.
      expect(error.message).toContain('768');
    });

    it('fails when a vector holds a non-finite number', async () => {
      const { port, runtime } = build();
      const bad = vector();
      bad[3] = Number.NaN;
      runtime.embed.mockResolvedValue({ model: 'm', vectors: [bad], inputTokens: null });

      await expect(port.embed(embedCtx(), { inputs: ['a'] })).rejects.toMatchObject({ errorClass: 'other' });
    });

    it('maps a missing key to auth in a job and to key_missing on a route', async () => {
      const { port, runtime } = build();
      runtime.embed.mockRejectedValue(aiError('AI_KEY_REQUIRED'));

      await expect(port.embed(embedCtx(), { inputs: ['a'] })).rejects.toMatchObject({ errorClass: 'auth' });
      await expect(port.embed(routeCtx('search.embed'), { inputs: ['a'] })).rejects.toMatchObject({ errorClass: 'key_missing' });
    });

    it('spells a rejected key as auth for search on a route (the old ai_key_invalid)', async () => {
      const { port, runtime } = build();
      runtime.embed.mockRejectedValue(aiError('AI_KEY_INVALID'));

      await expect(port.embed(routeCtx('search.embed'), { inputs: ['a'] })).rejects.toMatchObject({ errorClass: 'auth' });
      await expect(port.embed(routeCtx('graph.embed'), { inputs: ['a'] })).rejects.toMatchObject({ errorClass: 'key_missing' });
    });

    it('maps a rate limit to rate_limit with the provider\'s retry-after', async () => {
      const { port, runtime } = build();
      runtime.embed.mockRejectedValue(aiError('AI_RATE_LIMITED', { retryAfterMs: 9_000 }));

      const error = await failure(() => port.embed(embedCtx(), { inputs: ['a'] }));

      expect(error.errorClass).toBe('rate_limit');
      expect(error.retryAfterMs).toBe(9_000);
    });

    it('refuses as capability when the host offers no embeddings', async () => {
      const port = createKvoxAi({
        runtime: { stream: jest.fn(), create: jest.fn(), readiness: async () => ({ hasKey: true }) },
        taskModels: { load: async () => state() },
      });

      await expect(port.embed(embedCtx(), { inputs: ['a'] })).rejects.toMatchObject({ errorClass: 'capability' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('the rest of the port', () => {
    it('publishes the embedding catalog through capabilities()', async () => {
      const { port } = build();

      await expect(port.capabilities(jobCtx())).resolves.toMatchObject({
        embeddings: { model: 'text-embedding-3-small', dimensions: 1536 },
      });
      expect(KVOX_EMBEDDING).toMatchObject({ maxInputTokens: 8191, maxBatchSize: 128 });
    });

    it('counts tokens locally: the larger of chars/4 and the word count, rounded up', () => {
      const { port, runtime } = build();
      const at = target({ model: 'gpt-5.4' });

      expect(port.countTokens(at, '')).toBe(0);
      expect(port.countTokens(at, 'abcdefghi')).toBe(3);
      expect(port.countTokens(at, 'a b c d e f g h')).toBe(8);
      expect(runtime.stream).not.toHaveBeenCalled();
      expect(runtime.create).not.toHaveBeenCalled();
    });

    it('uses the registered feature for an embeddings call whose context names none', async () => {
      const { port, runtime } = build();
      runtime.embed.mockResolvedValue({ vectors: [vector()], inputTokens: null });

      await port.embed(jobCtx('nonsense' as KvoxAiFeatureId), { inputs: ['a'] });

      expect(runtime.embed.mock.calls[0][0]).toMatchObject({ feature: 'search_embed' });
    });
  });
});
