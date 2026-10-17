import { z } from 'zod';

import type { AiStreamEvent } from '@marinoscar/platform-api/ai';
import { AiError } from '@marinoscar/platform-api/ai';
import {
  KvoxAiError,
  type KvoxAiContext,
  type KvoxAiErrorClass,
  type KvoxAiPort,
  type KvoxAiTarget,
} from '@marinoscar/kvox-api/ports';

import { completedEvent, functionCallEvent, textDeltaEvent } from './scripted-events.js';

// =============================================================================
// describeKvoxAiConformance (issue #579)
// =============================================================================
//
// The executable proof that a `KvoxAiPort` keeps the model rules of KVox, whatever
// host it is bound for. `createKvoxAi` over a scripted runtime passes it
// (`packages/kvox-ai/test/`), and the web edition's binding over its platform
// `AiService` passes it (`apps/api/test/platform-kvox/kvox-ai-conformance.spec.ts`).
// A Desktop author runs it against their own runtime.
//
// It is test-runner neutral like `describeKvoxPortsConformance`: the caller hands
// over `describe`, `it` and `expect` (Jest or Vitest), or the globals are used.
//
// WHAT IT DRIVES. The suite never reaches inside the port. It asks the host, through
// a {@link KvoxAiConformanceProvider}, to make the PROVIDER do something (answer a
// structured call with a value, stream these events, fail the next round trip with
// this value, hang), and asserts what the port made of it.
//
// THE CASES (ids in {@link KVOX_AI_CONFORMANCE_CASES})
//   structured_request_strict   a structured call sends the vendor a strict schema (validation 1 of 2)
//   structured_valid            a conforming answer comes back as a value of the caller's schema, with usage
//   invalid_output              a well-formed answer that fails the CALLER'S schema is `invalid_output`
//                               (validation 2 of 2: the vendor's own check passed)
//   vendor_invalid_output       the vendor schema check failing (AI_STRUCTURED_OUTPUT_INVALID, well-formed
//                               JSON) is `invalid_output`
//   truncated_finish_reason     a structured answer finishing `length` is `truncated`
//   truncated_unparsable        the platform's form of the same (AI_STRUCTURED_OUTPUT_INVALID, not JSON) on a
//                               call that set an output ceiling is `truncated`
//   chat_tool_calls             a chat step maps to `delta | tool_call | step_end | done`, one `step_end`
//                               per step, and no `delta` after a `tool_call` of the same step
//   rate_limit_job              AI_RATE_LIMITED inside a job is `rate_limit` WITH `retryAfterMs`
//   rate_limit_route            AI_RATE_LIMITED on a route is `rate_limit`
//   auth                        AI_KEY_INVALID inside a job is `auth`
//   refusal                     AI_CONTENT_FILTERED is `refusal`
//   refusal_finish_reason       a response finishing `content_filter` is `refusal`
//   timeout                     a round trip that outlives `requestTimeoutMs` is `timeout`
//   no_key_in_failures          no failure of any call kind carries a key-shaped string, whatever the
//                               provider put in its message
//   no_key_in_events            no event of a streamed call carries one either, even when the provider's
//                               in-band error event does
//   count_tokens                `countTokens` is deterministic, a positive integer, and does not shrink as the
//                               text grows
//
// ⚠ JOB OR ROUTE. The port answers the same platform code differently inside a queue job
// (the context carries a `jobId`) than on a route (no `jobId`): `AI_RATE_LIMITED` keeps
// the provider's retry hint only in a job, because the queue defers on it and a route
// answered the platform's own 429 without one; a rejected key is `auth` in a job and
// `key_missing` on a route. So the cases that depend on it name which context they use:
// `rate_limit_job` and `auth` pass a `jobId`, `rate_limit_route` does not. The table is
// in `src/errors/kvox-ai-errors.ts` and is frozen by `test/fixtures/error-parity.v1.json`.
//
// OPT-OUT, NEVER SKIP. A host that cannot make the provider do something (a platform
// that offers no way to hang a call) names the case in `options.optOut` WITH A REASON.
// The case then runs as a test that prints the reason in its title and asserts the
// reason is real text; a case that is neither run nor opted out fails, and so does an
// opt-out naming a case that does not exist.
// =============================================================================

