import { Prisma, aiProviderThrottleKey } from '../../core/index.js';
import { GraphAiRunResolver } from '../../graph/index.js';
import {
  KvoxAiBudgetError,
  KvoxAiError,
  KvoxRateLimitError,
  type KvoxAiTarget,
  type KvoxChatEvent,
  type KvoxChatMessage,
  type KvoxJob,
} from '../../ports/index.js';
import {
  ASK_ANSWER_HOLD_CHARS,
  ASK_MAX_TOOL_CALLS_PER_STEP,
  ASK_MAX_TOOL_STEPS,
  ASK_RESPOND_MAX_RUNTIME_MS,
  ASK_WALL_CLOCK_SOFT_MS,
} from '../ask-limits.js';
import { ASK_FORCED_ANSWER_LINE } from '../ask-prompt.js';
import { resolveAskOptions } from '../ask.options.js';
import { ASK_RESPOND_JOB_TYPE, type AskRespondPayload } from '../job-types.js';
import { HandleRegistry } from '../tools/handle-registry.js';
import { AskRespondHandler, recordedArguments, TOO_MANY_TOOL_CALLS_ERROR } from './ask-respond.handler.js';

// =============================================================================
// `ask.respond` with every collaborator mocked and a SCRIPTED `KVOX_AI.chat()`
// (the port, #497): each model call replays one array of events, and
// every request is captured, so
// the loop, the caps, the hold rule and the append-only buffer are asserted
// exactly (issue #378).
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const QUESTION_ID = '44444444-4444-4444-8444-444444444444';
const ENTITY = '55555555-5555-4555-8555-555555555555';
const EVIDENCE = '66666666-6666-4666-8666-666666666666';

/** One scripted model call; an `Error` is thrown when the call starts, an event that is one is thrown when reached. */
type Script = Array<KvoxChatEvent | Error> | ((request: ChatRequest) => KvoxChatEvent[]) | Error;

interface ChatRequest {
  ctx: { userId: string; orgId: string | null; feature: string; jobId?: string; signal?: AbortSignal };
  target: KvoxAiTarget;
  messages: KvoxChatMessage[];
  tools: unknown[];
  toolChoice: 'auto' | 'none';
}

/** The end of a model call: the platform's `step_end`, then `done`. A `tool_calls` stop is an ordinary `stop` to the port. */
const done = (
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop',
  p = 10,
  c = 5,
): KvoxChatEvent => ({
  type: 'done',
  usage: { inputTokens: p, outputTokens: c },
  ...(finishReason === 'length' || finishReason === 'content_filter' ? { finishReason } : {}),
});
const text = (t: string): KvoxChatEvent => ({ type: 'delta', text: t });
const call = (id: string, name = 'search', args = '{"query":"acme"}'): KvoxChatEvent => {
  let parsed: unknown = args;
  try {
    parsed = JSON.parse(args);
  } catch {
    // The adapter hands back the raw text of arguments that are not JSON.
  }

  return { type: 'tool_call', id, name, arguments: parsed };
};
const LONG = 'Acme is a client of yours and signed the renewal in August.[^ev1] It is led by Sarah.[^ent1]';

function payload(over: Partial<AskRespondPayload> = {}): AskRespondPayload {
  return {
    assistantMessageId: MSG,
    conversationId: CONV,
    userId: USER,
    model: 'gpt-test',
    providerId: 'openai',
    reasoningEffort: 'low',
    ...over,
  };
}

function job(p: unknown = payload()): KvoxJob {
  return { id: 'job-1', type: ASK_RESPOND_JOB_TYPE, payload: p } as unknown as KvoxJob;
}

interface SetupOptions {
  scripts?: Script[];
  status?: string;
  row?: unknown;
  /** Makes the model port refuse to resolve a task, like a policy that changed since the request. */
  resolveFailure?: KvoxAiError;
  /** The `ai` system settings. */
  policy?: Record<string, unknown>;
  permissions?: string[];
  scopeEntityId?: string | null;
  scopeEntity?: unknown;
  history?: Array<{ id: string; role: string; status: string; content: string }>;
  contextWindowTokens?: number;
  execute?: jest.Mock;
  options?: Parameters<typeof resolveAskOptions>[0];
}

