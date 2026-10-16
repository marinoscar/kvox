import type { z } from 'zod';

import { AiInputError, AiStructuredOutputError } from '../ai-errors';
import { countTokens } from '../count-tokens';
import { EMBEDDING_DIMENSIONS, KVOX_EMBEDDING } from '../embedding-catalog';
import type { KvoxAiFeatureId } from '../features';
import type {
  JsonSchema,
  KvoxAi,
  KvoxAiCallBase,
  KvoxAiReadiness,
  KvoxChatEvent,
  KvoxChatRequest,
  KvoxEmbeddingCapability,
  KvoxTextEvent,
  KvoxUsage,
} from '../kvox-ai';
import type { KvoxAiReason } from '../kvox-ai-errors';

// =============================================================================
// FakeKvoxAi: a controllable test double for the `KvoxAi` port (issue #475)
// =============================================================================
//
// Every handler and service spec that used to mock the retired provider registry,
// the task-model resolver and the credentials service mocks THIS instead:
//
//   const ai = new FakeKvoxAi();
//   ai.queueStream(['Hello ', 'world']);
//   ai.queueStructured({ entities: [] });
//   ai.setReadiness({ ok: false, reason: 'ai_key_missing', hasKey: false });
//   { provide: KVOX_AI, useValue: ai }
//
// It implements the same contract as the real adapter on the points a caller can
// observe: an empty or oversized embedding batch is refused locally, a vector is
// always 1536 wide, a structured value is re-validated with the caller's Zod
// schema, and an absent usage is `null` rather than `0`.
//
// WHAT IT RECORDS. Every call lands in `calls`, with the feature, user, org, job id
// and the whole request, so a spec can assert "the extract handler called
// `generateStructured` for `graph_extract` under job J" without a spy.
//
// SCRIPTING MODEL. Each of `streamText`, `generateStructured`, `embed` and `chat` has
// a FIFO queue of replies. A call takes the next queued reply; when the queue is
// empty it falls back to the method's default handler (`setStreamHandler`,
// `setStructuredHandler`, `setEmbedHandler`, `setChatHandler`). A structured call
// with neither throws, so a spec never passes by silently receiving an invented
// answer.
// =============================================================================

export type FakeKvoxAiMethod =
  | 'readiness'
  | 'streamText'
  | 'generateStructured'
  | 'embed'
  | 'chat';

/** One recorded call. `request` is the whole object the caller passed. */
export interface FakeKvoxAiCall {
  method: FakeKvoxAiMethod;
  userId: string;
  feature: KvoxAiFeatureId;
  orgId?: string;
  jobId?: string;
  model?: string | null;
  request: unknown;
}

const NO_USAGE: KvoxUsage = { inputTokens: null, outputTokens: null };

// ---------------------------------------------------------------------------
// Scripted replies
// ---------------------------------------------------------------------------

/** What a scripted stream does. */
export interface FakeStreamScript {
  deltas: string[];
  finishReason?: 'stop' | 'length';
  usage?: KvoxUsage;
  model?: string;
  /** Throw this after the deltas (a connection that dies mid-answer); no `done` event follows. */
  failAfter?: unknown;
}

type StreamReply =
  | { kind: 'script'; script: FakeStreamScript }
  | { kind: 'throw'; error: unknown }
  | { kind: 'fn'; fn: (req: StreamRequest) => FakeStreamScript };

type StreamRequest = KvoxAiCallBase & { system: string; user: string; maxOutputTokens?: number };

/** What a scripted structured answer returns. */
export interface FakeStructuredScript {
  value: unknown;
  usage?: KvoxUsage;
  model?: string;
}

type StructuredRequest = KvoxAiCallBase & {
  system: string;
  user: string;
  schemaName: string;
  schema: z.ZodType<unknown>;
  jsonSchema?: JsonSchema;
  maxOutputTokens?: number;
};

