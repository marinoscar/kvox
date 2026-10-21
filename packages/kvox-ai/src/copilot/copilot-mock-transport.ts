import { copilotSignInCancelled, copilotSignInExpired, copilotSignInFailed } from './copilot-errors.js';
import type {
  CopilotAuthStatus,
  CopilotModelInfo,
  CopilotSessionConfig,
  CopilotSessionEvent,
  CopilotSessionHandle,
  CopilotSignInChallenge,
  CopilotTransport,
} from './copilot-transport.js';

// =============================================================================
// A mock Copilot transport, for tests (issue #581)
// =============================================================================
//
// A `CopilotTransport` that behaves like the Copilot runtime closely enough to
// prove the adapter's rules without the SDK, a network or a sign-in:
//
//   • events are emitted ASYNCHRONOUSLY (one `setImmediate` per event) after
//     `send` resolves, in the SDK's order (`assistant.message_delta`...,
//     `assistant.message`, `assistant.usage`, `session.idle`);
//   • `abort()` stops the emission and emits `session.idle { aborted: true }`;
//   • it COUNTS MODEL REQUESTS per session, and plays the runtime's own extra
//     requests (the "please continue" turn after `length`, a retry after a
//     `model.call_failure`) unless the adapter aborts first, so a test asserts
//     the suppressions by counting;
//   • it runs the session's `onUserPromptTransformed` hook on a
//     `<current_datetime>`-prefixed prompt, as the runtime does, and records what
//     the hook handed back (`sentPrompt`);
//   • `builtInTools` names runtime built-ins: a custom tool of such a name without
//     `overridesBuiltInTool` fails session creation, as in the runtime;
//   • `liveTools` makes the session report tools (the tripwire test); a session that
//     declares custom tools (`config.tools`, the Ask bridge) reports those too;
//   • a `toolCalls` reply plays what the runtime does for a model that calls tools
//     (#654): an assistant message with `toolRequests`, the usage, then the CUSTOM
//     TOOL HANDLERS of the session are invoked (in parallel, or one by one) and the
//     runtime's turn WAITS for them; once they all return, it calls the model again
//     with the results (a continuation: the next reply in the queue, or `onSend` with
//     `continuation: true` and the `toolResults`), exactly as the SDK does;
//   • it records every session's config, prompts and cleanup;
//   • its sign-in is SCRIPTED (`scriptSignIn`): a challenge, then success, expiry,
//     cancel, a runtime error, or "never finishes" (for the abort signal), and
//     `signOut` returns it to signed out (#630).
//
// Exported from `@marinoscar/kvox-ai/copilot` so a host's tests and the eval
// parity suite can use it. It holds no token and makes no network call.
// =============================================================================

/**
 * The token counts a mock `assistant.usage` event reports.
 *
 * @stability experimental
 */
export interface CopilotMockUsage {
  /** Input tokens. */
  inputTokens?: number;
  /** Output tokens. */
  outputTokens?: number;
  /** Reasoning tokens. */
  reasoningTokens?: number;
  /** Input tokens read from the cache (the adapter's `cachedInputTokens`). */
  cacheReadTokens?: number;
}

/**
 * What the mock answers one `send` with.
 *
 * @stability experimental
 */
