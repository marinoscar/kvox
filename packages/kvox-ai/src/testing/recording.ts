import { z } from 'zod';

import type {
  AiCallContext,
  AiEmbeddingRequest,
  AiProviderAdapter,
  AiResponse,
  AiResponseRequest,
  AiStreamEvent,
} from '@marinoscar/platform-ai-providers';

import type {
  KvoxAiKeyReadiness,
  KvoxAiRuntime,
  KvoxAiRuntimeCall,
  KvoxAiRuntimeEmbedRequest,
  KvoxAiRuntimeEmbedResult,
  KvoxAiRuntimeRequest,
} from '../runtime/index.js';
import { EMBEDDING_DIMENSIONS } from '../embedding/index.js';
import { SCRIPTED_RESPONSE, textAnswer } from './scripted-events.js';

// =============================================================================
// Recording: what each binding SENDS, for the harness-parity check (issue #580)
// =============================================================================
//
// "The web edition and KVox Desktop run the same harness" is proved by showing
// that, for the same input, both bindings build the SAME provider request: the
// system prompt, the user prompt or input, the strict JSON Schema, the tool
// definitions, the model, the reasoning effort and the output ceiling. These
// recorders capture that request at two layers both bindings share:
//
//   createRecordingRuntime   wraps ANY `KvoxAiRuntime` (the direct runtime, the
//                            web `PlatformAiRuntime`) and records the call
//                            (feature, provider, model) with the request.
//   createRecordingAdapter   an `AiProviderAdapter` for `createDirectRuntime`
//                            that records what `responses.stream/create` and
//                            `embeddings.embed` receive and answers from a script.
//                            A host that has no adapter (the web edition's fake
//                            `AiService`) records through `recordProviderRequest`.
//
// A record carries NO user id, organization id, job id or signal: those are
// host-specific and never part of the request a provider sees. Non-deterministic
// values (UUIDs, timestamps, request ids) are replaced by numbered placeholders
// (`normalizeRecordedValue`), never dropped, so two recordings are equal only
// when their structure is.
// =============================================================================

/**
 * The method a recorded round trip went through.
 *
 * @stability experimental
 */
export type RecordedMethod = 'stream' | 'create' | 'embed';

/**
 * One round trip as a runtime received it: the call without user, organization,
 * job or signal, and the request.
 *
 * @stability experimental
 */
export interface RecordedRequest {
  /** Which runtime method the round trip went through. */
  method: RecordedMethod;
  /** The AI feature the round trip was made for. */
  feature: string;
  /** The provider id the call named, when it named one. */
  provider?: string;
  /** The model id the call named, when it named one. */
  model?: string;
  /** The request as received: a chat or structured request, or the embeddings request. */
  request: unknown;
}

/**
 * One round trip as the provider layer received it: the request that reaches an
 * adapter (the direct edition) or the platform AI client (the web edition), with
 * its model.
 *
 * @remarks
 * `request` is the provider-adapter request WITHOUT `model`, normalized
 * (`normalizeRecordedValue`); `model` is carried beside it, like the runtime call
 * carries it. `feature` is present when the layer knows it (the web client is
 * opened per feature; an adapter is not told).
 *
 * @stability experimental
 */
export interface RecordedProviderRequest {
  /** Which provider method the round trip went through. */
  method: RecordedMethod;
  /** The AI feature, when the layer knows it. */
  feature?: string;
  /** The model the request names. */
  model?: string;
  /** The provider-adapter request without `model`, normalized. */
  request: unknown;
}

/**
 * A runtime that records the round trips it forwards.
 *
 * @stability experimental
 */
export interface RecordingRuntime extends KvoxAiRuntime {
  /**
   * Every stream, create and embed round trip so far, in call order, with the
   * request normalized (`normalizeRecordedValue`, one numbering across the list).
   *
   * @returns a copy of the records.
   */
  requests(): RecordedRequest[];
  /** Forgets the records. */
  reset(): void;
}