/** Patterns that would mean a credential leaked into an event or an error. */
const KEY_PATTERNS: readonly RegExp[] = [/sk-[A-Za-z0-9_-]{10,}/, /ghp_|gho_|github_pat_/];

/** A key-shaped string the suite feeds into provider messages, which must never come back out. */
const LEAKED_KEY = 'sk-abcdefghij1234567890';

/**
 * The ids of the conformance cases.
 *
 * @stability experimental
 */
export const KVOX_AI_CONFORMANCE_CASES = [
  'structured_request_strict',
  'structured_valid',
  'invalid_output',
  'vendor_invalid_output',
  'truncated_finish_reason',
  'truncated_unparsable',
  'chat_tool_calls',
  'rate_limit_job',
  'rate_limit_route',
  'auth',
  'refusal',
  'refusal_finish_reason',
  'timeout',
  'no_key_in_failures',
  'no_key_in_events',
  'count_tokens',
] as const;

/**
 * The id of one conformance case.
 *
 * @stability experimental
 */
export type KvoxAiConformanceCase = (typeof KVOX_AI_CONFORMANCE_CASES)[number];

/**
 * The test runner's functions, so the suite runs under Jest or Vitest. When
 * omitted, the globals are used.
 *
 * @stability experimental
 */
export interface KvoxAiConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * The strict-structured request a provider received, as the suite reads it.
 *
 * @stability experimental
 */
export interface KvoxAiStructuredRequestSeen {
  /** The schema name sent to the vendor. */
  name: string;
  /** The JSON Schema (or Zod schema) sent to the vendor. */
  schema: unknown;
  /** Whether the vendor was held to it. */
  strict: boolean;
}

/**
 * How the suite makes the PROVIDER behave. Every method arranges the NEXT round
 * trip(s) only; the host decides what that means for its own stack (a scripted
 * runtime queues a step, the web edition arms its `AiService` stand-in).
 *
 * @stability experimental
 */
export interface KvoxAiConformanceProvider {
  /**
   * The next structured (complete) round trip answers with `value` as the parsed
   * answer, finishing with `finishReason` (default `stop`).
   */
  structuredAnswer(answer: { value: unknown; finishReason?: 'stop' | 'length' | 'content_filter' }): void;
  /** The next streamed round trip yields exactly these events. */
  streamAnswer(events: AiStreamEvent[]): void;
  /** The next round trip, of any kind, throws `error` (as the platform or an adapter would). */
  failNext(error: unknown): void;
  /** The next round trip never answers; it settles when the call's signal aborts, with the signal's reason. */
  hangNext(): void;
  /** The request of the most recent structured round trip, or `undefined` when none was made. */
  lastStructuredRequest?(): KvoxAiStructuredRequestSeen | undefined;
}

/**
 * What a host builds for one test: the port under test and the provider handle.
 *
 * @stability experimental
 */
export interface KvoxAiConformanceUnderTest {
  /** The port. */
  port: KvoxAiPort;
  /** How to make the provider under it behave. */
  provider: KvoxAiConformanceProvider;
  /** The user to call as. Default: a throwaway user. */
  userId?: string;
  /** Releases whatever the build made. */
  dispose?(): Promise<void> | void;
}

/**
 * What the suite tells a host's build function.
 *
 * @stability experimental
 */
export interface KvoxAiConformanceBuildOptions {
  /** The request timeout the port must use, in milliseconds. Absent: the host's default. */
  requestTimeoutMs?: number;
}

/**
 * Options of {@link describeKvoxAiConformance}.
 *
 * @stability experimental
 */