export type CopilotMockReply =
  | {
      /** A normal answer, streamed in chunks. */
      kind: 'answer';
      /** The whole answer text. */
      text: string;
      /** `assistant.usage.finishReason`. Default `stop`. */
      finishReason?: string;
      /** The usage to report. Default: 10 input tokens and one output token per chunk. */
      usage?: CopilotMockUsage;
      /** Characters per `assistant.message_delta`. Default 8. */
      chunkSize?: number;
      /** `assistant.usage.contentFilterTriggered`. */
      contentFilterTriggered?: boolean;
    }
  | {
      /** A `session.error`, then `session.idle`. */
      kind: 'sessionError';
      /** The error's category (`rate_limit`, `authentication`, ...). */
      errorType: string;
      /** The upstream HTTP status. */
      statusCode?: number;
      /** The upstream code. */
      errorCode?: string;
      /** The runtime's message. */
      message: string;
    }
  | {
      /** A `model.call_failure`; then the runtime's retry (when `thenRetrySucceeds`) or a `session.error`. */
      kind: 'callFailure';
      /** The upstream HTTP status. */
      statusCode: number;
      /** The runtime's message (`errorMessage`). */
      message: string;
      /** When true, the runtime retries (a second model request) and answers, unless aborted first. */
      thenRetrySucceeds?: boolean;
    }
  | {
      /** `send` rejects with `error`. */
      kind: 'throw';
      /** What `send` rejects with. */
      error: unknown;
    }
  | {
      /** `send` resolves and nothing is ever emitted. */
      kind: 'hang';
    }
  | {
      /** Exactly these events, in order (no `session.idle` is added). */
      kind: 'events';
      /** The events. */
      events: CopilotSessionEvent[];
    }
  | {
      /** An answer cut off at `length`, then the runtime's own "please continue" turn, unless aborted first. */
      kind: 'lengthThenContinue';
      /** The text of the cut-off answer. */
      text: string;
    }
  | {
      /**
       * The model calls tools: text (optional), an assistant message listing every call, the
       * usage, and the tool events; then each call's handler runs and the runtime waits. When all
       * return, the runtime calls the model again with the results (the next reply).
       */
      kind: 'toolCalls';
      /** Text the model says before it calls the tools. */
      text?: string;
      /** Characters per `assistant.message_delta` of that text. Default 8. */
      chunkSize?: number;
      /** The calls, in order. A name the session did not declare has no handler (a built-in tool). */
      calls: CopilotMockToolCall[];
      /** `parallel` (default) starts every handler at once; `sequential` starts the next one when the last has returned. */
      order?: 'parallel' | 'sequential';
      /** The usage to report. Default: 10 input tokens and one output token per chunk. */
      usage?: CopilotMockUsage;
      /** Leave out `assistant.usage` (a runtime that reports it late or never). */
      omitUsage?: boolean;
      /** Leave out `external_tool.requested` and `tool.execution_start` (default: emitted for every call). */
      omitToolEvents?: boolean;
    };

/**
 * One tool call a `toolCalls` reply makes.
 *
 * @stability experimental
 */
export interface CopilotMockToolCall {
  /** The tool's name. */
  name: string;
  /** The arguments the model produced. Default `{}`. */
  arguments?: unknown;
  /** The runtime's id of the call. Default `mock-call-<n>`. */
  toolCallId?: string;
  /** The id the HANDLER is invoked with, when a runtime's invocation id differs from the id it listed. */
  invokedAs?: string;
}

/**
 * One tool call a mock session ran: what the model asked and what the handler answered.
 *
 * @stability experimental
 */
export interface CopilotMockToolRun {
  /** The call's id. */
  toolCallId: string;
  /** The tool's name. */
  name: string;
  /** The arguments. */
  arguments: unknown;
  /** The handler's output, once it returned. */
  output?: string;
  /** The handler's error message, when it rejected. */
  error?: string;
  /** True when the session declared no such tool, so no handler ran. */
  undeclared?: boolean;
  /** The id the handler was invoked with, when it differs from `toolCallId`. */
  invokedAs?: string;
}

/**
 * One prompt a mock session received.
 *
 * @stability experimental
 */
export interface CopilotMockPrompt {
  /** The prompt as `send` received it. */
  prompt: string;
  /** The JSON Schema `send` received, when there was one. */
  responseSchema?: Record<string, unknown>;
  /** What would reach the model: the runtime's datetime-prefixed prompt after the session's hook. */
  sentPrompt: string;
}

/**
 * Everything the mock recorded about one session.
 *
 * @stability experimental
 */
export interface CopilotMockSession {
  /** The session id. */
  sessionId: string;
  /** The config the session was created with. */
  config: CopilotSessionConfig;
  /** Each `send`, in order. */
  prompts: CopilotMockPrompt[];
  /** Model requests the runtime made (a continuation or a retry counts as another). */
  modelRequests: number;
  /** Whether `abort()` was called. */
  aborted: boolean;
  /** Whether `disconnect()` was called. */
  disconnected: boolean;
  /** Whether `deleteSession` was called for it. */
  deleted: boolean;
  /** Every tool call the model made in this session, with the output its handler returned. */
  toolRuns: CopilotMockToolRun[];
  /** How many times the runtime called the model again after tool results. */
  continuations: number;
}

/**
 * What a test's `onSend` function receives.
 *
 * @stability experimental
 */