// -----------------------------------------------------------------------------
// Normalization
// -----------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;
const REQUEST_ID_KEY = /^(?:request[_-]?id|trace[_-]?id|span[_-]?id|correlation[_-]?id)$/i;

/**
 * Replaces non-deterministic values with placeholders.
 *
 * @stability experimental
 */
export interface RecordedValueNormalizer {
  /**
   * Normalizes one value. The same original value maps to the same placeholder for
   * the life of this normalizer, numbered by first appearance.
   *
   * @param value - any JSON-like value (a Zod schema becomes its JSON Schema).
   * @returns the normalized copy, with object keys in sorted order.
   */
  (value: unknown): unknown;
}

/**
 * Builds a normalizer whose placeholder numbering carries across calls, so equal
 * ids in different records of one recording map to equal placeholders.
 *
 * @returns the normalizer.
 * @stability experimental
 */
export function createRecordedValueNormalizer(): RecordedValueNormalizer {
  const seen = new Map<string, Map<string, number>>();
  const placeholder = (kind: string, original: string): string => {
    let ofKind = seen.get(kind);
    if (ofKind === undefined) {
      ofKind = new Map();
      seen.set(kind, ofKind);
    }
    let n = ofKind.get(original);
    if (n === undefined) {
      n = ofKind.size + 1;
      ofKind.set(original, n);
    }
    return `<${kind}:${n}>`;
  };

  const text = (value: string): string =>
    value
      .replace(ISO_TIMESTAMP, (m) => placeholder('timestamp', m))
      .replace(UUID, (m) => placeholder('uuid', m.toLowerCase()));

  const walk = (value: unknown, key: string | undefined): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return key !== undefined && REQUEST_ID_KEY.test(key) ? placeholder('requestId', value) : text(value);
    if (value instanceof Date) return placeholder('timestamp', value.toISOString());
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return '[function]';
    if (typeof value === 'undefined') return undefined;
    if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return '[signal]';
    if (Array.isArray(value)) return value.map((item) => walk(item, undefined));
    if (typeof value === 'object') {
      if ('_zod' in value) {
        // A Zod schema is what `structuredOutput` carries; the adapter turns it into JSON Schema for the wire.
        try {
          return walk(z.toJSONSchema(value as z.ZodType, { unrepresentable: 'any' }), undefined);
        } catch {
          return '[unrepresentable schema]';
        }
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        const next = walk((value as Record<string, unknown>)[k], k);
        if (next !== undefined) out[k] = next;
      }
      return out;
    }
    return String(value);
  };

  return (value) => walk(value, undefined);
}

/**
 * Normalizes one value with a fresh numbering: UUIDs, ISO timestamps and
 * `requestId`-like fields become `<uuid:N>`, `<timestamp:N>` and `<requestId:N>`,
 * numbered by first appearance. Nothing else is dropped or changed, so a
 * comparison stays meaningful.
 *
 * @example
 * ```ts
 * normalizeRecordedValue({ id: 'a1b2c3d4-0000-4000-8000-000000000001', at: '2026-01-01T00:00:00.000Z' });
 * // { at: '<timestamp:1>', id: '<uuid:1>' }
 * ```
 *
 * @param value - any JSON-like value; a Zod schema becomes its JSON Schema.
 * @returns the normalized copy, with object keys sorted.
 * @stability experimental
 */
export function normalizeRecordedValue(value: unknown): unknown {
  return createRecordedValueNormalizer()(value);
}

// -----------------------------------------------------------------------------
// The recording runtime
// -----------------------------------------------------------------------------

/**
 * Wraps a runtime so every round trip is recorded in call order, then forwarded
 * unchanged. Works over the direct runtime and over a host's own runtime alike.
 *
 * @example
 * ```ts
 * const recording = createRecordingRuntime(createDirectRuntime({ adapters, keys }));
 * const ai = createKvoxAi({ runtime: recording, taskModels });
 * await runScenario(ai);
 * expect(recording.requests()).toMatchSnapshot();
 * ```
 *
 * @param inner - the runtime to forward to.
 * @returns the runtime and its `requests()`.
 * @stability experimental
 */
