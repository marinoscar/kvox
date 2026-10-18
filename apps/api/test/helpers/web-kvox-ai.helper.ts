import type { AiResponse, AiStreamEvent } from '@marinoscar/platform-api/ai';
import type { KvoxAiModelState } from '@marinoscar/kvox-ai';
import type { KvoxAiPort } from '@marinoscar/kvox-api/ports';

import { PlatformAiRuntime } from '../../src/ai-port/platform-ai-runtime';
import { createWebKvoxAi } from '../../src/platform-kvox/ai/web-kvox-ai';

// =============================================================================
// Test helper: the REAL web KVOX_AI binding over a scripted platform AiService (#579)
// =============================================================================
//
// `createWebKvoxAi` (the binding `platform-kvox.module.ts` uses: `createKvoxAi` of
// `@marinoscar/kvox-ai` over the real `PlatformAiRuntime`) with the one thing a unit
// tier cannot have faked: `AiService.forUser(...)`. Its client answers a working
// model by default (a streamed `Hello`, a structured `{ ok: true }`, 1536-wide
// vectors), records every scope and request, can be scripted per stream call, and
// can be ARMED to fail its next call with any value, as the platform (or the target
// resolver under it) would throw it.
// =============================================================================

const RESPONSE: AiResponse = {
  id: 'resp-1',
  provider: 'openai',
  model: 'gpt-4o',
  output: [],
  outputText: 'Hello',
  usage: { inputTokens: 5, outputTokens: 1 },
  finishReason: 'stop',
};

/** A configured deployment: AI on, the `openai` slot on, `gpt-4o` enabled with every capability. */
export function webModelState(overrides: Partial<KvoxAiModelState['policy']> = {}): KvoxAiModelState {
  return {
    provider: 'openai',
    models: [{ id: 'gpt-4o', label: 'gpt-4o', structuredOutput: true, toolCalling: true, contextWindow: 128_000, maxOutputTokens: 16_384 }],
    policy: {
      enabled: true,
      provider: 'openai',
      defaultModel: 'gpt-4o',
      graphEnabled: true,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
      ...overrides,
    },
  };
}

export interface WebAiUnderTest {
  /** The bound port. */
  port: KvoxAiPort;
  /** The real runtime under it. */
  runtime: PlatformAiRuntime;
  /** `AiService.forUser`, recorded. */
  forUser: jest.Mock;
  /** The client `forUser` hands out. */
  client: { stream: jest.Mock; respond: jest.Mock; embed: jest.Mock };
  /** The existence check of `user_ai_keys`. */
  findUnique: jest.Mock;
  /** Makes the NEXT client call (stream, respond or embed) fail with `error`. */
  arm(error: unknown): void;
  /** Makes the NEXT client call (stream, respond or embed) never answer until its signal aborts. */
  hang(): void;
  /** Queues the events of the next stream call (one array per call). */
  script(events: AiStreamEvent[]): void;
  /** The value the next structured answer parses to. */
  structured: { value: unknown; finishReason?: 'stop' | 'length' | 'content_filter' };
}

/** The real web binding over a scripted `AiService`. */
export function createWebAiUnderTest(options: { state?: KvoxAiModelState; hasKey?: boolean; timeoutMs?: number } = {}): WebAiUnderTest {
  let armed: { error: unknown } | { hang: true } | null = null;
  const take = (): { error: unknown } | { hang: true } | null => {
    const next = armed;
    armed = null;
    return next;
  };
  /** Settles only when the platform call's signal aborts, with the signal's reason, as an adapter does. */
  const hangUntilAborted = (signal: AbortSignal | undefined): Promise<never> =>
    new Promise((_resolve, reject) => {
      if (signal === undefined) return;
      const fail = (): void => reject(signal.reason);
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
  const scripts: AiStreamEvent[][] = [];
  const structured: WebAiUnderTest['structured'] = { value: { ok: true } as unknown };

  const client = {
    stream: jest.fn((_req: unknown, opts?: { signal?: AbortSignal }) => {
      const failure = take();
      const events = scripts.shift() ?? [
        { type: 'output_text.delta', delta: 'Hello' },
        { type: 'response.completed', response: RESPONSE },
      ];
      return (async function* () {
        if (failure !== null && 'hang' in failure) await hangUntilAborted(opts?.signal);
        if (failure !== null && 'error' in failure) throw failure.error;
        for (const event of events) yield event;
      })();
    }),
    respond: jest.fn(async (_req: unknown, opts?: { signal?: AbortSignal }) => {
      const failure = take();
      if (failure !== null && 'hang' in failure) await hangUntilAborted(opts?.signal);
      if (failure !== null && 'error' in failure) throw failure.error;
      return { ...RESPONSE, parsed: structured.value, finishReason: structured.finishReason ?? RESPONSE.finishReason };
    }),
    embed: jest.fn(async (req: { input: string[]; model: string }, opts?: { signal?: AbortSignal }) => {
      const failure = take();
      if (failure !== null && 'hang' in failure) await hangUntilAborted(opts?.signal);
      if (failure !== null && 'error' in failure) throw failure.error;
      return {
        provider: 'openai',
        model: req.model,
        vectors: req.input.map(() => Array.from({ length: 1536 }, () => 0.01)),
        dimensions: 1536,
        usage: { inputTokens: 2 },
      };
    }),
  };
  const forUser = jest.fn(() => client);
  const findUnique = jest.fn(async () => (options.hasKey === false ? null : { id: 'key-1' }));
  const runtime = new PlatformAiRuntime({ forUser } as never, { userAiKey: { findUnique } } as never);
  const state = options.state ?? webModelState();

  const port = createWebKvoxAi({
    runtime,
    taskModels: { load: async () => state },
    settings: {
      requestTimeoutMs: async () => options.timeoutMs ?? 600_000,
      graphEnabled: async () => state.policy.graphEnabled,
    },
    logger: { warn: () => undefined },
  });

  return {
    port,
    runtime,
    forUser,
    client,
    findUnique,
    arm: (error) => {
      armed = { error };
    },
    hang: () => {
      armed = { hang: true };
    },
    script: (events) => {
      scripts.push(events);
    },
    structured,
  };
}
