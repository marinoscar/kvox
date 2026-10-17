import type { AiResponse, AiStreamEvent } from '@marinoscar/platform-api/ai';

import { EMBEDDING_DIMENSIONS } from '../embedding/index.js';
import type {
  KvoxAiKeyReadiness,
  KvoxAiRuntime,
  KvoxAiRuntimeCall,
  KvoxAiRuntimeEmbedRequest,
  KvoxAiRuntimeEmbedResult,
  KvoxAiRuntimeRequest,
} from '../runtime/index.js';
import { SCRIPTED_RESPONSE, textAnswer } from './scripted-events.js';

// =============================================================================
// createScriptedRuntime: a KvoxAiRuntime that replays what a provider would say
// =============================================================================
//
// A runtime is ONE provider round trip (`stream`, `create`, `embed`) plus "is
// there a key?". This one answers each round trip from a queue of scripted
// steps, in order, and records every round trip it was asked for. When a queue is
// empty it answers a working default (a streamed `Hello`, a structured `{ ok: true }`,
// 1536-wide vectors), so a test scripts only the call it is about.
//
// A step is an answer, a failure (any thrown value: a platform `AiError`, a plain
// `Error`, a `KvoxAiError`), or a HANG: the round trip never answers and settles
// only when the call's signal aborts, throwing the signal's reason as a real
// provider adapter does. A hang is how a test proves the request timeout.
//
// ⚠ A KEY NEVER APPEARS HERE. A record holds the call (user, feature, provider,
// model, signal) and the request, which carry no key by construction; there is
// nowhere for a key to go.
// =============================================================================

/**
 * One scripted streamed round trip.
 *
 * @stability experimental
 */
export type ScriptedStreamStep =
  | {
      /** The events, in order. */
      events: AiStreamEvent[];
      /** Thrown after the last event (a stream that breaks). */
      thenFail?: unknown;
    }
  | {
      /** Throws before any event. */
      fail: unknown;
    }
  | {
      /** Never answers; settles when the call's signal aborts. */
      hang: true;
    };

/**
 * A complete response to script: any field of the provider's response, over the defaults.
 *
 * @stability experimental
 */
export type ScriptedResponse = Partial<AiResponse> & {
  /** The structured answer a structured call reads (the adapter's parse of the JSON). */
  parsed?: unknown;
};

/**
 * One scripted complete round trip (also the structured-output call).
 *
 * @stability experimental
 */
export type ScriptedCreateStep =
  | {
      /** The response; its `parsed` is what a structured call reads. */
      response: ScriptedResponse;
    }
  | {
      /** Throws. */
      fail: unknown;
    }
  | {
      /** Never answers; settles when the call's signal aborts. */
      hang: true;
    };

/**
 * One scripted embeddings round trip.
 *
 * @stability experimental
 */
export type ScriptedEmbedStep =
  | {
      /** The vectors; absent: one zero-ish vector of the catalog width per input. */
      vectors?: number[][];
    }
  | {
      /** Throws. */
      fail: unknown;
    }
  | {
      /** Never answers; settles when the call's signal aborts. */
      hang: true;
    };

/**
 * What a scripted runtime starts with.
 *
 * @stability experimental
 */
export interface ScriptedRuntimeScript {
  /** Streamed round trips, consumed in order. */
  streams?: ScriptedStreamStep[];
  /** Complete round trips, consumed in order. */
  creates?: ScriptedCreateStep[];
  /** Embeddings round trips, consumed in order. */
  embeds?: ScriptedEmbedStep[];
  /** Whether a key exists for every user and provider. Default `true`. */
  hasKey?: boolean;
  /** What a streamed round trip answers once its queue is empty. Default: a streamed `Hello`. */
  defaultStream?: AiStreamEvent[];
  /** `false` leaves `embed` off the runtime, as a host with no embeddings model does. Default `true`. */
  embeddings?: boolean;
}

/**
 * One round trip a scripted runtime was asked for.
 *
 * @stability experimental
 */
export interface ScriptedRuntimeRecord {
  /** Which method. */
  kind: 'stream' | 'create' | 'embed';
  /** Who it was for and where it went (never a key). */
  call: KvoxAiRuntimeCall;
  /** The request as the runtime received it. */
  request: KvoxAiRuntimeRequest | KvoxAiRuntimeEmbedRequest;
}

/**
 * One readiness question a scripted runtime was asked.
 *
 * @stability experimental
 */
export interface ScriptedReadinessRecord extends Pick<KvoxAiRuntimeCall, 'userId' | 'feature'> {
  /** The provider asked about. */
  provider: string;
}

/**
 * A runtime with a script to queue onto and a record of what it was asked.
 *
 * @stability experimental
 */