export function createRecordingRuntime(inner: KvoxAiRuntime): RecordingRuntime {
  let raw: Array<Omit<RecordedRequest, 'request'> & { request: unknown }> = [];

  const note = (method: RecordedMethod, call: KvoxAiRuntimeCall, request: unknown): void => {
    raw.push({
      method,
      feature: call.feature,
      ...(call.provider !== undefined ? { provider: call.provider } : {}),
      ...(call.model !== undefined ? { model: call.model } : {}),
      // Snapshot now: the caller may keep mutating its message array.
      request: normalizeNow(request),
    });
  };

  const runtime: RecordingRuntime = {
    stream(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeRequest): AsyncIterable<AiStreamEvent> {
      note('stream', call, req);
      return inner.stream(call, req);
    },
    create(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeRequest): Promise<AiResponse> {
      note('create', call, req);
      return inner.create(call, req);
    },
    readiness(call: Pick<KvoxAiRuntimeCall, 'userId' | 'feature'> & { provider: string }): Promise<KvoxAiKeyReadiness> {
      return inner.readiness(call);
    },
    requests() {
      const normalize = createRecordedValueNormalizer();
      return raw.map((r) => ({ ...r, request: normalize(r.request) }));
    },
    reset() {
      raw = [];
    },
  };

  if (inner.embed !== undefined) {
    const embed = inner.embed.bind(inner);
    runtime.embed = (call: KvoxAiRuntimeCall, req: KvoxAiRuntimeEmbedRequest): Promise<KvoxAiRuntimeEmbedResult> => {
      note('embed', call, req);
      return embed(call, req);
    };
  }

  return runtime;
}

/** A structured clone that survives later mutation of the original; schemas are kept as they are for the normalizer. */
function normalizeNow(value: unknown): unknown {
  return JSON.parse(JSON.stringify(createSchemaFlattener()(value))) as unknown;
}

/** Turns Zod schemas into JSON Schema and leaves the rest, so a later `JSON.stringify` keeps them. */
function createSchemaFlattener(): (value: unknown) => unknown {
  const flatten = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(flatten);
    if (value instanceof Date) return value.toISOString();
    if ('_zod' in value) {
      try {
        return z.toJSONSchema(value as z.ZodType, { unrepresentable: 'any' });
      } catch {
        return '[unrepresentable schema]';
      }
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, flatten(v)]));
  };
  return flatten;
}

// -----------------------------------------------------------------------------
// Provider-level recording
// -----------------------------------------------------------------------------

/**
 * Builds a provider-level record: the request without its `model`, normalized
 * with `normalize` (share one normalizer across a recording so ids keep their
 * numbering), the model beside it.
 *
 * @param method - which provider method received the request.
 * @param request - the provider-adapter request, `model` included.
 * @param normalize - the normalizer shared by the recording.
 * @param feature - the AI feature, when the layer knows it.
 * @returns the record.
 * @stability experimental
 */
