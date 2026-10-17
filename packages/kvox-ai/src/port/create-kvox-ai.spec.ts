import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { AiError, type AiErrorCode, type AiStreamEvent } from '@marinoscar/platform-api/ai';

import {
  AiAuthError,
  AiInputError,
  AiRefusedError,
  AiStructuredOutputError,
  RateLimitError,
} from './ai-errors';
import { EMBEDDING_DIMENSIONS, EmbeddingShapeError, KVOX_EMBEDDING, type KvoxAiFeatureId } from '@marinoscar/kvox-ai';
import { KvoxAiConflict } from './kvox-ai-errors';
import { KVOX_EMBEDDING_MODEL, type KvoxAiResolverState } from './kvox-ai-target-resolver';
import { PlatformKvoxAi } from './platform-kvox-ai';

// =============================================================================
// PlatformKvoxAi (issue #475): `KvoxAi` over a fake `AiUserClient`
// =============================================================================

const USER = 'user-1';
const ORG = 'org-1';
const JOB = 'job-1';

// -- Fixtures ---------------------------------------------------------------

function model(id: string, extra: Partial<KvoxAiResolverState['models'][number]> = {}) {
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
  policy?: Partial<KvoxAiResolverState['policy']>;
  provider?: string | null;
  models?: KvoxAiResolverState['models'];
} = {}): KvoxAiResolverState {
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

function build(opts: { state?: KvoxAiResolverState; hasKey?: boolean; timeoutMs?: number } = {}) {
  const client = {
    stream: jest.fn(),
    respondStructured: jest.fn(),
    embed: jest.fn(),
  };
  const forUser = jest.fn().mockReturnValue(client);
  const loadState = jest.fn().mockResolvedValue(opts.state ?? state());
  const findUnique = jest.fn().mockResolvedValue(opts.hasKey === false ? null : { id: 'key-1' });
  const requestTimeoutMs = jest.fn().mockResolvedValue(opts.timeoutMs ?? 600_000);

  const service = new PlatformKvoxAi(
    { forUser } as never,
    { loadState } as never,
    { userAiKey: { findUnique } } as never,
    { requestTimeoutMs } as never,
  );

  return { service, client, forUser, loadState, findUnique, requestTimeoutMs };
}

const call = (extra: Record<string, unknown> = {}) => ({
  userId: USER,
  orgId: ORG,
  jobId: JOB,
  feature: 'note_generate' as KvoxAiFeatureId,
  system: 'SYSTEM',
  user: 'USER',
  ...extra,
});

describe('PlatformKvoxAi', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // ---------------------------------------------------------------------------
  describe('readiness', () => {
    it('is ready on the default model, with that model\'s own numbers, for a feature with no task', async () => {
      const { service, findUnique } = build();

      await expect(service.readiness(USER, 'note_generate')).resolves.toEqual({
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
      // Existence only: the secret column is never selected.
      expect(findUnique).toHaveBeenCalledWith({
        where: { userId_provider: { userId: USER, provider: 'openai' } },
        select: { id: true },
      });
    });

    it('prefers a requested enabled model, and refuses one the deployment has not enabled', async () => {
      const { service } = build();

      await expect(service.readiness(USER, 'note_generate', 'gpt-5.4')).resolves.toMatchObject({
        ok: true,
        model: 'gpt-5.4',
        source: 'requested',
      });
      await expect(service.readiness(USER, 'note_generate', 'gpt-0')).resolves.toMatchObject({
        ok: false,
        reason: 'model_not_permitted',
        model: 'gpt-0',
      });
    });

    it('floors the numbers of a model whose row carries none', async () => {
      const { service } = build({
        state: state({ models: [model('gpt-5.4-mini', { contextWindow: null, maxOutputTokens: null })] }),
      });

      await expect(service.readiness(USER, 'note_generate')).resolves.toMatchObject({
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
      });
    });

    it('reports a missing key without throwing', async () => {
      const { service } = build({ hasKey: false });

      await expect(service.readiness(USER, 'note_generate')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_key_missing',
        hasKey: false,
        model: 'gpt-5.4-mini',
      });
    });

    it('is not configured when the provider slot is off, with no model to quote', async () => {
      const { service } = build({ state: state({ provider: null, models: [] }) });

      await expect(service.readiness(USER, 'note_generate')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_not_configured',
        provider: null,
        model: null,
        contextWindowTokens: null,
        maxOutputTokens: null,
      });
    });

    it('is not configured when no default model is usable and none was requested', async () => {
      const { service } = build({ state: state({ policy: { defaultModel: null } }) });

      await expect(service.readiness(USER, 'note_generate')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_not_configured',
        model: null,
      });
    });

    it('answers graph_disabled before anything else for a task feature', async () => {
      const { service } = build({ state: state({ policy: { graphEnabled: false } }), hasKey: false });

      await expect(service.readiness(USER, 'graph_extract')).resolves.toMatchObject({
        ok: false,
        reason: 'graph_disabled',
      });
    });

    it('uses the task model and its own reasoning effort for a task feature', async () => {
      const { service } = build({
        state: state({
          policy: { taskModels: { 'graph.extract': { model: 'gpt-5.4', reasoningEffort: 'high' } } },
        }),
      });

      await expect(service.readiness(USER, 'graph_extract')).resolves.toMatchObject({
        ok: true,
        model: 'gpt-5.4',
        source: 'task',
        reasoningEffort: 'high',
      });
    });

    it('checks the key before the requested model is judged, as the retired resolver did', async () => {
      const { service } = build({ hasKey: false });

      await expect(service.readiness(USER, 'graph_extract', 'gpt-0')).resolves.toMatchObject({
        reason: 'ai_key_missing',
      });
    });

    it('refuses a model that lacks a capability the task requires', async () => {
      const { service } = build({
        state: state({
          models: [model('gpt-5.4-mini', { structuredOutput: false })],
        }),
      });

      await expect(service.readiness(USER, 'graph_extract')).resolves.toMatchObject({
        ok: false,
        reason: 'model_lacks_capability',
        model: 'gpt-5.4-mini',
      });
    });

    it('answers the catalog embeddings model for an embedding feature, with no chat numbers', async () => {
      const { service } = build();

      await expect(service.readiness(USER, 'search_embed')).resolves.toMatchObject({
        ok: true,
        model: KVOX_EMBEDDING_MODEL,
        contextWindowTokens: null,
        maxOutputTokens: null,
      });
    });

    it('reports a missing key for an embedding feature', async () => {
      const { service } = build({ hasKey: false });

      await expect(service.readiness(USER, 'graph_embed')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_key_missing',
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('streamText', () => {
    it('binds the platform client to user, org, feature and job, and maps deltas and the done event', async () => {
      const { service, client, forUser } = build();
      client.stream.mockReturnValue(
        events(
          { type: 'response.created', id: 'r' },
          { type: 'output_text.delta', delta: 'Hello ' },
          { type: 'reasoning_summary.delta', delta: 'thinking' },
          { type: 'output_text.delta', delta: 'world' },
          completed(),
        ),
      );

      const out = await collect(service.streamText(call({ maxOutputTokens: 900 })));

      expect(out).toEqual([
        { type: 'delta', text: 'Hello ' },
        { type: 'delta', text: 'world' },
        {
          type: 'done',
          finishReason: 'stop',
          model: 'gpt-5.4-mini',
          usage: { inputTokens: 12, outputTokens: 7 },
        },
      ]);
      expect(forUser).toHaveBeenCalledWith(USER, { orgId: ORG, jobId: JOB, feature: 'note_generate' });
      expect(client.stream).toHaveBeenCalledWith(
        expect.objectContaining({ instructions: 'SYSTEM', input: 'USER', maxOutputTokens: 900 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('leaves the org and job out of the scope when the caller has none (a route)', async () => {
      const { service, client, forUser } = build();
      client.stream.mockReturnValue(events(completed()));

      await collect(service.streamText({ userId: USER, feature: 'note_generate', system: 's', user: 'u' }));

      expect(forUser).toHaveBeenCalledWith(USER, { feature: 'note_generate' });
    });

    it('sends a per-run model pick, and nothing when the resolver should decide', async () => {
      const { service, client } = build();
      client.stream.mockImplementation(() => events(completed()));

      await collect(service.streamText(call({ model: 'gpt-5.4' })));
      await collect(service.streamText(call({ model: null })));

      expect(client.stream.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.4' });
      expect(client.stream.mock.calls[1][0]).not.toHaveProperty('model');
    });

    it('maps a length finish to length, and an absent usage to null (never 0)', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events(completed({ finishReason: 'length' as never, usage: {} as never })));

      const out = await collect(service.streamText(call()));

      expect(out).toEqual([
        {
          type: 'done',
          finishReason: 'length',
          model: 'gpt-5.4-mini',
          usage: { inputTokens: null, outputTokens: null },
        },
      ]);
    });

    it('throws AiRefusedError in a job on a content-filter finish', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events(completed({ finishReason: 'content_filter' as never })));

      await expect(collect(service.streamText(call()))).rejects.toBeInstanceOf(AiRefusedError);
    });

    it('maps an in-band error event through mapAiError (job and route)', async () => {
      const { service, client } = build();
      client.stream.mockImplementation(() =>
        events({ type: 'error', code: 'AI_KEY_REQUIRED', message: 'no key' }),
      );

      await expect(collect(service.streamText(call()))).rejects.toBeInstanceOf(AiAuthError);
      await expect(
        collect(service.streamText({ userId: USER, feature: 'note_generate', system: 's', user: 'u' })),
      ).rejects.toMatchObject({ reason: 'ai_key_missing' });
    });

    it('maps a rate limit to RateLimitError carrying the provider\'s retry-after', async () => {
      const { service, client } = build();
      client.stream.mockImplementation(() => {
        throw aiError('AI_RATE_LIMITED', { retryAfterMs: 4_000 });
      });

      const failure = await collect(service.streamText(call())).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(RateLimitError);
      expect((failure as RateLimitError).retryAfterMs).toBe(4_000);
    });

    it('treats a stream that ends without a completion as a retryable plain error', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events({ type: 'output_text.delta', delta: 'half' }));

      const failure = await collect(service.streamText(call())).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(AiInputError);
      expect((failure as Error).message).toMatch(/truncated/);
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
        const { service, client } = build({ state: state({ policy: { reasoningEffort: configured } }) });
        client.stream.mockReturnValue(events(completed()));

        await collect(service.streamText(call()));

        const request = client.stream.mock.calls[0][0];
        if (sent === undefined) expect(request).not.toHaveProperty('reasoning');
        else expect(request.reasoning).toEqual({ effort: sent });
      }
    });

    it('lets a per-call reasoningEffort override the deployment policy, and none omits reasoning', async () => {
      const { service, client } = build({ state: state({ policy: { reasoningEffort: 'high' } }) });
      client.stream.mockImplementation(() => events(completed()));

      await collect(service.streamText(call({ reasoningEffort: 'none' })));
      await collect(service.streamText(call({ reasoningEffort: 'xhigh' })));
      await collect(service.streamText(call({ reasoningEffort: 'low' })));
      await collect(service.streamText(call()));

      expect(client.stream.mock.calls[0][0]).not.toHaveProperty('reasoning');
      expect(client.stream.mock.calls[1][0].reasoning).toEqual({ effort: 'high' });
      expect(client.stream.mock.calls[2][0].reasoning).toEqual({ effort: 'low' });
      expect(client.stream.mock.calls[3][0].reasoning).toEqual({ effort: 'high' });
    });

    it('surfaces the caller\'s own abort reason', async () => {
      const { service, client } = build();
      const controller = new AbortController();
      const reason = new DOMException('stop', 'AbortError');
      client.stream.mockImplementation(async function* () {
        controller.abort(reason);
        throw aiError('AI_PROVIDER_UNAVAILABLE', { details: { aborted: true } });
      });

      await expect(collect(service.streamText(call({ signal: controller.signal })))).rejects.toBe(reason);
    });

    it('turns the request-timeout backstop into a plain retryable error', async () => {
      const { service, client } = build({ timeoutMs: 1_000 });
      client.stream.mockImplementation(async function* (_req: unknown, opts: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve()));
        throw aiError('AI_PROVIDER_UNAVAILABLE', { details: { aborted: true } });
      });
      jest.useFakeTimers();

      try {
        const pending = collect(service.streamText(call())).catch((err: unknown) => err);
        await jest.advanceTimersByTimeAsync(1_001);
        const failure = await pending;

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/timed out after 1000 ms/);
      } finally {
        jest.useRealTimers();
      }
    });

    it('still runs when the timeout setting cannot be read', async () => {
      const { service, client, requestTimeoutMs } = build();
      requestTimeoutMs.mockRejectedValue(new Error('db down'));
      client.stream.mockReturnValue(events(completed()));

      await expect(collect(service.streamText(call()))).resolves.toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('generateStructured', () => {
    const schema = z.object({ verdict: z.enum(['same', 'different']) });
    const structured = (
      extra: {
        maxOutputTokens?: number;
        jsonSchema?: Record<string, unknown>;
        model?: string | null;
        reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
      } = {},
    ) => ({
      userId: USER,
      orgId: ORG,
      jobId: JOB,
      feature: 'graph_adjudicate' as KvoxAiFeatureId,
      system: 'SYSTEM',
      user: 'USER',
      schemaName: 'kg_adjudication',
      schema,
      ...extra,
    });

    it('sends the caller schema strict, validates, and returns value, model and usage', async () => {
      const { service, client, forUser } = build();
      client.respondStructured.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      const out = await service.generateStructured(structured({ maxOutputTokens: 500 }));

      expect(out).toEqual({
        value: { verdict: 'same' },
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 12, outputTokens: 7 },
      });
      expect(forUser).toHaveBeenCalledWith(USER, { orgId: ORG, jobId: JOB, feature: 'graph_adjudicate' });
      expect(client.respondStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: 'SYSTEM',
          input: 'USER',
          schema,
          schemaName: 'kg_adjudication',
          strict: true,
          maxOutputTokens: 500,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('converts a JSON Schema with z.fromJSONSchema and validates again with the caller\'s schema', async () => {
      const { service, client } = build();
      const jsonSchema = {
        type: 'object',
        properties: { verdict: { type: 'string', enum: ['same', 'different'] } },
        required: ['verdict'],
        additionalProperties: false,
      };
      client.respondStructured.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      await service.generateStructured(structured({ jsonSchema }));

      const sent = client.respondStructured.mock.calls[0][0];
      // Not the caller's schema: the one converted from the JSON Schema.
      expect(sent.schema).not.toBe(schema);
      expect(sent.strict).toBe(true);
      expect(sent.schema.safeParse({ verdict: 'same' }).success).toBe(true);
      expect(sent.schema.safeParse({ verdict: 'maybe' }).success).toBe(false);
      expect(sent.schema.safeParse({ verdict: 'same', extra: 1 }).success).toBe(false);
    });

    it('falls back to the caller\'s schema when the JSON Schema cannot be converted', async () => {
      const { service, client } = build();
      const unreadable = { type: 'object', properties: { a: { $ref: '#/definitions/nowhere' } } };
      client.respondStructured.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      await service.generateStructured(structured({ jsonSchema: unreadable }));

      expect(client.respondStructured.mock.calls[0][0].schema).toBe(schema);
      expect(client.respondStructured.mock.calls[0][0].strict).toBe(true);
    });

    it('runs the caller\'s own validation on what the platform parsed', async () => {
      const { service, client } = build();
      // The platform's converted schema let it through; the caller's stricter one does not.
      client.respondStructured.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'maybe' } });

      const failure = await service.generateStructured(structured()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(AiStructuredOutputError);
      expect((failure as AiStructuredOutputError).reason).toBe('invalid_json');
    });

    it('throws truncated when the response finished on length', async () => {
      const { service, client } = build();
      client.respondStructured.mockResolvedValue({
        ...RESPONSE,
        finishReason: 'length',
        parsed: undefined,
      });

      const failure = await service.generateStructured(structured()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(AiStructuredOutputError);
      expect((failure as AiStructuredOutputError).reason).toBe('truncated');
      expect((failure as AiStructuredOutputError).usage).toEqual({ promptTokens: 12, completionTokens: 7 });
    });

    it('reads a not-valid-JSON platform failure as a truncation when an output ceiling was set', async () => {
      const { service, client } = build();
      client.respondStructured.mockRejectedValue(
        aiError('AI_STRUCTURED_OUTPUT_INVALID', {
          details: { issues: [{ path: [], code: 'invalid_json', message: 'Unexpected end of JSON input' }] },
        }),
      );

      const failure = await service
        .generateStructured(structured({ maxOutputTokens: 500 }))
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(AiStructuredOutputError);
      expect((failure as AiStructuredOutputError).reason).toBe('truncated');
    });

    it('reads the same failure as invalid_json when no ceiling was set', async () => {
      const { service, client } = build();
      client.respondStructured.mockRejectedValue(
        aiError('AI_STRUCTURED_OUTPUT_INVALID', {
          details: { issues: [{ path: [], code: 'invalid_json', message: 'Unexpected end of JSON input' }] },
        }),
      );

      const failure = await service.generateStructured(structured()).catch((err: unknown) => err);

      expect((failure as AiStructuredOutputError).reason).toBe('invalid_json');
    });

    it('reads a schema mismatch as invalid_json even with a ceiling', async () => {
      const { service, client } = build();
      client.respondStructured.mockRejectedValue(
        aiError('AI_STRUCTURED_OUTPUT_INVALID', {
          details: { issues: [{ path: ['verdict'], code: 'invalid_value', message: 'bad' }] },
        }),
      );

      const failure = await service
        .generateStructured(structured({ maxOutputTokens: 500 }))
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(AiStructuredOutputError);
      expect((failure as AiStructuredOutputError).reason).toBe('invalid_json');
    });

    it('never puts model output in an error message', async () => {
      const { service, client } = build();
      client.respondStructured.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'SECRET-OUTPUT' } });

      const failure = await service.generateStructured(structured()).catch((err: unknown) => err);

      expect((failure as Error).message).not.toContain('SECRET-OUTPUT');
    });

    it.each<[AiErrorCode, new (...args: never[]) => Error]>([
      ['AI_KEY_REQUIRED', AiAuthError],
      ['AI_KEY_INVALID', AiAuthError],
      ['AI_MODEL_NOT_ENABLED', AiInputError],
      ['AI_CAPABILITY_UNSUPPORTED', AiInputError],
      ['AI_CONTENT_FILTERED', AiRefusedError],
      ['AI_RATE_LIMITED', RateLimitError],
    ])('maps %s to the job error class', async (code, expected) => {
      const { service, client } = build();
      client.respondStructured.mockRejectedValue(aiError(code, { retryAfterMs: 1_000 }));

      await expect(service.generateStructured(structured())).rejects.toBeInstanceOf(expected);
    });

    it('answers a provider outage with a plain retryable error', async () => {
      const { service, client } = build();
      client.respondStructured.mockRejectedValue(aiError('AI_PROVIDER_UNAVAILABLE'));

      const failure = await service.generateStructured(structured()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(AiInputError);
      expect(failure).not.toBeInstanceOf(AiAuthError);
    });

    it('lets a per-call reasoningEffort override the task and policy effort', async () => {
      const { service, client } = build({
        state: state({
          policy: {
            reasoningEffort: 'low',
            taskModels: { 'graph.adjudicate': { model: 'gpt-5.4', reasoningEffort: 'high' } },
          },
        }),
      });
      client.respondStructured.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      await service.generateStructured(structured({ reasoningEffort: 'none' }));
      await service.generateStructured(structured({ reasoningEffort: 'medium' }));

      expect(client.respondStructured.mock.calls[0][0]).not.toHaveProperty('reasoning');
      expect(client.respondStructured.mock.calls[1][0].reasoning).toEqual({ effort: 'medium' });
    });

    it('uses the task\'s reasoning effort only when it is the task\'s configured model', async () => {
      const { service, client } = build({
        state: state({
          policy: {
            reasoningEffort: 'low',
            taskModels: { 'graph.adjudicate': { model: 'gpt-5.4', reasoningEffort: 'high' } },
          },
        }),
      });
      client.respondStructured.mockResolvedValue({ ...RESPONSE, parsed: { verdict: 'same' } });

      await service.generateStructured(structured());
      await service.generateStructured(structured({ model: 'gpt-5.4-mini' }));

      expect(client.respondStructured.mock.calls[0][0].reasoning).toEqual({ effort: 'high' });
      expect(client.respondStructured.mock.calls[1][0].reasoning).toEqual({ effort: 'low' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('embed', () => {
    const embedCall = (texts: string[], extra: Record<string, unknown> = {}) => ({
      userId: USER,
      orgId: ORG,
      jobId: JOB,
      feature: 'search_embed' as KvoxAiFeatureId,
      texts,
      ...extra,
    });

    it('sends the catalog model and width, and returns vectors in input order with usage and model', async () => {
      const { service, client, forUser } = build();
      const first = vector(EMBEDDING_DIMENSIONS, 0.1);
      const second = vector(EMBEDDING_DIMENSIONS, 0.2);
      client.embed.mockResolvedValue({
        provider: 'openai',
        model: 'text-embedding-3-small-0001',
        vectors: [first, second],
        dimensions: EMBEDDING_DIMENSIONS,
        usage: { inputTokens: 33 },
      });

      const out = await service.embed(embedCall(['a', 'b']));

      expect(out).toEqual({
        vectors: [first, second],
        promptTokens: 33,
        model: 'text-embedding-3-small-0001',
      });
      expect(forUser).toHaveBeenCalledWith(USER, { orgId: ORG, jobId: JOB, feature: 'search_embed' });
      expect(client.embed).toHaveBeenCalledWith(
        {
          provider: 'openai',
          model: 'text-embedding-3-small',
          input: ['a', 'b'],
          dimensions: 1536,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('reports an absent token count as null (never 0) and falls back to the catalog model', async () => {
      const { service, client } = build();
      client.embed.mockResolvedValue({
        provider: 'openai',
        vectors: [vector()],
        dimensions: EMBEDDING_DIMENSIONS,
        usage: {},
      });

      await expect(service.embed(embedCall(['a']))).resolves.toMatchObject({
        promptTokens: null,
        model: KVOX_EMBEDDING.model,
      });
    });

    it('refuses an empty batch locally, spending nothing', async () => {
      const { service, client, forUser } = build();

      await expect(service.embed(embedCall([]))).rejects.toBeInstanceOf(AiInputError);
      expect(forUser).not.toHaveBeenCalled();
      expect(client.embed).not.toHaveBeenCalled();
    });

    it('refuses a batch above the catalog maximum locally, and accepts exactly the maximum', async () => {
      const { service, client } = build();
      const max = KVOX_EMBEDDING.maxBatchSize;
      client.embed.mockResolvedValue({
        provider: 'openai',
        model: KVOX_EMBEDDING.model,
        vectors: Array.from({ length: max }, () => vector()),
        dimensions: EMBEDDING_DIMENSIONS,
        usage: {},
      });

      await expect(service.embed(embedCall(Array.from({ length: max + 1 }, () => 'x')))).rejects.toBeInstanceOf(
        AiInputError,
      );
      expect(client.embed).not.toHaveBeenCalled();

      await expect(service.embed(embedCall(Array.from({ length: max }, () => 'x')))).resolves.toBeDefined();
    });

    it('throws when the vector count does not match the text count', async () => {
      const { service, client } = build();
      client.embed.mockResolvedValue({ provider: 'openai', model: 'm', vectors: [vector()], dimensions: 1536, usage: {} });

      const failure = await service.embed(embedCall(['a', 'b'])).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(EmbeddingShapeError);
      expect((failure as EmbeddingShapeError).kind).toBe('count');
    });

    it('throws when a vector is not exactly 1536 wide', async () => {
      const { service, client } = build();
      client.embed.mockResolvedValue({
        provider: 'openai',
        model: 'm',
        vectors: [vector(768)],
        dimensions: 768,
        usage: {},
      });

      const failure = await service.embed(embedCall(['a'])).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(EmbeddingShapeError);
      expect((failure as EmbeddingShapeError).kind).toBe('dimension');
      // Widths only; never a vector or a text.
      expect((failure as Error).message).toContain('768');
    });

    it('throws when a vector holds a non-finite number', async () => {
      const { service, client } = build();
      const bad = vector();
      bad[3] = Number.NaN;
      client.embed.mockResolvedValue({ provider: 'openai', model: 'm', vectors: [bad], dimensions: 1536, usage: {} });

      await expect(service.embed(embedCall(['a']))).rejects.toBeInstanceOf(EmbeddingShapeError);
    });

    it('maps a missing key to AiAuthError in a job and to a 409 on a route', async () => {
      const { service, client } = build();
      client.embed.mockRejectedValue(aiError('AI_KEY_REQUIRED'));

      await expect(service.embed(embedCall(['a']))).rejects.toBeInstanceOf(AiAuthError);

      const failure = await service
        .embed({ userId: USER, feature: 'search_embed', texts: ['a'] })
        .catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(KvoxAiConflict);
      expect((failure as KvoxAiConflict).reason).toBe('ai_key_missing');
    });

    it('spells a rejected key ai_key_invalid for search on a route', async () => {
      const { service, client } = build();
      client.embed.mockRejectedValue(aiError('AI_KEY_INVALID'));

      const failure = await service
        .embed({ userId: USER, feature: 'search_embed', texts: ['a'] })
        .catch((err: unknown) => err);

      expect((failure as KvoxAiConflict).reason).toBe('ai_key_invalid');
    });

    it('maps a rate limit to RateLimitError with the provider\'s retry-after', async () => {
      const { service, client } = build();
      client.embed.mockRejectedValue(aiError('AI_RATE_LIMITED', { retryAfterMs: 9_000 }));

      const failure = await service.embed(embedCall(['a'])).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(RateLimitError);
      expect((failure as RateLimitError).retryAfterMs).toBe(9_000);
    });
  });

  // ---------------------------------------------------------------------------
  describe('the rest of the port', () => {
    it('publishes the embedding catalog', () => {
      expect(build().service.embeddingCapability()).toEqual({
        model: 'text-embedding-3-small',
        dimensions: 1536,
        maxInputTokens: 8191,
        maxBatchSize: 128,
      });
      // The resolver's own constant must agree with the catalog.
      expect(KVOX_EMBEDDING_MODEL).toBe(KVOX_EMBEDDING.model);
    });

    it('counts tokens locally: the larger of chars/4 and the word count, rounded up', () => {
      const { service, forUser } = build();

      expect(service.countTokens('', 'gpt-5.4')).toBe(0);
      expect(service.countTokens('abcdefghi', 'gpt-5.4')).toBe(3);
      expect(service.countTokens('a b c d e f g h', 'gpt-5.4')).toBe(8);
      expect(forUser).not.toHaveBeenCalled();
    });
  });
});
