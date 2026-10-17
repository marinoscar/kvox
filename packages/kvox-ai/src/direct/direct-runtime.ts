import { randomUUID } from 'node:crypto';

import { AiError, type AiCallContext, type AiProviderAdapter, type AiResponse, type AiStreamEvent } from '@marinoscar/platform-api/ai';
import { KvoxAiError } from '@marinoscar/kvox-api/ports';

import { isErrorLike, scrub } from '../errors/index.js';
import type {
  KvoxAiKeyReadiness,
  KvoxAiRuntime,
  KvoxAiRuntimeCall,
  KvoxAiRuntimeEmbedRequest,
  KvoxAiRuntimeEmbedResult,
  KvoxAiRuntimeRequest,
} from '../runtime/index.js';

// =============================================================================
// createDirectRuntime: KvoxAiRuntime over the provider adapters (issue #579)
// =============================================================================
//
// The runtime of a host with no platform AI service under it (KVox Desktop, a
// plain Node script, a test): each round trip goes straight to an
// `AiProviderAdapter` (`responses.stream` / `responses.create` /
// `embeddings.embed`) with a key the host hands over for that one call.
//
// PER CALL: `keys(provider)` -> an `AiCallContext` (`apiKey`, `baseUrl`, the
// provider's non-secret settings, the signal, a fresh `requestId`) -> the
// adapter. The context is dropped when the call settles; the runtime keeps no
// key between calls. `readiness` asks `keys(provider)` and keeps only whether it
// answered.
//
// WHAT IT CANNOT DO, AND SAYS SO. There is no target resolver below it, so a call
// must name its provider and model (`createKvoxAi` sends the target's); one that
// does not is refused `not_configured`. A provider with no adapter is
// `not_configured`, an adapter without the port a call needs is `capability`, a
// provider with no key is `key_missing`. Usage is not recorded and nothing is
// traced: a host that wants either wraps this runtime.
//
// ⚠ A KEY NEVER LEAVES. It is never logged, never put in an error or an event, and
// never returned. An adapter's `AiError` passes through for `createKvoxAi` to
// classify (its message is generic by the platform's rule); any other thrown value
// and every in-band error event leave with their message scrubbed.
// =============================================================================

/**
 * The credential a host hands over for ONE call. ⚠ Secret: the runtime uses it for
 * that call and drops it.
 *
 * @stability experimental
 */
export interface KvoxAiProviderKey {
  /** The key the call is made under. ⚠ Secret. */
  apiKey: string;
  /** An endpoint override (an OpenAI-compatible server). */
  baseUrl?: string;
  /** The provider's other NON-SECRET settings, passed to the adapter as is. */
  providerSettings?: Readonly<Record<string, unknown>>;
}

/**
 * What `createDirectRuntime` is built from.
 *
 * @stability experimental
 */
export interface CreateDirectRuntimeOptions {
  /** The provider adapters by provider id (`openai`, `openai-compatible`, ...). */
  adapters: Readonly<Record<string, AiProviderAdapter>>;
  /**
   * The key for a provider, fetched per call (Desktop: the OS keychain), or `null`
   * when the user has none.
   */
  keys: (provider: string) => Promise<KvoxAiProviderKey | null>;
}

/**
 * Builds a `KvoxAiRuntime` that calls the provider adapters directly, with a key
 * fetched per call.
 *
 * @example
 * ```ts
 * const runtime = createDirectRuntime({
 *   adapters: { openai: openAiAdapter },
 *   keys: async () => (process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : null),
 * });
 * const ai = createKvoxAi({ runtime, taskModels });
 * ```
 *
 * @param options - the adapters and the key source.
 * @returns the runtime.
 * @stability experimental
 */