type StructuredReply =
  | { kind: 'script'; script: FakeStructuredScript }
  | { kind: 'throw'; error: unknown }
  | { kind: 'fn'; fn: (req: StructuredRequest) => FakeStructuredScript | unknown };

interface FakeEmbedScript {
  vectors: number[][];
  promptTokens?: number | null;
  model?: string;
}

type EmbedRequest = KvoxAiCallBase & { texts: string[] };

type EmbedReply =
  | { kind: 'script'; script: FakeEmbedScript }
  | { kind: 'throw'; error: unknown }
  | { kind: 'fn'; fn: (req: EmbedRequest) => FakeEmbedScript | number[][] };

type ChatReply =
  | { kind: 'script'; events: KvoxChatEvent[] }
  | { kind: 'throw'; error: unknown };

/** A readiness answer, or a function computing one from the call. */
export type FakeReadinessScript =
  | Partial<KvoxAiReadiness>
  | ((userId: string, feature: KvoxAiFeatureId, requested: string | null) => Partial<KvoxAiReadiness>);

// ---------------------------------------------------------------------------
// Helpers a spec may use directly
// ---------------------------------------------------------------------------

/**
 * A deterministic, unit-length vector for `text`: the same text always gives the
 * same vector, different texts give different ones, and every component is
 * finite. `dimensions` defaults to the catalog width.
 */
export function fakeVector(text: string, dimensions: number = EMBEDDING_DIMENSIONS): number[] {
  // FNV-1a seeds a small LCG; no dependency, stable across runs and platforms.
  let seed = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }

  const out: number[] = new Array<number>(dimensions);
  let norm = 0;
  for (let i = 0; i < dimensions; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const component = seed / 0xffffffff - 0.5;
    out[i] = component;
    norm += component * component;
  }

  const length = Math.sqrt(norm) || 1;
  return out.map((component) => component / length);
}

/** The readiness a configured, keyed deployment answers with (the default). */
export function readyReadiness(overrides: Partial<KvoxAiReadiness> = {}): KvoxAiReadiness {
  return {
    ok: true,
    reason: null,
    provider: 'openai',
    model: 'gpt-4o',
    source: 'default',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    reasoningEffort: 'none',
    hasKey: true,
    ...overrides,
  };
}