export interface KvoxAiConformanceOptions {
  /** Cases the host cannot produce, each with the reason (a non-empty sentence). */
  optOut?: Partial<Record<KvoxAiConformanceCase, string>>;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A hung call must outlive a short timeout but never the test's own. */
const TIMEOUT_MS = 100;

/**
 * Registers the AI-port conformance suite.
 *
 * @param name - the binding under test, for the test titles.
 * @param build - builds a fresh port and provider handle for one test.
 * @param harness - the runner's `describe`, `it` and `expect`; defaults to the globals.
 * @param options - the reasoned opt-outs.
 * @stability experimental
 */
export function describeKvoxAiConformance(
  name: string,
  build: (options: KvoxAiConformanceBuildOptions) => KvoxAiConformanceUnderTest | Promise<KvoxAiConformanceUnderTest>,
  harness?: KvoxAiConformanceHarness,
  options: KvoxAiConformanceOptions = {},
): void {
  const h: KvoxAiConformanceHarness = harness ?? {
    describe: (globalThis as any).describe,
    it: (globalThis as any).it,
    expect: (globalThis as any).expect,
  };
  const { expect } = h;
  const optOut = options.optOut ?? {};

  const fixture = z.object({ verdict: z.enum(['yes', 'no']) });

  const routeCtx = (under: KvoxAiConformanceUnderTest): KvoxAiContext => ({
    userId: under.userId ?? 'user-conformance',
    orgId: null,
    feature: 'notes.generate',
  });
  const jobCtx = (under: KvoxAiConformanceUnderTest): KvoxAiContext => ({
    ...routeCtx(under),
    orgId: 'org-conformance',
    jobId: 'job-conformance',
  });
  const targetOf = (under: KvoxAiConformanceUnderTest, ctx: KvoxAiContext): Promise<KvoxAiTarget> =>
    under.port.resolveTask(ctx, ctx.feature);

  const structured = async (under: KvoxAiConformanceUnderTest, ctx: KvoxAiContext, maxOutputTokens?: number) =>
    under.port.generateStructured(ctx, {
      target: await targetOf(under, ctx),
      system: 'Answer in JSON.',
      user: 'Go.',
      schema: fixture,
      schemaName: 'conformance',
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });

  const text = async (under: KvoxAiConformanceUnderTest, ctx: KvoxAiContext) =>
    collect(under.port.generateText(ctx, { target: await targetOf(under, ctx), system: 's', user: 'u' }));

  const chat = async (under: KvoxAiConformanceUnderTest, ctx: KvoxAiContext, withTool: boolean) =>
    collect(
      under.port.chat(ctx, {
        target: await targetOf(under, ctx),
        messages: [{ role: 'user', content: 'Use the tool.' }],
        tools: withTool
          ? [{ name: 'lookup', description: 'Looks something up.', parameters: { type: 'object', properties: {} } }]
          : [],
        toolChoice: withTool ? 'auto' : 'none',
      }),
    );

  const embed = (under: KvoxAiConformanceUnderTest, ctx: KvoxAiContext) => under.port.embed(ctx, { inputs: ['x'] });

  const expectClass = (error: unknown, errorClass: KvoxAiErrorClass): KvoxAiError => {
    expect(`${errorClass}: ${error instanceof KvoxAiError}`).toBe(`${errorClass}: true`);
    expect((error as KvoxAiError).errorClass).toBe(errorClass);
    return error as KvoxAiError;
  };

  const noKey = (what: string, value: unknown): void => {
    const textOf = typeof value === 'string' ? value : JSON.stringify(value);
    for (const pattern of KEY_PATTERNS) expect(`${what}: ${pattern.test(textOf ?? '')}`).toBe(`${what}: false`);
  };

  const withUnder = async (
    buildOptions: KvoxAiConformanceBuildOptions,
    body: (under: KvoxAiConformanceUnderTest) => Promise<void>,
  ): Promise<void> => {
    const under = await build(buildOptions);
    try {
      await body(under);
    } finally {
      await under.dispose?.();
    }
  };

  h.describe(`KVOX_AI conformance: ${name}`, () => {
    // Every case id is either run or opted out with a reason; anything else is a bug in the opt-out list.
    h.it('opt-outs name real cases and carry a reason', () => {
      for (const [id, reason] of Object.entries(optOut)) {
        expect(`${id}: ${(KVOX_AI_CONFORMANCE_CASES as readonly string[]).includes(id)}`).toBe(`${id}: true`);
        expect(`${id}: ${typeof reason === 'string' && reason.trim().length > 0}`).toBe(`${id}: true`);
      }
    });

    const rule = (
      id: KvoxAiConformanceCase,
      title: string,
      body: (under: KvoxAiConformanceUnderTest) => Promise<void>,
      buildOptions: KvoxAiConformanceBuildOptions = {},
    ): void => {
      const reason = optOut[id];
      if (reason !== undefined) {
        h.it(`${title} [opted out: ${reason}]`, () => {
          expect(reason.trim().length).toBeGreaterThan(0);
        });
        return;
      }
      h.it(title, () => withUnder(buildOptions, body));
    };

    rule('structured_request_strict', 'a structured call holds the vendor to a strict schema', async (under) => {
      expect(typeof under.provider.lastStructuredRequest).toBe('function');
      under.provider.structuredAnswer({ value: { verdict: 'yes' } });
      await structured(under, routeCtx(under));
      const seen = under.provider.lastStructuredRequest!();
      expect(seen).toBeDefined();
      expect(seen!.strict).toBe(true);
      expect(seen!.name).toBe('conformance');
      expect(seen!.schema).toBeTruthy();
    });

    rule('structured_valid', 'a conforming structured answer comes back as a value of the caller schema', async (under) => {
      under.provider.structuredAnswer({ value: { verdict: 'no' } });
      const result = await structured(under, routeCtx(under));
      expect(fixture.safeParse(result.value).success).toBe(true);
      expect(result.value).toEqual({ verdict: 'no' });
      expect(result.usage).toBeTruthy();
    });

    rule('invalid_output', 'a well-formed answer that fails the caller schema is invalid_output', async (under) => {
      under.provider.structuredAnswer({ value: { verdict: 'maybe' } });
      const error = await failureOf(() => structured(under, routeCtx(under)));
      expectClass(error, 'invalid_output');
    });

    rule('vendor_invalid_output', 'the vendor schema check failing is invalid_output', async (under) => {
      under.provider.failNext(
        new AiError('AI_STRUCTURED_OUTPUT_INVALID', 'The answer does not match the schema.', {
          details: { issues: [{ path: ['verdict'], code: 'invalid_value', message: 'bad' }] },
        }),
      );
      const error = await failureOf(() => structured(under, routeCtx(under)));
      expectClass(error, 'invalid_output');
    });

    rule('truncated_finish_reason', 'a structured answer cut off at the ceiling is truncated', async (under) => {
      under.provider.structuredAnswer({ value: null, finishReason: 'length' });
      const error = await failureOf(() => structured(under, routeCtx(under), 200));
      expectClass(error, 'truncated');
    });

    rule('truncated_unparsable', 'an unparsable structured answer under an output ceiling is truncated', async (under) => {
      under.provider.failNext(
        new AiError('AI_STRUCTURED_OUTPUT_INVALID', 'The answer is not JSON.', {
          details: { issues: [{ path: [], code: 'invalid_json', message: 'Unexpected end of JSON input' }] },
        }),
      );
      const error = await failureOf(() => structured(under, routeCtx(under), 200));
      expectClass(error, 'truncated');
    });

    rule('chat_tool_calls', 'chat maps tool calls to delta, tool_call, step_end and done, once per step', async (under) => {
      const ctx = routeCtx(under);
      // Step 1: text, a tool call, then text the provider should not have said. Step 2: the answer.
      under.provider.streamAnswer([
        textDeltaEvent('Let me look.'),
        functionCallEvent('call-1', 'lookup', '{"query":"a"}'),
        textDeltaEvent('Text after the call.'),
        completedEvent({ finishReason: 'tool_calls' }),
      ]);
      const first = await chat(under, ctx, true);
      under.provider.streamAnswer([textDeltaEvent('Done.'), completedEvent()]);
      const second = await chat(under, ctx, true);

      for (const events of [first, second]) {
        expect(events.every((event) => ['delta', 'tool_call', 'step_end', 'done'].includes(event.type))).toBe(true);
        expect(events.filter((event) => event.type === 'step_end').length).toBe(1);
        expect(events.filter((event) => event.type === 'done').length).toBe(1);
        expect(events[events.length - 2]?.type).toBe('step_end');
        expect(events[events.length - 1]?.type).toBe('done');
        let afterToolCall = false;
        for (const event of events) {
          if (event.type === 'tool_call') afterToolCall = true;
          expect(afterToolCall && event.type === 'delta').toBe(false);
        }
        noKey('chat events', events);
      }

      const call = first.find((event) => event.type === 'tool_call');
      expect(call).toEqual({ type: 'tool_call', id: 'call-1', name: 'lookup', arguments: { query: 'a' } });
      expect(first[0]).toEqual({ type: 'delta', text: 'Let me look.' });
      expect(second.map((event) => event.type)).toEqual(['delta', 'step_end', 'done']);
    });

    rule('rate_limit_job', 'a 429 inside a job is rate_limit with the retry hint', async (under) => {
      // The hint survives only on the job path (see the header).
      for (const run of [
        (ctx: KvoxAiContext) => text(under, ctx),
        (ctx: KvoxAiContext) => structured(under, ctx),
        (ctx: KvoxAiContext) => chat(under, ctx, false),
      ]) {
        under.provider.failNext(new AiError('AI_RATE_LIMITED', 'Rate limited', { retryAfterMs: 1500 }));
        const error = expectClass(await failureOf(() => run(jobCtx(under))), 'rate_limit');
        expect(error.retryAfterMs).toBe(1500);
      }
    });

    rule('rate_limit_route', 'a 429 on a route is rate_limit', async (under) => {
      under.provider.failNext(new AiError('AI_RATE_LIMITED', 'Rate limited', { retryAfterMs: 1500 }));
      expectClass(await failureOf(() => text(under, routeCtx(under))), 'rate_limit');
    });

    rule('auth', 'a rejected key inside a job is auth', async (under) => {
      // On a route the same code is key_missing (the user can fix it by saving a key); a job has no one to ask.
      for (const code of ['AI_KEY_INVALID', 'AI_KEY_REQUIRED'] as const) {
        under.provider.failNext(new AiError(code, 'The provider rejected the key.'));
        expectClass(await failureOf(() => text(under, jobCtx(under))), 'auth');
      }
    });

    rule('refusal', 'a content-filtered answer is refusal', async (under) => {
      for (const run of [() => text(under, routeCtx(under)), () => structured(under, routeCtx(under))]) {
        under.provider.failNext(new AiError('AI_CONTENT_FILTERED', 'The provider declined to answer.'));
        expectClass(await failureOf(run), 'refusal');
      }
    });

    rule('refusal_finish_reason', 'a response that finishes content_filter is refusal', async (under) => {
      under.provider.streamAnswer([textDeltaEvent('I cannot'), completedEvent({ finishReason: 'content_filter' })]);
      expectClass(await failureOf(() => text(under, routeCtx(under))), 'refusal');

      under.provider.structuredAnswer({ value: null, finishReason: 'content_filter' });
      expectClass(await failureOf(() => structured(under, routeCtx(under))), 'refusal');
    });

    rule(
      'timeout',
      'a round trip that outlives requestTimeoutMs is timeout',
      async (under) => {
        under.provider.hangNext();
        const started = Date.now();
        const error = await failureOf(() => text(under, routeCtx(under)));
        expectClass(error, 'timeout');
        expect(Date.now() - started).toBeLessThan(10_000);

        under.provider.hangNext();
        expectClass(await failureOf(() => chat(under, routeCtx(under), false)), 'timeout');

        under.provider.hangNext();
        expectClass(await failureOf(() => structured(under, routeCtx(under))), 'timeout');
      },
      { requestTimeoutMs: TIMEOUT_MS },
    );

    rule('no_key_in_failures', 'no failure of any call kind carries a key-shaped string', async (under) => {
      const throwables = (): unknown[] => [
        new Error(`upstream said ${LEAKED_KEY} is not valid`),
        new AiError('AI_KEY_INVALID', `rejected ${LEAKED_KEY}`),
        new AiError('AI_PROVIDER_UNAVAILABLE', `down for ${LEAKED_KEY}`),
        new AiError('AI_RATE_LIMITED', `slow ${LEAKED_KEY}`, { retryAfterMs: 10 }),
        new AiError('AI_CONTENT_FILTERED', `declined ${LEAKED_KEY}`),
        new AiError('AI_STRUCTURED_OUTPUT_INVALID', `bad ${LEAKED_KEY}`),
        `a thrown string ${LEAKED_KEY}`,
      ];
      const calls: Array<[string, (ctx: KvoxAiContext) => Promise<unknown>]> = [
        ['generateText', (ctx) => text(under, ctx)],
        ['generateStructured', (ctx) => structured(under, ctx)],
        ['chat', (ctx) => chat(under, ctx, false)],
        ['embed', (ctx) => embed(under, ctx)],
      ];
      for (const [method, run] of calls) {
        for (const ctx of [routeCtx(under), jobCtx(under)]) {
          for (const thrown of throwables()) {
            under.provider.failNext(thrown);
            const error = await failureOf(() => run(ctx));
            expect(`${method}: ${error instanceof KvoxAiError}`).toBe(`${method}: true`);
            noKey(`${method} message`, (error as Error).message);
            noKey(`${method} error`, { ...(error as object), message: (error as Error).message });
          }
        }
      }
    });

    rule('no_key_in_events', 'no event of a streamed call carries a key-shaped string', async (under) => {
      // A provider that streams a key-shaped string in its in-band error must not get it to the caller.
      under.provider.streamAnswer([
        textDeltaEvent('partial'),
        { type: 'error', code: 'AI_PROVIDER_UNAVAILABLE', message: `failed with ${LEAKED_KEY}` },
      ]);
      const seen: unknown[] = [];
      const error = await failureOf(async () => {
        for await (const event of under.port.generateText(routeCtx(under), {
          target: await targetOf(under, routeCtx(under)),
          system: 's',
          user: 'u',
        })) {
          seen.push(event);
        }
      });
      expect(error instanceof KvoxAiError).toBe(true);
      noKey('generateText events', seen);
      noKey('generateText message', (error as Error).message);

      under.provider.streamAnswer([textDeltaEvent('ok'), completedEvent()]);
      noKey('chat events', await chat(under, routeCtx(under), false));
    });

    rule('count_tokens', 'countTokens is deterministic', async (under) => {
      const target = await targetOf(under, routeCtx(under));
      const sentence = 'How many tokens is this sentence?';
      const first = under.port.countTokens(target, sentence);
      expect(under.port.countTokens(target, sentence)).toBe(first);
      expect(Number.isInteger(first)).toBe(true);
      expect(first).toBeGreaterThan(0);
      expect(under.port.countTokens(target, `${sentence} ${sentence} ${sentence}`)).toBeGreaterThanOrEqual(first);
    });
  });
}