function setup(opts: SetupOptions = {}) {
  const requests: ChatRequest[] = [];
  const scripts = [...(opts.scripts ?? [[text(LONG), done()]])];
  const chat = jest.fn((ctx: ChatRequest['ctx'], request: Omit<ChatRequest, 'ctx'>) => {
    // Deep-copy: the handler keeps appending to its own array.
    requests.push({ ctx, ...(JSON.parse(JSON.stringify(request)) as Omit<ChatRequest, 'ctx'>) });
    const script = scripts.shift() ?? [text('Fallback answer that is long enough to be released as text.'), done()];
    return (async function* () {
      if (script instanceof Error) throw script;
      const events = typeof script === 'function' ? script(requests[requests.length - 1]) : script;
      for (const e of events) {
        if (e instanceof Error) throw e;
        // Every model call ends with its `step_end`, then `done`.
        if (e.type === 'done') yield { type: 'step_end' };
        yield e;
      }
    })();
  });

  const resolveTask = jest.fn(async (_ctx: unknown, _task: string, o?: { model?: string }) => {
    if (opts.resolveFailure) throw opts.resolveFailure;
    return {
      provider: 'openai',
      model: o?.model ?? 'gpt-test',
      reasoningEffort: 'low',
      contextWindowTokens: opts.contextWindowTokens ?? 128_000,
      maxOutputTokens: 16_000,
      source: 'task',
    };
  });
  const capabilities = jest.fn(async () => ({ toolCalling: true }));
  const ai = { resolveTask, capabilities, chat, countTokens: (_target: unknown, t: string) => Math.ceil(t.length / 4) };
  const policy = { graphEnabled: true, maxInputTokens: 100_000, maxOutputTokens: 16_000, ...opts.policy };
  const settings = { readSystem: jest.fn(async () => ({ value: policy, version: 1 })) };
  const resolver = new GraphAiRunResolver(ai as never, settings as never);
  const permissions = opts.permissions ?? ['graph:read'];
  const identity = { hasPermission: jest.fn(async (_userId: string, permission: string) => permissions.includes(permission)) };

  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const conversationWrites: unknown[] = [];
  const prisma = {
    askMessage: {
      findFirst: jest.fn().mockResolvedValue(
        opts.row === undefined
          ? {
              id: MSG,
              status: opts.status ?? 'pending',
              createdAt: new Date('2026-09-26T10:00:00.001Z'),
              conversation: { id: CONV, ownerId: USER, scopeEntityId: opts.scopeEntityId ?? null },
            }
          : opts.row,
      ),
      findMany: jest.fn().mockResolvedValue(
        // newest first, as queried
        [
          { id: MSG, role: 'assistant', status: 'streaming', content: '' },
          { id: QUESTION_ID, role: 'user', status: 'complete', content: 'What is going on with Acme?' },
          ...(opts.history ?? []),
        ],
      ),
      updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push(JSON.parse(JSON.stringify(args)));
        return { count: 1 };
      }),
    },
    askConversation: {
      updateMany: jest.fn(async (args: unknown) => {
        conversationWrites.push(args);
        return { count: 1 };
      }),
    },
    kgEntity: { findFirst: jest.fn().mockResolvedValue(opts.scopeEntity ?? null) },
    $queryRaw: jest.fn().mockResolvedValue([
      { key: EVIDENCE, evidenceId: EVIDENCE, transcriptId: 't', noteId: null, startMs: 4000, transcriptTitle: 'Sync', noteTitle: null },
    ]),
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  // The host's transcript-visibility rule; the citation lookup runs inside the viewer's scope.
  const visibility = {
    viewerFor: jest.fn(async (userId: string) => ({ userId })),
    transcriptVisibleSql: jest.fn(() => Prisma.sql`true`),
    run: jest.fn(async (_viewer: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  const handles = new HandleRegistry();
  const toolCtx = { user: { id: USER }, handles, personalFactsAllowed: false, scopeEntityId: null, now: new Date() };
  const toolset = {
    definitions: jest.fn(() => [{ name: 'search', description: 'Search', parameters: { type: 'object' } }]),
    createContext: jest.fn().mockResolvedValue(toolCtx),
    execute: (
      opts.execute ??
      jest.fn(async (ctx: { handles: HandleRegistry }) => {
        ctx.handles.register({ kind: 'ev', id: EVIDENCE });
        ctx.handles.register({ kind: 'ent', id: ENTITY, label: 'Acme' });
        return {
          ok: true,
          result: { data: { entities: [] }, resultCount: 2, summary: 'Found 2 things', truncated: false },
          json: '{"entities":[{"ref":"ent1"}],"truncated":false}',
        };
      })
    ) as jest.Mock,
  };
  const jobs = { registerHandler: jest.fn() };

  const handler = new AskRespondHandler(
    jobs as never,
    prisma as never,
    ai as never,
    identity as never,
    resolver,
    toolset as never,
    visibility as never,
    resolveAskOptions(opts.options),
  );
  let now = 1_000_000;
  handler.clock = () => now;
  const advance = (ms: number) => {
    now += ms;
  };

  const final = () => writes[writes.length - 1].data;
  const contentWrites = () => writes.map((w) => w.data.content).filter((c): c is string => typeof c === 'string');

  return { handler, prisma, resolveTask, capabilities, identity, toolset, chat, requests, writes, final, contentWrites, jobs, advance, conversationWrites, handles };
}

describe('AskRespondHandler (#378)', () => {
  describe('declaration', () => {
    it('is ask.respond, one attempt, five minutes, server-only, and self-registers', () => {
      const { handler, jobs } = setup();
      expect(handler.type).toBe('ask.respond');
      expect(handler.profile).toEqual({ maxRuntimeMs: ASK_RESPOND_MAX_RUNTIME_MS, maxAttempts: 1 });
      expect(ASK_RESPOND_MAX_RUNTIME_MS).toBe(5 * 60_000);
      expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
      expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
      expect((handler as unknown as Record<string, unknown>).nodeSecretBroker).toBeUndefined();
      expect(handler.usesAi).toBe(true);
      handler.onModuleInit();
      expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
    });
  });

  describe('a turn', () => {
    it('answers in one step: streaming → complete with citations, tokens, finish reason and a conversation bump', async () => {
      const t = setup({
        scripts: [[text(LONG), done('stop', 100, 40)]],
        // Pretend earlier tools issued these (a single-step answer citing an unissued marker).
      });
      await t.handler.process(job());

      expect(t.writes[0]).toEqual({
        where: { id: MSG, status: 'pending' },
        data: { status: 'streaming', model: 'gpt-test', provider: 'openai' },
      });
      const final = t.final();
      expect(final).toMatchObject({
        status: 'complete',
        content: LONG,
        finishReason: 'stop',
        promptTokens: 100,
        completionTokens: 40,
        errorClass: null,
        toolCalls: [],
      });
      // No tool ran, so neither marker was issued this turn → both invalid.
      expect(final.citations).toEqual([
        expect.objectContaining({ marker: 'ev1', valid: false, id: null }),
        expect.objectContaining({ marker: 'ent1', valid: false, id: null }),
      ]);
      expect(t.conversationWrites).toEqual([{ where: { id: CONV }, data: { updatedAt: expect.any(Date) } }]);
      expect(t.requests[0].toolChoice).toBe('auto');
      expect(t.requests[0].target.reasoningEffort).toBe('low');
      // Every call is made for `ask.respond` under THIS job (the host records its usage row from them),
      // on the model the run resolved, with the clamped output ceiling and a per-call time backstop.
      expect(t.requests[0].ctx).toMatchObject({ userId: USER, orgId: null, feature: 'ask.respond', jobId: 'job-1' });
      expect(t.requests[0].ctx.signal).toBeInstanceOf(AbortSignal);
      expect(t.requests[0].target).toMatchObject({ model: 'gpt-test', provider: 'openai' });
      expect(t.requests[0].target.maxOutputTokens).toBeLessThanOrEqual(16_000);
      expect(t.requests[0].messages[0].role).toBe('system');
      expect(t.requests[0].messages[t.requests[0].messages.length - 1]).toEqual({
        role: 'user',
        content: 'What is going on with Acme?',
      });
    });

    it('runs two tool steps, records each call as it runs, then answers with valid citations', async () => {
      const t = setup({
        scripts: [
          [text('Let me check.'), call('c1'), done('tool_calls')],
          [call('c2', 'get_entity', '{"entity":"ent1"}'), done('tool_calls')],
          [text(LONG), done()],
        ],
      });
      await t.handler.process(job());

      expect(t.toolset.execute).toHaveBeenCalledTimes(2);
      expect(t.chat).toHaveBeenCalledTimes(3);
      // One `tool_calls` write per executed tool, before the next model call.
      const toolWrites = t.writes.filter((w) => w.data.toolCalls && !w.data.status);
      expect(toolWrites.map((w) => (w.data.toolCalls as unknown[]).length)).toEqual([1, 2]);

      const final = t.final();
      expect(final.toolCalls).toEqual([
        { index: 0, name: 'search', arguments: { query: 'acme' }, summary: 'Found 2 things', resultCount: 2, durationMs: 0, error: null },
        {
          index: 1,
          name: 'get_entity',
          arguments: { entity: 'ent1' },
          summary: 'Found 2 things',
          resultCount: 2,
          durationMs: 0,
          error: null,
        },
      ]);
      expect(final.citations).toEqual([
        expect.objectContaining({ marker: 'ev1', kind: 'evidence', id: EVIDENCE, valid: true, label: 'Sync', startMs: 4000 }),
        expect.objectContaining({ marker: 'ent1', kind: 'entity', id: ENTITY, valid: true, label: 'Acme' }),
      ]);

      // The second request replays the preamble to the MODEL, and the tool result.
      const second = t.requests[1].messages;
      expect(second).toContainEqual({
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [{ id: 'c1', name: 'search', arguments: { query: 'acme' } }],
      });
      expect(second).toContainEqual({ role: 'tool', toolCallId: 'c1', content: '{"entities":[{"ref":"ent1"}],"truncated":false}' });
    });

    it('never lets text emitted before a tool call reach content', async () => {
      const t = setup({
        scripts: [
          [text('Looking up Acme'), text(' for you now…'), call('c1'), done('tool_calls')],
          [text(LONG), done()],
        ],
      });
      await t.handler.process(job());
      for (const c of t.contentWrites()) expect(c).not.toContain('Looking up');
      expect(t.final().content).toBe(LONG);
    });

    it('only ever appends to content (every write extends the previous one)', async () => {
      const chunks = Array.from({ length: 40 }, (_, i) => text(`Sentence number ${i} of a long answer. `));
      const t = setup({ scripts: [[...chunks, done()]] });
      await t.handler.process(job());
      const writes = t.contentWrites();
      expect(writes.length).toBeGreaterThan(2); // flushed mid-stream (256-character threshold)
      for (let i = 1; i < writes.length; i += 1) expect(writes[i].startsWith(writes[i - 1])).toBe(true);
      expect(writes[writes.length - 1]).toBe(chunks.map((c) => (c as { text: string }).text).join(''));
    });

    it('caps tool steps at 8: the 9th call is forced with toolChoice none and ends step_cap', async () => {
      const toolStep = (i: number): KvoxChatEvent[] => [call(`c${i}`), done('tool_calls')];
      const t = setup({
        scripts: [...Array.from({ length: ASK_MAX_TOOL_STEPS }, (_, i) => toolStep(i)), [text(LONG), done()]],
      });
      await t.handler.process(job());

      expect(t.chat).toHaveBeenCalledTimes(ASK_MAX_TOOL_STEPS + 1);
      expect(t.requests.slice(0, ASK_MAX_TOOL_STEPS).every((r) => r.toolChoice === 'auto')).toBe(true);
      const last = t.requests[ASK_MAX_TOOL_STEPS];
      expect(last.toolChoice).toBe('none');
      expect(last.messages[last.messages.length - 1]).toEqual({ role: 'system', content: ASK_FORCED_ANSWER_LINE });
      expect(t.final()).toMatchObject({ status: 'complete', finishReason: 'step_cap' });
      expect((t.final().toolCalls as unknown[]).length).toBe(ASK_MAX_TOOL_STEPS);
    });

    it('ignores a tool call the model makes after the cap forced an answer', async () => {
      const t = setup({
        scripts: [
          ...Array.from({ length: ASK_MAX_TOOL_STEPS }, (_, i) => [call(`c${i}`), done('tool_calls')]),
          [text(LONG), call('late'), done()],
        ],
      });
      await t.handler.process(job());
      expect(t.toolset.execute).toHaveBeenCalledTimes(ASK_MAX_TOOL_STEPS);
      expect(t.final()).toMatchObject({ status: 'complete', finishReason: 'step_cap', content: LONG });
    });

    it('forces an answer after the soft wall clock and ends time_cap', async () => {
      const t = setup({
        scripts: [[call('c1'), done('tool_calls')], [text(LONG), done()]],
      });
      t.toolset.execute.mockImplementation(async () => {
        t.advance(ASK_WALL_CLOCK_SOFT_MS);
        return { ok: true, result: { data: [], resultCount: 0, summary: 'Nothing', truncated: false }, json: '{"items":[]}' };
      });
      await t.handler.process(job());
      expect(t.requests[1].toolChoice).toBe('none');
      expect(t.final()).toMatchObject({ status: 'complete', finishReason: 'time_cap' });
    });

    it('ends token_cap when the answer stops on length', async () => {
      const t = setup({ scripts: [[text(LONG), done('length')]] });
      await t.handler.process(job());
      expect(t.final()).toMatchObject({ status: 'complete', finishReason: 'token_cap', content: LONG });
    });

    it('forces an answer with token_cap when the input budget leaves no room for another step', async () => {
      // A context window just big enough for the prompt, not for a tool step.
      // (#436: the answer's reserve is Ask's 2,000 plus 'low' effort's 4,096
      // reasoning headroom.)
      const t = setup({ contextWindowTokens: 2_000 + 4_096 + 1_000 + 900, scripts: [[text(LONG), done()]] });
      await t.handler.process(job());
      expect(t.requests[0].toolChoice).toBe('none');
      expect(t.final()).toMatchObject({ status: 'complete', finishReason: 'token_cap' });
    });

    it(`answers extra calls in one step (> ${ASK_MAX_TOOL_CALLS_PER_STEP}) with an error, without running them`, async () => {
      const calls = Array.from({ length: ASK_MAX_TOOL_CALLS_PER_STEP + 2 }, (_, i) => call(`c${i}`));
      const t = setup({ scripts: [[...calls, done('tool_calls')], [text(LONG), done()]] });
      await t.handler.process(job());

      expect(t.toolset.execute).toHaveBeenCalledTimes(ASK_MAX_TOOL_CALLS_PER_STEP);
      const recorded = t.final().toolCalls as Array<{ error: string | null }>;
      expect(recorded).toHaveLength(ASK_MAX_TOOL_CALLS_PER_STEP + 2);
      expect(recorded.slice(-2).map((r) => r.error)).toEqual([TOO_MANY_TOOL_CALLS_ERROR, TOO_MANY_TOOL_CALLS_ERROR]);
      // Every call id still gets a tool message (an orphan would be refused by the provider).
      const toolMessages = t.requests[1].messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(ASK_MAX_TOOL_CALLS_PER_STEP + 2);
    });

    it('feeds a malformed-arguments tool error back to the model and records it', async () => {
      const execute = jest.fn().mockResolvedValue({
        ok: false,
        error: 'Arguments were not valid JSON.',
        json: '{"error":"Arguments were not valid JSON."}',
      });
      const t = setup({ execute, scripts: [[call('c1', 'search', '{not json'), done('tool_calls')], [text(LONG), done()]] });
      await t.handler.process(job());
      expect(t.requests[1].messages).toContainEqual({
        role: 'tool',
        toolCallId: 'c1',
        content: '{"error":"Arguments were not valid JSON."}',
      });
      expect(t.final().toolCalls).toEqual([
        expect.objectContaining({ name: 'search', arguments: {}, resultCount: 0, error: 'Arguments were not valid JSON.' }),
      ]);
    });

    it('pre-registers a readable scope entity as ent1 and names it in the system prompt', async () => {
      const t = setup({
        scopeEntityId: ENTITY,
        scopeEntity: { id: ENTITY, label: 'Sarah Chen', type: 'Person' },
        scripts: [[text('Sarah leads the Atlas project, according to the notes you reviewed.[^ent1]'), done()]],
      });
      await t.handler.process(job());
      expect(t.requests[0].messages[0].content).toContain('This conversation is about Sarah Chen (Person), reference ent1.');
      expect(t.final().citations).toEqual([expect.objectContaining({ marker: 'ent1', valid: true, id: ENTITY, label: 'Sarah Chen' })]);
    });

    it('replays earlier complete turns as history, markers stripped', async () => {
      const t = setup({
        history: [
          { id: 'a0', role: 'assistant', status: 'complete', content: 'Acme is a client.[^ev3]' },
          { id: 'u0', role: 'user', status: 'complete', content: 'Who is Acme?' },
        ],
      });
      await t.handler.process(job());
      expect(t.requests[0].messages.slice(1)).toEqual([
        { role: 'user', content: 'Who is Acme?' },
        { role: 'assistant', content: 'Acme is a client.' },
        { role: 'user', content: 'What is going on with Acme?' },
      ]);
    });

    it('re-validates the payload model against today\'s policy by resolving the ask.respond task', async () => {
      const t = setup();
      await t.handler.process(job(payload({ model: 'gpt-override' })));
      expect(t.resolveTask).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER, feature: 'ask.respond' }),
        'ask.respond',
        expect.objectContaining({ model: 'gpt-override' }),
      );
      expect(t.requests[0].target.model).toBe('gpt-override');
    });

    it('checks the model can call tools before it claims the row', async () => {
      const t = setup();
      t.capabilities.mockResolvedValue({ toolCalling: false });
      await t.handler.process(job());
      expect(t.chat).not.toHaveBeenCalled();
      expect(t.final()).toMatchObject({ status: 'failed', errorClass: 'other' });
    });

    it('makes one chat call per model round trip, each with the same job and feature', async () => {
      const t = setup({ scripts: [[call('c1'), done('tool_calls')], [text(LONG), done()]] });
      await t.handler.process(job());
      expect(t.chat).toHaveBeenCalledTimes(2);
      expect(t.requests.map((r) => [r.ctx.feature, r.ctx.jobId])).toEqual([
        ['ask.respond', 'job-1'],
        ['ask.respond', 'job-1'],
      ]);
    });

    it('joins a later call’s answer to earlier streamed text on a new paragraph', async () => {
      const hold = 'x'.repeat(ASK_ANSWER_HOLD_CHARS);
      const t = setup({ scripts: [[text(hold), call('late'), done('tool_calls')], [text(LONG), done()]] });
      await t.handler.process(job());
      expect(t.final().content).toBe(`${hold}\n\n${LONG}`);
    });
  });

  describe('guards', () => {
    it('returns without work for an unreadable payload', async () => {
      const t = setup();
      await expect(t.handler.process(job({ nope: true }))).resolves.toBeUndefined();
      expect(t.prisma.askMessage.findFirst).not.toHaveBeenCalled();
    });

    it('returns without work when the row is gone (conversation deleted)', async () => {
      const t = setup({ row: null });
      await expect(t.handler.process(job())).resolves.toBeUndefined();
      expect(t.chat).not.toHaveBeenCalled();
      expect(t.writes).toHaveLength(0);
    });

    it.each(['streaming', 'complete', 'failed'])('is a no-op for a %s message (idempotent)', async (status) => {
      const t = setup({ status });
      await t.handler.process(job());
      expect(t.chat).not.toHaveBeenCalled();
      expect(t.writes).toHaveLength(0);
    });

    it('stops without error or further writes when the row vanishes mid-turn', async () => {
      const t = setup({ scripts: [[call('c1'), done('tool_calls')], [text(LONG), done()]] });
      t.prisma.askMessage.updateMany.mockImplementation(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        t.writes.push(args);
        // The claim succeeds; the first tool-call write finds the row gone.
        return { count: t.writes.length === 1 ? 1 : 0 };
      });
      await expect(t.handler.process(job())).resolves.toBeUndefined();
      expect(t.chat).toHaveBeenCalledTimes(1);
      expect(t.writes.some((w) => w.data.status === 'failed')).toBe(false);
      expect(t.conversationWrites).toHaveLength(0);
    });
  });

  describe('failures (keep streamed text, return normally)', () => {
    it.each([
      ['auth', new KvoxAiError('auth', 'bad key')],
      ['auth', new KvoxAiError('key_missing', 'no key')],
      ['refusal', new KvoxAiError('refusal', 'declined')],
      ['budget', new KvoxAiBudgetError(10, 5)],
      ['timeout', new KvoxAiError('timeout', 'The AI request timed out')],
      ['timeout', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ])('%s', async (errorClass, error) => {
      // The first call streams answer text and then calls a tool (a late tool
      // call — the text stays), so a second call happens and throws.
      const t = setup({ scripts: [[text(LONG), call('c1'), done('tool_calls')], error] });
      await expect(t.handler.process(job())).resolves.toBeUndefined();
      expect(t.final()).toMatchObject({ status: 'failed', errorClass, content: LONG });
    });

    it('content_filter fails the turn as a refusal', async () => {
      const t = setup({ scripts: [[text(LONG), done('content_filter')]] });
      await t.handler.process(job());
      expect(t.final()).toMatchObject({ status: 'failed', errorClass: 'refusal', content: LONG });
    });

    it('an empty answer fails as a refusal', async () => {
      const t = setup({ scripts: [[done('stop')]] });
      await t.handler.process(job());
      expect(t.final()).toMatchObject({ status: 'failed', errorClass: 'refusal' });
    });

    it('a missing key fails auth without calling the provider', async () => {
      const t = setup({ resolveFailure: new KvoxAiError('key_missing', 'no key') });
      await t.handler.process(job());
      expect(t.chat).not.toHaveBeenCalled();
      expect(t.final()).toMatchObject({ status: 'failed', errorClass: 'auth' });
    });

    it.each([
      ['ai_key_missing', { resolveFailure: new KvoxAiError('key_missing', 'x') }, 'auth'],
      ['graph_disabled', { policy: { graphEnabled: false } }, 'other'],
      ['ai_not_configured', { resolveFailure: new KvoxAiError('not_configured', 'x') }, 'other'],
      ['model_not_permitted or lacking tools', { resolveFailure: new KvoxAiError('capability', 'x') }, 'other'],
    ] as const)('a readiness refusal %s at run time fails %s and returns', async (_reason, over, errorClass) => {
      const t = setup(over as SetupOptions);
      await expect(t.handler.process(job())).resolves.toBeUndefined();
      expect(t.chat).not.toHaveBeenCalled();
      expect(t.final()).toMatchObject({ status: 'failed', errorClass });
    });

    it('a user who lost graph:read fails without calling the provider', async () => {
      const t = setup({ permissions: [] });
      await t.handler.process(job());
      expect(t.chat).not.toHaveBeenCalled();
      expect(t.final()).toMatchObject({ status: 'failed', errorClass: 'other' });
    });

    it('a question over the input budget fails budget before any provider call', async () => {
      const t = setup({ contextWindowTokens: 2_300 });
      await t.handler.process(job());
      expect(t.chat).not.toHaveBeenCalled();
      expect(t.final()).toMatchObject({ status: 'failed', errorClass: 'budget' });
    });

    it.each([
      ['a bug', new TypeError('boom'), 'boom'],
      ['a transient provider failure', new KvoxAiError('other', 'provider unavailable'), 'provider unavailable'],
    ])('%s fails other AND is rethrown for Job.lastError', async (_label, error, message) => {
      const t = setup({ scripts: [error] });
      await expect(t.handler.process(job())).rejects.toThrow(message);
      expect(t.final()).toMatchObject({ status: 'failed', errorClass: 'other' });
    });
  });

  describe('rate limits', () => {
    it.each([
      ['a provider 429', new KvoxAiError('rate_limit', '429', 1000)],
      ['a rate limit the host already classified', new KvoxRateLimitError(aiProviderThrottleKey(USER), 1000, '429')],
    ])('%s before any flushed text: back to pending, tool calls cleared, deferred on THIS user\'s bucket', async (_label, error) => {
      const t = setup({ scripts: [[call('c1'), done('tool_calls')], error] });
      const outcome = await t.handler.process(job()).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(outcome).toBeInstanceOf(KvoxRateLimitError);
      expect((outcome as KvoxRateLimitError).throttleKey).toBe(aiProviderThrottleKey(USER));
      expect(t.final()).toEqual({ status: 'pending', toolCalls: [], content: '' });
      expect(t.writes[t.writes.length - 1].where).toEqual({ id: MSG, status: 'streaming' });
    });

    it('after text was flushed: failed rate_limit, not rethrown', async () => {
      const long = 'y'.repeat(600);
      const t = setup({ scripts: [[text(long), call('c1'), done('tool_calls')], new KvoxAiError('rate_limit', '429', 1000)] });
      await expect(t.handler.process(job())).resolves.toBeUndefined();
      expect(t.final()).toMatchObject({ status: 'failed', errorClass: 'rate_limit', content: long });
    });
  });

  describe('caps a host lowers', () => {
    it('ends step_cap after the configured number of tool steps', async () => {
      const t = setup({
        options: { limits: { maxSteps: 2 } },
        scripts: [[call('c1'), done('tool_calls')], [call('c2'), done('tool_calls')], [text(LONG), done()]],
      });
      await t.handler.process(job());
      expect(t.requests.map((r) => r.toolChoice)).toEqual(['auto', 'auto', 'none']);
      expect(t.final()).toMatchObject({ status: 'complete', finishReason: 'step_cap' });
    });

    it('runs only the configured number of calls per step', async () => {
      const calls = [call('c1'), call('c2'), call('c3')];
      const t = setup({ options: { limits: { maxCallsPerStep: 1 } }, scripts: [[...calls, done('tool_calls')], [text(LONG), done()]] });
      await t.handler.process(job());
      expect(t.toolset.execute).toHaveBeenCalledTimes(1);
      const recorded = t.final().toolCalls as Array<{ error: string | null }>;
      expect(recorded.slice(-2).map((r) => r.error)).toEqual([
        expect.stringContaining('At most 1 run per step'),
        expect.stringContaining('At most 1 run per step'),
      ]);
    });
  });
});

describe('recordedArguments', () => {
  it('keeps an object, and records anything else as {}', () => {
    expect(recordedArguments('{"a":1}')).toEqual({ a: 1 });
    expect(recordedArguments('[1]')).toEqual({});
    expect(recordedArguments('nope')).toEqual({});
    expect(recordedArguments('null')).toEqual({});
  });
});