/** A readiness refusing with `reason`, shaped the way the real adapter reports it. */
export function notReadyReadiness(
  reason: KvoxAiReason,
  overrides: Partial<KvoxAiReadiness> = {},
): KvoxAiReadiness {
  const noModel = reason === 'ai_not_configured';
  return readyReadiness({
    ok: false,
    reason,
    hasKey: reason !== 'ai_key_missing' && reason !== 'ai_not_configured',
    ...(noModel
      ? { provider: null, model: null, source: 'none' as const, contextWindowTokens: null, maxOutputTokens: null }
      : {}),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

export class FakeKvoxAi implements KvoxAi {
  /** Every call, in order. */
  readonly calls: FakeKvoxAiCall[] = [];

  private readiness_: FakeReadinessScript = {};
  private readonly readinessByFeature = new Map<KvoxAiFeatureId, FakeReadinessScript>();

  private readonly streams: StreamReply[] = [];
  private streamHandler: ((req: StreamRequest) => FakeStreamScript) | null = null;

  private readonly structured: StructuredReply[] = [];
  private structuredHandler: ((req: StructuredRequest) => FakeStructuredScript | unknown) | null = null;

  private readonly embeds: EmbedReply[] = [];
  private embedHandler: ((req: EmbedRequest) => FakeEmbedScript | number[][]) | null = null;

  private readonly chats: ChatReply[] = [];
  private chatHandler: ((req: KvoxChatRequest) => KvoxChatEvent[]) | null = null;

  // -- Readiness ------------------------------------------------------------

  /** Sets the answer for every feature that has no `setReadinessFor` of its own. */
  setReadiness(script: FakeReadinessScript): this {
    this.readiness_ = script;
    return this;
  }

  /** Sets the answer for one feature. */
  setReadinessFor(feature: KvoxAiFeatureId, script: FakeReadinessScript): this {
    this.readinessByFeature.set(feature, script);
    return this;
  }

  /** Shorthand: every feature refuses with `reason`. */
  setNotReady(reason: KvoxAiReason): this {
    return this.setReadiness(notReadyReadiness(reason));
  }

  async readiness(
    userId: string,
    feature: KvoxAiFeatureId,
    requested?: string | null,
  ): Promise<KvoxAiReadiness> {
    this.record('readiness', { userId, feature, requested: requested ?? null }, { userId, feature, model: requested ?? null });

    const script = this.readinessByFeature.get(feature) ?? this.readiness_;
    const patch = typeof script === 'function' ? script(userId, feature, requested ?? null) : script;
    const base = readyReadiness(requested ? { model: requested, source: 'requested' } : {});
    return { ...base, ...patch };
  }

  // -- Streamed text --------------------------------------------------------

  /** Queues one stream: the deltas it yields, or a full script. */
  queueStream(script: string | string[] | FakeStreamScript): this {
    this.streams.push({ kind: 'script', script: normaliseStream(script) });
    return this;
  }

  /** Queues a stream whose first iteration throws `error` (a refusal, a bad key, a rate limit). */
  queueStreamError(error: unknown): this {
    this.streams.push({ kind: 'throw', error });
    return this;
  }

  /** Queues a stream computed from the request. */
  queueStreamFn(fn: (req: StreamRequest) => FakeStreamScript): this {
    this.streams.push({ kind: 'fn', fn });
    return this;
  }

  /** The stream used when the queue is empty. Default: one delta, `Fake output.` */
  setStreamHandler(fn: (req: StreamRequest) => FakeStreamScript): this {
    this.streamHandler = fn;
    return this;
  }

  streamText(req: StreamRequest): AsyncIterable<KvoxTextEvent> {
    this.record('streamText', req, req);
    const reply = this.streams.shift();
    const handler = this.streamHandler;

    // A generator, so the throw happens on the first iteration exactly as the real
    // adapter's lazy stream does.
    return (async function* (): AsyncGenerator<KvoxTextEvent> {
      throwIfAborted(req.signal);

      let script: FakeStreamScript;
      if (reply?.kind === 'throw') throw reply.error;
      if (reply?.kind === 'script') script = reply.script;
      else if (reply?.kind === 'fn') script = reply.fn(req);
      else if (handler) script = handler(req);
      else script = { deltas: ['Fake output.'] };

      for (const text of script.deltas) {
        throwIfAborted(req.signal);
        yield { type: 'delta', text };
      }

      if (script.failAfter !== undefined) throw script.failAfter;

      yield {
        type: 'done',
        finishReason: script.finishReason ?? 'stop',
        model: script.model ?? 'gpt-4o',
        usage: script.usage ?? NO_USAGE,
      };
    })();
  }

  // -- Structured output ----------------------------------------------------

  /** Queues the next structured value (usage and model are optional extras). */
  queueStructured(value: unknown, extras: Omit<FakeStructuredScript, 'value'> = {}): this {
    this.structured.push({ kind: 'script', script: { value, ...extras } });
    return this;
  }

  /** Queues a failure (an `AiStructuredOutputError`, an `AiAuthError`, a `RateLimitError`, ...). */
  queueStructuredError(error: unknown): this {
    this.structured.push({ kind: 'throw', error });
    return this;
  }

  /** Queues a value computed from the request. May return a bare value or a `FakeStructuredScript`. */
  queueStructuredFn(fn: (req: StructuredRequest) => FakeStructuredScript | unknown): this {
    this.structured.push({ kind: 'fn', fn });
    return this;
  }

  /** The answer used when the queue is empty. Without one, an empty queue throws. */
  setStructuredHandler(fn: (req: StructuredRequest) => FakeStructuredScript | unknown): this {
    this.structuredHandler = fn;
    return this;
  }

  async generateStructured<T>(
    req: KvoxAiCallBase & {
      system: string;
      user: string;
      schemaName: string;
      schema: z.ZodType<T>;
      jsonSchema?: JsonSchema;
      maxOutputTokens?: number;
    },
  ): Promise<{ value: T; model: string; usage: KvoxUsage }> {
    this.record('generateStructured', req, req);
    throwIfAborted(req.signal);

    const reply = this.structured.shift();
    let result: FakeStructuredScript | unknown;
    if (reply?.kind === 'throw') throw reply.error;
    if (reply?.kind === 'script') result = reply.script;
    else if (reply?.kind === 'fn') result = reply.fn(req as StructuredRequest);
    else if (this.structuredHandler) result = this.structuredHandler(req as StructuredRequest);
    else {
      throw new Error(
        `FakeKvoxAi: no structured reply queued for "${req.schemaName}" (feature ${req.feature}); call queueStructured() or setStructuredHandler().`,
      );
    }

    const script = isStructuredScript(result) ? result : { value: result };

    // The real adapter re-validates with the caller's schema; so does the fake.
    const parsed = req.schema.safeParse(script.value);
    if (!parsed.success) {
      throw new AiStructuredOutputError(
        `The structured answer for "${req.schemaName}" does not match the requested schema.`,
        'invalid_json',
      );
    }

    return {
      value: parsed.data,
      model: script.model ?? 'gpt-4o',
      usage: script.usage ?? NO_USAGE,
    };
  }

  // -- Embeddings -----------------------------------------------------------

  /** Queues explicit vectors for the next `embed` call. */
  queueEmbed(vectors: number[][], extras: Omit<FakeEmbedScript, 'vectors'> = {}): this {
    this.embeds.push({ kind: 'script', script: { vectors, ...extras } });
    return this;
  }

  /** Queues a failure for the next `embed` call. */
  queueEmbedError(error: unknown): this {
    this.embeds.push({ kind: 'throw', error });
    return this;
  }

  /** The answer used when the queue is empty. Default: {@link fakeVector} per text. */
  setEmbedHandler(fn: (req: EmbedRequest) => FakeEmbedScript | number[][]): this {
    this.embedHandler = fn;
    return this;
  }

  async embed(
    req: EmbedRequest,
  ): Promise<{ vectors: number[][]; promptTokens: number | null; model: string }> {
    this.record('embed', req, req);
    throwIfAborted(req.signal);

    // Refused locally, as the real adapter does, so a caller that forgets to batch fails in a spec.
    if (req.texts.length === 0) {
      throw new AiInputError('An embedding batch must contain at least one text.');
    }
    if (req.texts.length > KVOX_EMBEDDING.maxBatchSize) {
      throw new AiInputError(
        `An embedding batch holds at most ${KVOX_EMBEDDING.maxBatchSize} texts; got ${req.texts.length}.`,
      );
    }

    const reply = this.embeds.shift();
    let result: FakeEmbedScript | number[][];
    if (reply?.kind === 'throw') throw reply.error;
    if (reply?.kind === 'script') result = reply.script;
    else if (reply?.kind === 'fn') result = reply.fn(req);
    else if (this.embedHandler) result = this.embedHandler(req);
    else {
      result = {
        vectors: req.texts.map((text) => fakeVector(text)),
        promptTokens: req.texts.reduce((sum, text) => sum + countTokens(text), 0),
      };
    }

    const script: FakeEmbedScript = Array.isArray(result) ? { vectors: result } : result;

    if (script.vectors.length !== req.texts.length) {
      throw new Error(
        `Embedding count mismatch: asked for ${req.texts.length} vectors, got ${script.vectors.length}.`,
      );
    }
    for (const vector of script.vectors) {
      if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every((c) => Number.isFinite(c))) {
        throw new Error(`Embedding width mismatch: expected ${EMBEDDING_DIMENSIONS} finite numbers.`);
      }
    }

    return {
      vectors: script.vectors,
      promptTokens: script.promptTokens === undefined ? null : script.promptTokens,
      model: script.model ?? KVOX_EMBEDDING.model,
    };
  }

  embeddingCapability(): KvoxEmbeddingCapability {
    return {
      model: KVOX_EMBEDDING.model,
      dimensions: KVOX_EMBEDDING.dimensions,
      maxInputTokens: KVOX_EMBEDDING.maxInputTokens,
      maxBatchSize: KVOX_EMBEDDING.maxBatchSize,
    };
  }

  countTokens(text: string, model: string): number {
    return countTokens(text, model);
  }

  // -- Chat (the Ask loop, implemented for real by #476) -----------------------

  /** Queues the events of the next `chat` turn. */
  queueChat(events: KvoxChatEvent[]): this {
    this.chats.push({ kind: 'script', events });
    return this;
  }

  /** Queues a failure for the next `chat` turn. */
  queueChatError(error: unknown): this {
    this.chats.push({ kind: 'throw', error });
    return this;
  }

  /** The turn used when the queue is empty. */
  setChatHandler(fn: (req: KvoxChatRequest) => KvoxChatEvent[]): this {
    this.chatHandler = fn;
    return this;
  }

  chat(req: KvoxChatRequest): AsyncIterable<KvoxChatEvent> {
    this.record('chat', req, req);
    const reply = this.chats.shift();
    const handler = this.chatHandler;

    return (async function* (): AsyncGenerator<KvoxChatEvent> {
      throwIfAborted(req.signal);
      if (reply?.kind === 'throw') throw reply.error;

      const events: KvoxChatEvent[] = reply?.events ??
        handler?.(req) ?? [
          { kind: 'delta', text: 'Fake output.' },
          { kind: 'done', finishReason: 'stop', model: 'gpt-4o', usage: NO_USAGE },
        ];
      for (const event of events) {
        throwIfAborted(req.signal);
        yield event;
      }
    })();
  }

  // -- Inspection -------------------------------------------------------------

  /** The recorded calls of one method. */
  callsOf(method: FakeKvoxAiMethod): FakeKvoxAiCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The most recent call of one method, or `undefined`. */
  lastCall(method: FakeKvoxAiMethod): FakeKvoxAiCall | undefined {
    const matching = this.callsOf(method);
    return matching[matching.length - 1];
  }

  /** How many replies are still queued, per method (a spec asserts it consumed them all). */
  pending(): Record<'streamText' | 'generateStructured' | 'embed' | 'chat', number> {
    return {
      streamText: this.streams.length,
      generateStructured: this.structured.length,
      embed: this.embeds.length,
      chat: this.chats.length,
    };
  }

  /** Forgets calls, queues, handlers and readiness: back to a configured, keyed deployment. */
  reset(): void {
    this.calls.length = 0;
    this.readiness_ = {};
    this.readinessByFeature.clear();
    this.streams.length = 0;
    this.structured.length = 0;
    this.embeds.length = 0;
    this.chats.length = 0;
    this.streamHandler = null;
    this.structuredHandler = null;
    this.embedHandler = null;
    this.chatHandler = null;
  }

  private record(
    method: FakeKvoxAiMethod,
    request: unknown,
    base: { userId: string; feature: KvoxAiFeatureId; orgId?: string; jobId?: string; model?: string | null },
  ): void {
    this.calls.push({
      method,
      userId: base.userId,
      feature: base.feature,
      ...(base.orgId !== undefined ? { orgId: base.orgId } : {}),
      ...(base.jobId !== undefined ? { jobId: base.jobId } : {}),
      ...(base.model !== undefined ? { model: base.model } : {}),
      request,
    });
  }
}

function normaliseStream(script: string | string[] | FakeStreamScript): FakeStreamScript {
  if (typeof script === 'string') return { deltas: [script] };
  if (Array.isArray(script)) return { deltas: script };
  return script;
}

function isStructuredScript(value: unknown): value is FakeStructuredScript {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    Object.keys(value).every((key) => key === 'value' || key === 'usage' || key === 'model')
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('The call was aborted.');
  }
}