export function recordProviderRequest(
  method: RecordedMethod,
  request: AiResponseRequest | AiEmbeddingRequest | Record<string, unknown>,
  normalize: RecordedValueNormalizer,
  feature?: string,
): RecordedProviderRequest {
  const { model, ...rest } = request as Record<string, unknown> & { model?: string };
  return {
    method,
    ...(feature !== undefined ? { feature } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    request: normalize(normalizeNow(rest)),
  };
}

/**
 * What a recording provider answers with: one function per method, called with the
 * request and the zero-based index of the round trip of that method. Because it is
 * a function of the request, the SAME script answers identically behind the direct
 * adapter and behind the web edition's fake platform client.
 *
 * @stability experimental
 */
export interface RecordingScript {
  /** The events of a streamed round trip. Default: a streamed `Hello`. */
  stream?(request: AiResponseRequest, index: number): AiStreamEvent[];
  /** The response of a complete (and structured) round trip; `parsed` is the structured answer. Default: `{ ok: true }`. */
  create?(request: AiResponseRequest, index: number): Partial<AiResponse>;
  /** The vectors of an embeddings round trip. Default: one near-zero vector per input. */
  embed?(request: AiEmbeddingRequest, index: number): number[][];
}

/**
 * Answers a script's `create` step as the complete response a provider would send.
 *
 * @param step - what the script returned.
 * @returns the response, over the scripted defaults.
 * @stability experimental
 */
export function completeScriptedResponse(step: Partial<AiResponse>): AiResponse {
  return { ...SCRIPTED_RESPONSE, ...step } as AiResponse;
}

/**
 * An adapter for `createDirectRuntime` that records what reaches the provider.
 *
 * @stability experimental
 */
export interface RecordingAdapter extends AiProviderAdapter {
  /**
   * What the adapter received, in call order, normalized with one numbering.
   *
   * @returns a copy of the records.
   */
  requests(): RecordedProviderRequest[];
  /** Forgets the records and the script's counters. */
  reset(): void;
}

/**
 * Builds a provider adapter that records every request `responses.stream/create` and
 * `embeddings.embed` receive and answers from `script`. It holds no key, makes no
 * network call and needs no credentials, so the direct edition's whole path
 * (`createKvoxAi` over `createDirectRuntime`) runs offline.
 *
 * @example
 * ```ts
 * const adapter = createRecordingAdapter({ create: () => ({ parsed: { ok: true }, outputText: '{"ok":true}' }) });
 * const runtime = createDirectRuntime({ adapters: { openai: adapter }, keys: async () => ({ apiKey: 'test' }) });
 * ```
 *
 * @param script - how each method answers.
 * @param id - the adapter id. Default `openai`.
 * @returns the adapter.
 * @stability experimental
 */
export function createRecordingAdapter(script: RecordingScript = {}, id = 'openai'): RecordingAdapter {
  let records: RecordedProviderRequest[] = [];
  let counts: Record<RecordedMethod, number> = { stream: 0, create: 0, embed: 0 };
  let normalize = createRecordedValueNormalizer();

  const next = (method: RecordedMethod): number => counts[method]++;
  const unsupported = (what: string) => async (): Promise<never> => {
    throw new Error(`The recording adapter does not implement ${what}.`);
  };

  const adapter = {
    id,
    displayName: `Recording ${id}`,
    listModels: unsupported('listModels'),
    verifyKey: unsupported('verifyKey'),
    classifyModel: () => null,
    responses: {
      async create(req: AiResponseRequest, _ctx: AiCallContext): Promise<AiResponse> {
        const index = next('create');
        records.push(recordProviderRequest('create', req, normalize));
        return completeScriptedResponse(script.create?.(req, index) ?? { parsed: { ok: true }, outputText: '{"ok":true}' });
      },
      stream(req: AiResponseRequest, _ctx: AiCallContext): AsyncIterable<AiStreamEvent> {
        const index = next('stream');
        records.push(recordProviderRequest('stream', req, normalize));
        const events = script.stream?.(req, index) ?? textAnswer('Hello');
        return (async function* (): AsyncGenerator<AiStreamEvent> {
          for (const event of events) yield event;
        })();
      },
    },
    embeddings: {
      async embed(req: AiEmbeddingRequest, _ctx: AiCallContext) {
        const index = next('embed');
        records.push(recordProviderRequest('embed', req, normalize));
        const inputs = Array.isArray(req.input) ? req.input : [req.input];
        const vectors = script.embed?.(req, index) ?? inputs.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01));
        return { provider: id, model: req.model, vectors, dimensions: vectors[0]?.length ?? 0, usage: { inputTokens: 1 } };
      },
    },
    requests: () => records.map((r) => ({ ...r })),
    reset: () => {
      records = [];
      counts = { stream: 0, create: 0, embed: 0 };
      normalize = createRecordedValueNormalizer();
    },
  };

  return adapter as unknown as RecordingAdapter;
}

