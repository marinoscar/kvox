// =============================================================================
// createLiveKvoxAi: the model port a live evaluation runs on (issue #580)
// =============================================================================
//
// An evaluation is a developer or CI tool: no signed-in user, no organization,
// no stored key, no platform AI service. So it binds the SAME port every host
// binds, `createKvoxAi` of `@marinoscar/kvox-ai`, over `createDirectRuntime`
// (the provider adapters, called directly) and a static task-model source that
// answers "this provider, this one model". The runners never see more than the
// port; nothing here is a second implementation of a provider call (#475's
// private OpenAI client is gone).
//
// THE KEY. Handed in by the caller (the CLI reads it with `readEvalApiKey`),
// given to the direct runtime's `keys()` callback, and from there to one adapter
// call at a time. It is never logged, never put in an error, never returned.
// A failed call surfaces as the port's `KvoxAiError` (scrubbed); `failures`
// records only the platform error CODE and HTTP status of each failed round
// trip, which is what the CLI prints.
//
// `copilot` is refused until the Copilot adapter exists (#581): no installed
// package carries one today.
// =============================================================================

import { createDirectRuntime, createKvoxAi, type KvoxAiModelState, type KvoxAiRuntime, type KvoxTaskModelSource } from '@marinoscar/kvox-ai';
import type { KvoxAiPort } from '@marinoscar/kvox-api/ports';
import type { AiProviderAdapter } from '@marinoscar/platform-api/ai';

import { platformAdapter, type PlatformAdapterProvider } from './adapters.js';

/**
 * The providers a live run may name. `copilot` is listed so it can be refused
 * with a reason (its adapter arrives with #581).
 *
 * @stability experimental
 */
export const LIVE_PROVIDERS = Object.freeze(['openai', 'openai-compatible', 'copilot'] as const);

/**
 * One of {@link LIVE_PROVIDERS}.
 *
 * @stability experimental
 */
export type LiveProvider = (typeof LIVE_PROVIDERS)[number];

/**
 * A live run that cannot be set up as asked (an unknown or unavailable provider,
 * a missing base URL or key). The CLI maps it to exit code 2.
 *
 * @stability experimental
 */
export class LiveProviderError extends Error {}

/**
 * The code and HTTP status of one failed provider round trip: what a report may
 * say about a failure (never a message body, which could echo a credential).
 *
 * @stability experimental
 */
export interface LiveCallFailure {
  /** The platform's error code (`AI_KEY_INVALID`, `AI_RATE_LIMITED`, ...), or the error's name. */
  code: string;
  /** The HTTP status the code maps to, when the error carries one. */
  status: number | null;
}

/**
 * What {@link createLiveKvoxAi} is built from.
 *
 * @stability experimental
 */
export interface CreateLiveKvoxAiOptions {
  /** The provider every call goes to. */
  provider: LiveProvider | string;
  /** The model every call targets (the only enabled model). */
  model: string;
  /**
   * The API key. ⚠ Secret. Required for `openai`; optional for an
   * `openai-compatible` server that needs none (the platform's keyless marker is sent).
   */
  apiKey: string | null;
  /** The server's API root (`/v1` included). Required for `openai-compatible`; an override for `openai`. */
  baseUrl?: string;
  /** The adapters by provider id. Default: the platform's, built by `platformAdapter`. A test passes a fake. */
  adapters?: Readonly<Record<string, AiProviderAdapter>>;
}

/**
 * The live port plus what the caller may report about its failures.
 *
 * @stability experimental
 */
export interface LiveKvoxAi {
  /** The model port (`createKvoxAi` over the direct runtime). */
  ai: KvoxAiPort;
  /** Every failed round trip so far, code and status only. */
  failures: LiveCallFailure[];
}

/**
 * Refuses a provider a live run cannot use today: `copilot` (its adapter arrives
 * with #581) and any id that is not a {@link LIVE_PROVIDERS} entry.
 *
 * @param provider - the provider id a run names.
 * @throws {@link LiveProviderError} with the reason.
 * @stability experimental
 */