export interface CopilotMockSend {
  /** The prompt. */
  prompt: string;
  /** The JSON Schema, when there was one. */
  responseSchema?: Record<string, unknown>;
  /** The session's config. */
  config: CopilotSessionConfig;
  /** The zero-based index of this send across the transport. */
  index: number;
  /** True when this is the runtime's own next model call after tool results (`prompt` is then empty). */
  continuation?: boolean;
  /** The tool results the continuation carries, in call order. */
  toolResults?: CopilotMockToolResult[];
}

/**
 * One tool result a mock continuation carries.
 *
 * @stability experimental
 */
export interface CopilotMockToolResult {
  /** The call's id. */
  toolCallId: string;
  /** The tool's name. */
  name: string;
  /** What the session's handler returned. */
  output: string;
}

/**
 * How the mock's sign-in goes. Every field is optional.
 *
 * @stability experimental
 */
export interface CopilotMockSignInScript {
  /** What `startSignIn` answers. Default: a `device` challenge (code `ABCD-1234`, five minutes). */
  challenge?: CopilotSignInChallenge;
  /**
   * How `waitForSignIn` ends. `success` (default) signs the mock user in as `login`;
   * `expired` rejects as an expired sign-in; `cancelled` as a cancelled one; `pending`
   * never finishes by itself (an aborted signal cancels it).
   */
  outcome?: 'success' | 'expired' | 'cancelled' | 'pending';
  /** The login a successful sign-in reports. Default: the transport's login. */
  login?: string;
  /** `startSignIn` rejects with this. */
  startError?: unknown;
  /** `waitForSignIn` rejects with this (instead of the outcome). */
  waitError?: unknown;
}

/**
 * What the mock saw of the sign-in.
 *
 * @stability experimental
 */
export interface CopilotMockSignInCalls {
  /** `startSignIn` calls. */
  started: number;
  /** `waitForSignIn` calls. */
  waited: number;
  /** `signOut` calls. */
  signedOut: number;
  /** Waits cancelled through their abort signal. */
  aborted: number;
}

/**
 * The mock transport and its controls.
 *
 * @stability experimental
 */
export interface CopilotMockTransport extends CopilotTransport {
  /**
   * Every session so far, in creation order.
   *
   * @returns copies of the records.
   */
  sessions(): CopilotMockSession[];
  /**
   * Queues the reply of the next `send` that `onSend` does not answer.
   *
   * @param reply - the reply.
   */
  queue(reply: CopilotMockReply): void;
  /**
   * Answers each `send` from a function; returning `undefined` falls back to the
   * queue, then to the default answer.
   *
   * @param fn - the function, or `null` to remove it.
   */
  onSend(fn: ((send: CopilotMockSend) => CopilotMockReply | undefined) | null): void;
  /**
   * Signs the mock user in or out.
   *
   * @param signedIn - the new state.
   */
  setSignedIn(signedIn: boolean): void;
  /**
   * Scripts the sign-in: the challenge, and how the wait ends (replaces the previous script).
   *
   * @param script - the script.
   */
  scriptSignIn(script: CopilotMockSignInScript): void;
  /**
   * What the mock saw of the sign-in.
   *
   * @returns the counters.
   */
  signInCalls(): CopilotMockSignInCalls;
  /**
   * Emits an event on a session as the runtime would, at any moment (a held session that
   * goes idle by itself, a late event). Does nothing for a disconnected session.
   *
   * @param sessionId - the session.
   * @param event - the event.
   */
  emit(sessionId: string, event: CopilotSessionEvent): void;
  /**
   * Makes the next `createSession` reject with `error`.
   *
   * @param error - what it rejects with.
   */
  failNextCreate(error: unknown): void;
  /** Forgets the sessions, the queue, `onSend`, a pending create failure and the sign-in script and counters. */
  reset(): void;
}

/**
 * What {@link createCopilotMockTransport} is built from.
 *
 * @stability experimental
 */
