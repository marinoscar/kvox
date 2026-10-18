import type {
  CopilotAuthStatus,
  CopilotModelInfo,
  CopilotSessionConfig,
  CopilotSessionEvent,
  CopilotSessionHandle,
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
//   • `liveTools` makes the session report tools (the tripwire test);
//   • it records every session's config, prompts and cleanup.
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
    };

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
   * Makes the next `createSession` reject with `error`.
   *
   * @param error - what it rejects with.
   */
  failNextCreate(error: unknown): void;
  /** Forgets the sessions, the queue, `onSend` and a pending create failure. */
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
  const login = options.login ?? 'octocat';
  const models = options.models ?? DEFAULT_MODELS;
  const liveTools = options.liveTools ?? [];
  let records: CopilotMockSession[] = [];
  let replies: CopilotMockReply[] = [];
  let answerer: ((send: CopilotMockSend) => CopilotMockReply | undefined) | null = null;
  let createError: { error: unknown } | null = null;
  let sends = 0;
  let sessionCount = 0;

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
    };
    records.push(record);
    const handlers = new Set<(event: CopilotSessionEvent) => void>();
    let stopped = false;

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
        default:
          return [];
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
        if (stopped) return;
        stopped = true;
        setImmediate(() => emit({ type: 'session.idle', data: { aborted: true } }));
      },
      async disconnect() {
        record.disconnected = true;
        stopped = true;
        handlers.clear();
      },
      async currentToolNames() {
        return [...liveTools];
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
      return createSession(config);
    },
    async deleteSession(sessionId) {
      const record = records.find((entry) => entry.sessionId === sessionId);
      if (record === undefined) throw new Error(`No session ${sessionId}.`);
      record.deleted = true;
    },
    sessions: () => records.map((record) => ({ ...record, prompts: record.prompts.map((p) => ({ ...p })) })),
    queue(reply) {
      replies.push(reply);
    },
    onSend(fn) {
      answerer = fn;
    },
    setSignedIn(value) {
      signedIn = value;
    },
    failNextCreate(error) {
      createError = { error };
    },
    reset() {
      records = [];
      replies = [];
      answerer = null;
      createError = null;
    },
  };
}