export function createDirectRuntime(options: CreateDirectRuntimeOptions): KvoxAiRuntime {
  const { adapters, keys } = options;

  /** The adapter, the model and the call context for one round trip. */
  async function open(call: KvoxAiRuntimeCall): Promise<{ adapter: AiProviderAdapter; model: string; ctx: AiCallContext }> {
    if (call.provider === undefined || call.provider.length === 0 || call.model === undefined || call.model.length === 0) {
      throw new KvoxAiError('not_configured', 'The direct AI runtime needs a provider and a model for every call.');
    }
    const adapter = adapters[call.provider];
    if (adapter === undefined) {
      throw new KvoxAiError('not_configured', `No AI provider adapter is registered for "${scrub(call.provider)}".`);
    }
    const key = await keys(call.provider);
    if (key === null) {
      throw new KvoxAiError('key_missing', 'You have not saved an AI API key. Add one in your settings and try again.');
    }
    return {
      adapter,
      model: call.model,
      ctx: {
        apiKey: key.apiKey,
        ...(key.baseUrl !== undefined ? { baseUrl: key.baseUrl } : {}),
        ...(key.providerSettings !== undefined ? { providerSettings: key.providerSettings } : {}),
        ...(call.signal !== undefined ? { signal: call.signal } : {}),
        requestId: randomUUID(),
      },
    };
  }

  return {
    async *stream(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeRequest): AsyncIterable<AiStreamEvent> {
      let opened: Awaited<ReturnType<typeof open>> | null = await open(call);
      try {
        const responses = opened.adapter.responses;
        if (responses === undefined) throw noPort(call, 'responses');
        for await (const event of responses.stream({ ...req, model: opened.model }, opened.ctx)) {
          yield event.type === 'error' ? { ...event, message: scrub(event.message) } : event;
        }
      } catch (error) {
        throw sanitize(error);
      } finally {
        // The key's reference goes with the call.
        opened = null;
      }
    },

    async create(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeRequest): Promise<AiResponse> {
      let opened: Awaited<ReturnType<typeof open>> | null = await open(call);
      try {
        const responses = opened.adapter.responses;
        if (responses === undefined) throw noPort(call, 'responses');
        return await responses.create({ ...req, model: opened.model }, opened.ctx);
      } catch (error) {
        throw sanitize(error);
      } finally {
        opened = null;
      }
    },

    async embed(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeEmbedRequest): Promise<KvoxAiRuntimeEmbedResult> {
      let opened: Awaited<ReturnType<typeof open>> | null = await open(call);
      try {
        const embeddings = opened.adapter.embeddings;
        if (embeddings === undefined) throw noPort(call, 'embeddings');
        const result = await embeddings.embed(
          { model: opened.model, input: req.input, ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}) },
          opened.ctx,
        );
        return { vectors: result.vectors, inputTokens: result.usage?.inputTokens ?? null, model: result.model };
      } catch (error) {
        throw sanitize(error);
      } finally {
        opened = null;
      }
    },

    async readiness(call: Pick<KvoxAiRuntimeCall, 'userId' | 'feature'> & { provider: string }): Promise<KvoxAiKeyReadiness> {
      // Existence only: the key is not kept.
      return { hasKey: (await keys(call.provider)) !== null };
    },
  };
}

/** The refusal for an adapter that lacks the port a call needs. */
function noPort(call: KvoxAiRuntimeCall, port: string): KvoxAiError {
  return new KvoxAiError('capability', `The "${scrub(call.provider ?? '')}" adapter offers no ${port}.`);
}

/**
 * A thrown value as it may leave: a `KvoxAiError` or an `AiError` as it is (the
 * platform keeps its messages generic, and `createKvoxAi` classifies by code), any
 * other error with its name kept and its message scrubbed.
 */
function sanitize(error: unknown): unknown {
  if (error instanceof KvoxAiError || AiError.isAiError(error)) return error;
  if (isErrorLike(error)) {
    const clean = new Error(scrub(error.message));
    clean.name = error.name;
    return clean;
  }
  return typeof error === 'string' ? scrub(error) : error;
}