export interface CopilotMockTransportOptions {
  /** Whether the mock user is signed in. Default `true`. */
  signedIn?: boolean;
  /** The login reported while signed in. Default `octocat`. */
  login?: string;
  /** The model listing. Default: `gpt-5-mini`, `gpt-4.1`, `claude-sonnet-4.5`, `claude-haiku-4.5`. */
  models?: CopilotModelInfo[];
  /** Tool names every session reports (the tripwire). Default: none. */
  liveTools?: string[];
  /**
   * Names the runtime has as built-in tools. Like the real runtime, a session that
   * declares a custom tool with one of these names and without `overridesBuiltInTool`
   * fails to be created. Default: none.
   */
  builtInTools?: string[];
  /** The working directory the transport reports. Default `/nonexistent/kvox-copilot-mock`. */
  workingDirectory?: string;
}

/** The runtime's datetime prefix the session hook must remove. */
const DATETIME_PREFIX = '<current_datetime>2026-01-01T00:00:00.000Z</current_datetime>\n\n';

/** The default listing. */
const DEFAULT_MODELS: CopilotModelInfo[] = [
  { id: 'gpt-5-mini', name: 'GPT-5 mini', capabilities: { limits: { max_prompt_tokens: 128_000, max_output_tokens: 64_000 } }, policy: { state: 'enabled' } },
  { id: 'gpt-4.1', name: 'GPT-4.1', capabilities: { limits: { max_prompt_tokens: 128_000, max_output_tokens: 16_384 } }, policy: { state: 'enabled' } },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', capabilities: { limits: { max_prompt_tokens: 128_000, max_output_tokens: 16_000 } }, policy: { state: 'enabled' } },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', capabilities: { limits: { max_prompt_tokens: 128_000, max_output_tokens: 16_000 } }, policy: { state: 'enabled' } },
];

/**
 * Builds the mock transport.
 *
 * @example
 * ```ts
 * const transport = createCopilotMockTransport();
 * transport.queue({ kind: 'answer', text: '{"title":"Hello"}' });
 * const copilot = createCopilotAdapter({ optIn: true, transport });
 * await copilot.responses.create({ model: 'gpt-5-mini', input: 'Hi' }, { apiKey: AI_KEYLESS_API_KEY, requestId: 'r1' });
 * transport.sessions()[0].deleted; // true
 * ```
 *
 * @param options - sign-in, models, live tools and the working directory.
 * @returns the transport and its controls.
 * @stability experimental
 */