export interface ScriptedRuntime extends KvoxAiRuntime {
  /** Every round trip so far, in order (including readiness-free calls only). */
  readonly calls: ScriptedRuntimeRecord[];
  /** Every readiness question so far. */
  readonly readinessCalls: ScriptedReadinessRecord[];
  /** Queues the next streamed round trip. */
  queueStream(step: ScriptedStreamStep): void;
  /** Queues the next complete round trip. */
  queueCreate(step: ScriptedCreateStep): void;
  /** Queues the next embeddings round trip. */
  queueEmbed(step: ScriptedEmbedStep): void;
  /** Makes the NEXT round trip, of whichever kind comes first, throw `error` (ahead of the queues). */
  failNext(error: unknown): void;
  /** Makes the NEXT round trip, of whichever kind comes first, hang until its signal aborts. */
  hangNext(): void;
  /** Sets whether a key exists. */
  setKey(hasKey: boolean): void;
  /** Drops every queued step and record. */
  reset(): void;
}

/** Waits until the call's signal aborts, then throws its reason (a TimeoutError or AbortError). */
function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return; // nothing can ever end it: a script bug the test's own timeout reports
    const fail = (): void => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * Builds a runtime that replays a script.
 *
 * @example
 * ```ts
 * const runtime = createScriptedRuntime();
 * runtime.queueStream({ events: textAnswer('Hi') });
 * runtime.queueCreate({ fail: new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1500 }) });
 * const port = createKvoxAi({ runtime, taskModels });
 * ```
 *
 * @param script - the steps to start with (more can be queued later).
 * @returns the runtime.
 * @stability experimental
 */
export function createScriptedRuntime(script: ScriptedRuntimeScript = {}): ScriptedRuntime {
  const streams: ScriptedStreamStep[] = [...(script.streams ?? [])];
  const creates: ScriptedCreateStep[] = [...(script.creates ?? [])];
  const embeds: ScriptedEmbedStep[] = [...(script.embeds ?? [])];
  const calls: ScriptedRuntimeRecord[] = [];
  const readinessCalls: ScriptedReadinessRecord[] = [];
  let hasKey = script.hasKey !== false;
  let armed: { fail: unknown } | { hang: true } | null = null;

  /** The armed one-shot, consumed by the first round trip that asks. */
  const takeArmed = (): { fail: unknown } | { hang: true } | null => {
    const next = armed;
    armed = null;
    return next;
  };

  const runtime: ScriptedRuntime = {
    calls,
    readinessCalls,

    async *stream(call, req): AsyncIterable<AiStreamEvent> {
      calls.push({ kind: 'stream', call, request: req });
      const step: ScriptedStreamStep = takeArmed() ?? streams.shift() ?? { events: script.defaultStream ?? textAnswer('Hello') };
      if ('hang' in step) await hang(call.signal);
      if ('fail' in step) throw step.fail;
      if ('events' in step) {
        for (const event of step.events) yield event;
        if (step.thenFail !== undefined) throw step.thenFail;
      }
    },

    async create(call, req): Promise<AiResponse> {
      calls.push({ kind: 'create', call, request: req });
      const step: ScriptedCreateStep = takeArmed() ?? creates.shift() ?? { response: { parsed: { ok: true }, outputText: '{"ok":true}' } };
      if ('hang' in step) return hang(call.signal);
      if ('fail' in step) throw step.fail;
      return { ...SCRIPTED_RESPONSE, ...step.response } as AiResponse;
    },

    async readiness(call): Promise<KvoxAiKeyReadiness> {
      readinessCalls.push(call);
      return { hasKey };
    },

    queueStream: (step) => void streams.push(step),
    queueCreate: (step) => void creates.push(step),
    queueEmbed: (step) => void embeds.push(step),
    failNext: (error) => {
      armed = { fail: error };
    },
    hangNext: () => {
      armed = { hang: true };
    },
    setKey: (value) => {
      hasKey = value;
    },
    reset: () => {
      streams.length = 0;
      creates.length = 0;
      embeds.length = 0;
      calls.length = 0;
      readinessCalls.length = 0;
      armed = null;
    },
  };

  if (script.embeddings !== false) {
    runtime.embed = async (call: KvoxAiRuntimeCall, req: KvoxAiRuntimeEmbedRequest): Promise<KvoxAiRuntimeEmbedResult> => {
      calls.push({ kind: 'embed', call, request: req });
      const step: ScriptedEmbedStep = takeArmed() ?? embeds.shift() ?? {};
      if ('hang' in step) return hang(call.signal);
      if ('fail' in step) throw step.fail;
      return {
        vectors: step.vectors ?? req.input.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01)),
        inputTokens: 2,
        model: call.model ?? 'scripted-embedding',
      };
    };
  }

  return runtime;
}