/**
 * Wraps a real provider adapter so the requests its `responses.create` and
 * `responses.stream` receive are recorded exactly as {@link createRecordingAdapter}
 * records them (the same `recordProviderRequest` normalization, one numbering per
 * recording), then delegated to `inner` unchanged. Everything else (`id`,
 * `displayName`, `listModels`, `verifyKey`, `classifyModel`, the behaviour flags and
 * the other ports) is the inner adapter's.
 *
 * @remarks
 * For a parity check over an adapter that answers for itself, such as the GitHub
 * Copilot adapter over its mock transport (#581): the recording proves the request
 * that reached the adapter, the inner adapter proves what it did with it.
 *
 * @example
 * ```ts
 * const adapter = wrapRecordingAdapter(createCopilotAdapter({ optIn: true, transport: createCopilotMockTransport() }));
 * const runtime = createDirectRuntime({ adapters: { copilot: adapter }, keys: async () => ({ apiKey: AI_KEYLESS_API_KEY }) });
 * ```
 *
 * @param inner - the adapter to delegate to; it must have a `responses` port.
 * @returns the recording adapter.
 * @throws when `inner` has no `responses` port (there would be nothing to record).
 * @stability experimental
 */
export function wrapRecordingAdapter(inner: AiProviderAdapter): RecordingAdapter {
  const responses = inner.responses;
  if (responses === undefined) {
    throw new Error(`The adapter "${inner.id}" has no responses port to record.`);
  }
  let records: RecordedProviderRequest[] = [];
  let normalize = createRecordedValueNormalizer();

  const recorded: AiProviderAdapter['responses'] = {
    create(req: AiResponseRequest, ctx: AiCallContext): Promise<AiResponse> {
      records.push(recordProviderRequest('create', req, normalize));
      return responses.create(req, ctx);
    },
    stream(req: AiResponseRequest, ctx: AiCallContext): AsyncIterable<AiStreamEvent> {
      records.push(recordProviderRequest('stream', req, normalize));
      return responses.stream(req, ctx);
    },
  };

  const own: Record<PropertyKey, unknown> = {
    responses: recorded,
    requests: () => records.map((r) => ({ ...r })),
    reset: () => {
      records = [];
      normalize = createRecordedValueNormalizer();
    },
  };
  // Every other member is read from the inner adapter, its methods bound to it (so a
  // class adapter with private state keeps working).
  const adapter = new Proxy(inner, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(own, prop)) return own[prop];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    has(target, prop) {
      return Object.prototype.hasOwnProperty.call(own, prop) || Reflect.has(target, prop);
    },
  }) as unknown as RecordingAdapter;
  return adapter;
}

/**
 * Puts the AI feature on provider-level records that do not know it (an adapter is
 * not told which feature a round trip is for), taking it from the runtime-level
 * records of the same recording. Both lists are in call order and hold one record per
 * round trip, so the n-th record of each is the same round trip.
 *
 * @param provider - what the adapter recorded.
 * @param runtime - what a `createRecordingRuntime` above it recorded.
 * @returns the provider records with `feature` set.
 * @throws when the two lists differ in length or in method at some position (the layers saw different traffic).
 * @stability experimental
 */
export function withRecordedFeatures(
  provider: readonly RecordedProviderRequest[],
  runtime: readonly RecordedRequest[],
): RecordedProviderRequest[] {
  if (provider.length !== runtime.length) {
    throw new Error(`The adapter recorded ${provider.length} round trips but the runtime recorded ${runtime.length}.`);
  }
  return provider.map((record, i) => {
    if (record.method !== runtime[i].method) {
      throw new Error(`Round trip ${i} was a ${record.method} at the adapter but a ${runtime[i].method} at the runtime.`);
    }
    return { method: record.method, feature: runtime[i].feature, ...(record.model !== undefined ? { model: record.model } : {}), request: record.request };
  });
}