export function assertLiveProvider(provider: string): asserts provider is PlatformAdapterProvider {
  if (provider === 'copilot') {
    throw new LiveProviderError(
      "the 'copilot' provider is not available yet: it arrives with the Copilot adapter (#581). Use --provider openai or openai-compatible.",
    );
  }
  if (provider !== 'openai' && provider !== 'openai-compatible') {
    throw new LiveProviderError(`unknown provider '${provider}' (known: ${LIVE_PROVIDERS.join(', ')})`);
  }
}

/**
 * The task-model state of a run on one provider and one model: AI on, the graph
 * switch on, every task on that model, no reasoning parameter (`none`).
 *
 * @param provider - the provider id.
 * @param model - the model id.
 * @returns a source whose `load()` always answers that state.
 * @stability experimental
 */
export function staticTaskModelSource(provider: string, model: string): KvoxTaskModelSource {
  const state: KvoxAiModelState = {
    provider,
    models: [{ id: model, label: model, structuredOutput: true, toolCalling: true, contextWindow: null, maxOutputTokens: null }],
    policy: {
      enabled: true,
      provider,
      defaultModel: model,
      graphEnabled: true,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
  return { load: async () => state };
}

/**
 * Builds the model port a live evaluation runs on.
 *
 * @example
 * ```ts
 * const key = readEvalApiKey(process.env);
 * const { ai } = createLiveKvoxAi({ provider: 'openai', model: 'gpt-5-mini', apiKey: key?.apiKey ?? null });
 * const report = await runKgEval({ runner: 'extract', ai, model: 'gpt-5-mini' });
 * ```
 *
 * @param options - provider, model, key and (optionally) the adapters.
 * @returns the port and its failure log.
 * @throws {@link LiveProviderError} for `copilot`, an unknown provider, an
 *   `openai` run without a key, or an `openai-compatible` run without a base URL.
 * @stability experimental
 */
export function createLiveKvoxAi(options: CreateLiveKvoxAiOptions): LiveKvoxAi {
  const { provider, model, apiKey, baseUrl } = options;
  assertLiveProvider(provider);
  if (provider === 'openai' && !apiKey) throw new LiveProviderError('the openai provider needs an API key');
  if (provider === 'openai-compatible' && !baseUrl) throw new LiveProviderError('the openai-compatible provider needs --base-url <url>');
  if (!model) throw new LiveProviderError('a live run needs a model');

  const adapters = options.adapters ?? { [provider]: platformAdapter(provider) };
  // The platform's marker for a keyless OpenAI-compatible server: the client sends no Authorization header.
  const KEYLESS = 'not-needed';
  const key = apiKey || KEYLESS;

  const failures: LiveCallFailure[] = [];
  const runtime = recordingFailures(
    createDirectRuntime({
      adapters,
      keys: async (p) => (p === provider ? { apiKey: key, ...(baseUrl ? { baseUrl } : {}) } : null),
    }),
    failures,
  );
  return { ai: createKvoxAi({ runtime, taskModels: staticTaskModelSource(provider, model) }), failures };
}

/** The code and status of a thrown value, never its message. */
function failureOf(error: unknown): LiveCallFailure {
  const e = error as { code?: unknown; name?: unknown; getStatus?: () => unknown; status?: unknown };
  const status = typeof e?.getStatus === 'function' ? e.getStatus() : e?.status;
  return {
    code: typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'Error',
    status: typeof status === 'number' ? status : null,
  };
}

/** The runtime, with each failed round trip's code and status appended to `failures`. */
function recordingFailures(runtime: KvoxAiRuntime, failures: LiveCallFailure[]): KvoxAiRuntime {
  return {
    ...runtime,
    async create(call, req) {
      try {
        return await runtime.create(call, req);
      } catch (error) {
        failures.push(failureOf(error));
        throw error;
      }
    },
    async *stream(call, req) {
      try {
        yield* runtime.stream(call, req);
      } catch (error) {
        failures.push(failureOf(error));
        throw error;
      }
    },
  };
}