export function createCopilotMockTransport(options: CopilotMockTransportOptions = {}): CopilotMockTransport {
  let signedIn = options.signedIn ?? true;
  let login = options.login ?? 'octocat';
  const initialLogin = login;
  let script: CopilotMockSignInScript = {};
  let flowStarted = false;
  let calls: CopilotMockSignInCalls = { started: 0, waited: 0, signedOut: 0, aborted: 0 };
  const models = options.models ?? DEFAULT_MODELS;
  const liveTools = options.liveTools ?? [];
  const builtInTools = new Set(options.builtInTools ?? []);
  let records: CopilotMockSession[] = [];
  let replies: CopilotMockReply[] = [];
  let answerer: ((send: CopilotMockSend) => CopilotMockReply | undefined) | null = null;
  let createError: { error: unknown } | null = null;
  let sends = 0;
  let sessionCount = 0;
  const emitters = new Map<string, (event: CopilotSessionEvent) => void>();

  const createSession = (config: CopilotSessionConfig): CopilotSessionHandle => {
    sessionCount += 1;
    const record: CopilotMockSession = {
      sessionId: `mock-session-${sessionCount}`,
      config,
      prompts: [],
      modelRequests: 0,
      aborted: false,
      disconnected: false,
      deleted: false,
      toolRuns: [],
      continuations: 0,
    };
    records.push(record);
    const lifetime = new AbortController();
    const handlers = new Set<(event: CopilotSessionEvent) => void>();
    let stopped = false;
    emitters.set(record.sessionId, (event) => {
      for (const handler of [...handlers]) handler(event);
    });

    const emit = (event: CopilotSessionEvent): void => {
      for (const handler of [...handlers]) handler(event);
    };
    /** Runs the steps one `setImmediate` apart, until the session is aborted. */
    const play = (steps: Array<() => void>): void => {
      const next = (i: number): void => {
        if (i >= steps.length || stopped) return;
        setImmediate(() => {
          if (stopped) return;
          steps[i]();
          next(i + 1);
        });
      };
      next(0);
    };

    const answerSteps = (reply: {
      text: string;
      finishReason?: string;
      usage?: CopilotMockUsage;
      chunkSize?: number;
      contentFilterTriggered?: boolean;
      idle?: boolean;
    }): Array<() => void> => {
      const size = Math.max(1, reply.chunkSize ?? 8);
      const chunks: string[] = [];
      for (let i = 0; i < reply.text.length; i += size) chunks.push(reply.text.slice(i, i + size));
      const messageId = `msg-${record.prompts.length}-${record.modelRequests}`;
      const steps: Array<() => void> = [() => (record.modelRequests += 1)];
      for (const chunk of chunks) {
        steps.push(() => emit({ type: 'assistant.message_delta', data: { deltaContent: chunk, messageId } }));
      }
      steps.push(() => emit({ type: 'assistant.message', data: { content: reply.text, messageId } }));
      steps.push(() =>
        emit({
          type: 'assistant.usage',
          data: {
            model: config.model,
            inputTokens: reply.usage?.inputTokens ?? 10,
            outputTokens: reply.usage?.outputTokens ?? Math.max(1, chunks.length),
            ...(reply.usage?.reasoningTokens !== undefined ? { reasoningTokens: reply.usage.reasoningTokens } : {}),
            ...(reply.usage?.cacheReadTokens !== undefined ? { cacheReadTokens: reply.usage.cacheReadTokens } : {}),
            finishReason: reply.finishReason ?? 'stop',
            ...(reply.contentFilterTriggered !== undefined ? { contentFilterTriggered: reply.contentFilterTriggered } : {}),
          },
        }),
      );
      if (reply.idle !== false) steps.push(() => emit({ type: 'session.idle', data: {} }));
      return steps;
    };

    const stepsFor = (reply: CopilotMockReply): Array<() => void> => {
      switch (reply.kind) {
        case 'answer':
          return answerSteps(reply);
        case 'sessionError':
          return [
            () => (record.modelRequests += 1),
            () =>
              emit({
                type: 'session.error',
                data: {
                  errorType: reply.errorType,
                  message: reply.message,
                  ...(reply.statusCode !== undefined ? { statusCode: reply.statusCode } : {}),
                  ...(reply.errorCode !== undefined ? { errorCode: reply.errorCode } : {}),
                },
              }),
            () => emit({ type: 'session.idle', data: {} }),
          ];
        case 'callFailure':
          return [
            () => (record.modelRequests += 1),
            () =>
              emit({
                type: 'model.call_failure',
                data: { source: 'top_level', statusCode: reply.statusCode, errorMessage: reply.message, failureKind: 'api' },
              }),
            ...(reply.thenRetrySucceeds === true
              ? answerSteps({ text: 'The retried answer.' })
              : [
                  () =>
                    emit({
                      type: 'session.error',
                      data: { errorType: 'query', statusCode: reply.statusCode, message: reply.message },
                    }),
                  () => emit({ type: 'session.idle', data: {} }),
                ]),
          ];
        case 'lengthThenContinue':
          return [
            ...answerSteps({ text: reply.text, finishReason: 'length', idle: false }),
            // The runtime's own "please continue" turn.
            ...answerSteps({ text: ' ...continued.' }),
          ];
        case 'events':
          return reply.events.map((event) => () => emit(event));
        case 'toolCalls':
          return toolSteps(reply);
        default:
          return [];
      }
    };

    /** What the runtime does when the model calls tools (see the header). */
    const toolSteps = (reply: Extract<CopilotMockReply, { kind: 'toolCalls' }>): Array<() => void> => {
      const base = record.modelRequests + 1;
      const calls = reply.calls.map((call, i) => ({
        toolCallId: call.toolCallId ?? `mock-call-${base}-${i + 1}`,
        name: call.name,
        arguments: call.arguments ?? {},
        ...(call.invokedAs !== undefined ? { invokedAs: call.invokedAs } : {}),
      }));
      const text = reply.text ?? '';
      const messageId = `msg-${record.prompts.length}-${record.modelRequests}`;
      const steps: Array<() => void> = [() => (record.modelRequests += 1)];
      const size = Math.max(1, reply.chunkSize ?? 8);
      for (let i = 0; i < text.length; i += size) {
        const chunk = text.slice(i, i + size);
        steps.push(() => emit({ type: 'assistant.message_delta', data: { deltaContent: chunk, messageId } }));
      }
      steps.push(() =>
        emit({
          type: 'assistant.message',
          data: {
            content: text,
            messageId,
            toolRequests: calls.map((call) => ({ toolCallId: call.toolCallId, name: call.name, arguments: call.arguments, type: 'function' })),
          },
        }),
      );
      if (reply.omitUsage !== true) {
        steps.push(() =>
          emit({
            type: 'assistant.usage',
            data: {
              model: config.model,
              inputTokens: reply.usage?.inputTokens ?? 10,
              outputTokens: reply.usage?.outputTokens ?? 1,
              ...(reply.usage?.reasoningTokens !== undefined ? { reasoningTokens: reply.usage.reasoningTokens } : {}),
              ...(reply.usage?.cacheReadTokens !== undefined ? { cacheReadTokens: reply.usage.cacheReadTokens } : {}),
              finishReason: 'tool_calls',
            },
          }),
        );
      }
      if (reply.omitToolEvents !== true) {
        for (const call of calls) {
          steps.push(() =>
            emit({
              type: 'external_tool.requested',
              data: { requestId: `req-${call.toolCallId}`, toolCallId: call.toolCallId, toolName: call.name, arguments: call.arguments },
            }),
          );
          steps.push(() =>
            emit({ type: 'tool.execution_start', data: { toolCallId: call.toolCallId, toolName: call.name, arguments: call.arguments } }),
          );
        }
      }
      steps.push(() => void runTools(calls, reply.order ?? 'parallel'));
      return steps;
    };

    /** Runs the session's tool handlers, then (if nobody aborted) calls the model again with the results. */
    const runTools = async (
      calls: Array<{ toolCallId: string; name: string; arguments: unknown; invokedAs?: string }>,
      order: 'parallel' | 'sequential',
    ): Promise<void> => {
      const runs = calls.map((call): CopilotMockToolRun => {
        const run: CopilotMockToolRun = {
          toolCallId: call.toolCallId,
          name: call.name,
          arguments: call.arguments,
          ...(call.invokedAs !== undefined ? { invokedAs: call.invokedAs } : {}),
        };
        record.toolRuns.push(run);
        return run;
      });
      const runOne = async (run: CopilotMockToolRun): Promise<void> => {
        const tool = config.tools?.find((candidate) => candidate.name === run.name);
        if (tool === undefined) {
          run.undeclared = true;
          return;
        }
        try {
          run.output = await tool.handler(run.arguments, {
            toolCallId: run.invokedAs ?? run.toolCallId,
            toolName: run.name,
            signal: lifetime.signal,
          });
          if (!stopped) emit({ type: 'tool.execution_complete', data: { toolCallId: run.toolCallId, success: true } });
        } catch (err) {
          run.error = err instanceof Error ? err.message : String(err);
        }
      };
      if (order === 'sequential') {
        for (const run of runs) {
          if (stopped) return;
          await runOne(run);
        }
      } else {
        await Promise.all(runs.map(runOne));
      }
      // A declared tool that never answered (an undeclared one has no handler) keeps the turn waiting.
      if (stopped || runs.some((run) => run.undeclared === true)) return;
      record.continuations += 1;
      const results = runs.map((run) => ({ toolCallId: run.toolCallId, name: run.name, output: run.output ?? '' }));
      const index = sends++;
      const reply =
        answerer?.({ prompt: '', config, index, continuation: true, toolResults: results }) ??
        replies.shift() ?? { kind: 'answer', text: 'Hello from the Copilot mock.' };
      if (reply.kind === 'throw') {
        emit({ type: 'session.error', data: { errorType: 'query', message: reply.error instanceof Error ? reply.error.message : String(reply.error) } });
        emit({ type: 'session.idle', data: {} });
      } else if (reply.kind !== 'hang') {
        play(stepsFor(reply));
      }
    };

    return {
      sessionId: record.sessionId,
      on(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async send(sendOptions) {
        const index = sends++;
        const transformed = `${DATETIME_PREFIX}${sendOptions.prompt}`;
        const hooked = config.hooks?.onUserPromptTransformed?.({ prompt: sendOptions.prompt, transformedPrompt: transformed });
        record.prompts.push({
          prompt: sendOptions.prompt,
          ...(sendOptions.responseSchema !== undefined ? { responseSchema: sendOptions.responseSchema } : {}),
          sentPrompt: hooked?.modifiedTransformedPrompt ?? transformed,
        });
        const reply =
          answerer?.({
            prompt: sendOptions.prompt,
            ...(sendOptions.responseSchema !== undefined ? { responseSchema: sendOptions.responseSchema } : {}),
            config,
            index,
          }) ??
          replies.shift() ?? { kind: 'answer', text: 'Hello from the Copilot mock.' };
        if (reply.kind === 'throw') throw reply.error;
        if (reply.kind !== 'hang') play(stepsFor(reply));
        return `mock-message-${index}`;
      },
      async abort() {
        record.aborted = true;
        lifetime.abort();
        if (stopped) return;
        stopped = true;
        setImmediate(() => emit({ type: 'session.idle', data: { aborted: true } }));
      },
      async disconnect() {
        record.disconnected = true;
        stopped = true;
        lifetime.abort();
        handlers.clear();
      },
      async currentToolNames() {
        return [...liveTools, ...(config.tools ?? []).map((tool) => tool.name)];
      },
    };
  };

  return {
    workingDirectory: options.workingDirectory ?? '/nonexistent/kvox-copilot-mock',
    async getAuthStatus(): Promise<CopilotAuthStatus> {
      return signedIn ? { isAuthenticated: true, login, authType: 'user' } : { isAuthenticated: false };
    },
    async listModels() {
      return models.map((model) => ({ ...model }));
    },
    async createSession(config) {
      if (createError !== null) {
        const { error } = createError;
        createError = null;
        throw error;
      }
      const clash = (config.tools ?? []).find((tool) => builtInTools.has(tool.name) && tool.overridesBuiltInTool !== true);
      if (clash !== undefined) {
        throw new Error(`Tool name "${clash.name}" clashes with a built-in tool; set overridesBuiltInTool to replace it.`);
      }
      return createSession(config);
    },
    async deleteSession(sessionId) {
      const record = records.find((entry) => entry.sessionId === sessionId);
      if (record === undefined) throw new Error(`No session ${sessionId}.`);
      record.deleted = true;
    },
    async startSignIn() {
      calls.started += 1;
      if (script.startError !== undefined) throw script.startError;
      flowStarted = true;
      return script.challenge ?? { kind: 'device', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 300_000).toISOString() };
    },
    async waitForSignIn(signal) {
      calls.waited += 1;
      if (!flowStarted) throw copilotSignInFailed('sign_in_not_started', 'No GitHub Copilot sign-in is in progress. Start one first.');
      if (signal?.aborted === true) {
        flowStarted = false;
        calls.aborted += 1;
        throw copilotSignInCancelled();
      }
      const outcome = script.outcome ?? 'success';
      // Asynchronous, as the real flow is: the user finishes in a browser.
      if (outcome === 'pending' && script.waitError === undefined) {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              flowStarted = false;
              calls.aborted += 1;
              reject(copilotSignInCancelled());
            },
            { once: true },
          );
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      flowStarted = false;
      if (script.waitError !== undefined) throw script.waitError;
      if (outcome === 'expired') throw copilotSignInExpired();
      if (outcome === 'cancelled') throw copilotSignInCancelled();
      signedIn = true;
      login = script.login ?? initialLogin;
      return { isAuthenticated: true, login, authType: 'user' };
    },
    async signOut() {
      calls.signedOut += 1;
      flowStarted = false;
      signedIn = false;
    },
    scriptSignIn(next) {
      script = { ...next };
    },
    signInCalls: () => ({ ...calls }),
    sessions: () =>
      records.map((record) => ({
        ...record,
        prompts: record.prompts.map((p) => ({ ...p })),
        toolRuns: record.toolRuns.map((run) => ({ ...run })),
      })),
    queue(reply) {
      replies.push(reply);
    },
    onSend(fn) {
      answerer = fn;
    },
    setSignedIn(value) {
      signedIn = value;
    },
    emit(sessionId, event) {
      emitters.get(sessionId)?.(event);
    },
    failNextCreate(error) {
      createError = { error };
    },
    reset() {
      emitters.clear();
      records = [];
      replies = [];
      answerer = null;
      createError = null;
      script = {};
      flowStarted = false;
      calls = { started: 0, waited: 0, signedOut: 0, aborted: 0 };
    },
  };
}
