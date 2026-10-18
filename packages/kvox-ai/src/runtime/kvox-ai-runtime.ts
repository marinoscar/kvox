import type { AiResponse, AiResponseRequest, AiStreamEvent } from '@marinoscar/platform-api/ai';

import type { KvoxAiFeatureId } from '../features/index.js';
import type { AiTaskKey, TaskModelPolicy } from '../tasks/index.js';
import type { KvoxReasoningEffort } from '../types/index.js';

// =============================================================================
// The host-supplied runtime and model sources (issue #579)
// =============================================================================
//
// `@marinoscar/kvox-ai` writes the model mechanics ONCE (structured output,
// chat and tool-call mapping, task-to-model choice, error mapping) and leaves
// a host exactly two decisions: WHICH PROVIDER a round trip goes to, and WHERE
// THE KEY COMES FROM. These interfaces are those two decisions:
//
//   KvoxAiRuntime        one provider round trip, and "is there a key?".
//                        Web: over the platform `AiService.forUser(...)`, which
//                        runs the gates, resolves the user's key, records one
//                        usage row per round trip and traces the call.
//                        Desktop: over the provider adapters directly, with a
//                        key from the OS keychain (`createDirectRuntime`, #579).
//   KvoxTaskModelSource  the state task-to-model choice reads: the active
//                        provider, the enabled models and the policy.
//                        Web: system settings and the `ai_models` rows.
//                        Desktop: a local settings file.
//   KvoxModelCatalog     what one model can do (context window, output ceiling,
//                        structured output, tools), when a host knows more than
//                        the task source carries.
//
// Only the INTERFACES live here. `createKvoxAi` (the `port` slice) implements
// `KvoxAiPort` over them; `createDirectRuntime` (the `direct` slice) is the
// Desktop runtime and the web runtime is `PlatformAiRuntime` in `apps/api`.
//
// ⚠ A KEY NEVER CROSSES THESE INTERFACES. A call names a user and a provider;
// the runtime resolves the key itself, per call, and never returns it.
// ⚠ The request and event types are the provider-adapter types of
// `@marinoscar/platform-api/ai` (an interim peer until the lean adapter package
// of #578 ships), imported as types only.
// =============================================================================

/**
 * Who a provider round trip is made for, and where it goes.
 *
 * @remarks
 * Deviates from the #579 sketch in three ways, each so the web runtime can keep
 * doing exactly what the retired `PlatformKvoxAi` did:
 *
 * - `orgId` and `jobId` ride along: the web runtime passes them to
 *   `AiService.forUser(userId, { orgId, jobId, feature })`, so the usage row and
 *   the span link to the organization and the queue job.
 * - `provider` and `model` are OPTIONAL. The web edition sends only `model`, and
 *   only when the caller or the task chose one; the platform's target resolver
 *   (`KvoxAiTargetResolver`) answers the rest. A runtime that cannot choose
 *   (the direct runtime) refuses a call without them.
 * - The model is carried HERE, not on the request: the runtime request is
 *   {@link KvoxAiRuntimeRequest} (`AiResponseRequest` without `model`), so the
 *   two can never disagree.
 *
 * No field is a key.
 *
 * @stability experimental
 */
export interface KvoxAiRuntimeCall {
  /** The user whose own key pays for the round trip. */
  userId: string;
  /** The organization the round trip is billed and audited under. The host's default when absent. */
  orgId?: string;
  /** The queue job making the round trip, so the host's span and usage row link to it. */
  jobId?: string;
  /** The AI feature the round trip is made for (`note_generate`, `graph_extract`, ...). */
  feature: KvoxAiFeatureId;
  /** The provider id (`openai`, `openai-compatible`, ...). Absent: the runtime resolves it, or refuses. */
  provider?: string;
  /** The model id. Absent: the runtime resolves it, or refuses. */
  model?: string;
  /** Aborts the round trip (the caller's signal combined with the request timeout). */
  signal?: AbortSignal;
}

/**
 * One provider request as a runtime receives it: the provider-adapter request
 * without `model`, which {@link KvoxAiRuntimeCall} carries.
 *
 * @remarks
 * Structured output is a request field (`structuredOutput`, carrying `name`,
 * `schema` and `strict`), so {@link KvoxAiRuntime.create} covers it on both
 * hosts: the platform's `respondStructured` is exactly `respond` with that field
 * set.
 *
 * @stability experimental
 */
export type KvoxAiRuntimeRequest = Omit<AiResponseRequest, 'model'>;

/**
 * One embeddings request as a runtime receives it.
 *
 * @stability experimental
 */
export interface KvoxAiRuntimeEmbedRequest {
  /** The texts, in order; one vector comes back per text. */
  input: string[];
  /** The width asked of the model, when it can shorten its vectors. */
  dimensions?: number;
}

/**
 * One embeddings answer from a runtime.
 *
 * @stability experimental
 */
export interface KvoxAiRuntimeEmbedResult {
  /** One vector per input text, in input order. */
  vectors: number[][];
  /** Input tokens the provider reported; `null` when it reported none (never `0` for unknown). */
  inputTokens: number | null;
  /** The model the provider says answered, when it says. */
  model?: string;
}

/**
 * A runtime's answer to "can this user call this provider at all?". Never
 * carries the key.
 *
 * @remarks
 * Named apart from {@link KvoxAiReadiness} on purpose: that is the facade's rich
 * readiness (reason, model, source, token limits, effort), which `createKvoxAi`
 * derives from this key-presence answer and the {@link KvoxTaskModelSource}
 * state. A runtime answers only the part only the host knows: whether a key
 * exists.
 *
 * @stability experimental
 */
export interface KvoxAiKeyReadiness {
  /** Whether a key exists for the user and provider (existence only; the key is never read here). */
  hasKey: boolean;
}

/**
 * One provider round trip, supplied by the host. The one seam between the
 * model mechanics and a provider.
 *
 * @remarks
 * Every method is ONE round trip: a structured repair or an Ask step is another
 * call, so a host that records usage per call (the web edition) records each.
 * A failure is thrown as the host's own error; `createKvoxAi` maps it to a
 * `KvoxAiError`. No method returns, logs or throws a key.
 *
 * @extensionPoint
 * @stability experimental
 */
export interface KvoxAiRuntime {
  /**
   * One streamed response.
   *
   * @param call - who the round trip is for, and where it goes.
   * @param req - the request, without `model`.
   * @returns the provider-adapter events, ending in `response.completed` or `error`.
   */
  stream(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeRequest): AsyncIterable<AiStreamEvent>;

  /**
   * One complete response (also the structured-output call: set `structuredOutput`).
   *
   * @param call - who the round trip is for, and where it goes.
   * @param req - the request, without `model`.
   * @returns the provider-adapter response.
   */
  create(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeRequest): Promise<AiResponse>;

  /**
   * One embeddings call. Absent: the host offers no embeddings, and the port's
   * `embed` refuses with a capability error. `call.provider` and `call.model` are
   * required here: vectors are comparable only within one model, so it is never
   * inferred.
   *
   * @param call - who the round trip is for, with `provider` and `model` set.
   * @param req - the texts.
   * @returns one vector per text, in order.
   */
  embed?(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeEmbedRequest): Promise<KvoxAiRuntimeEmbedResult>;

  /**
   * Whether a key is available for this user and provider. Never throws for a
   * missing key (that is `hasKey: false`), never returns the key.
   *
   * @param call - the user, the feature and the provider asked about.
   * @returns the key-presence answer.
   */
  readiness(call: Pick<KvoxAiRuntimeCall, 'userId' | 'feature'> & { provider: string }): Promise<KvoxAiKeyReadiness>;
}

/**
 * How a model is held to a structured-output schema (#581).
 *
 * @remarks
 * - `native`: the request carries `structuredOutput` and the provider enforces
 *   the schema (OpenAI's strict JSON Schema). The default.
 * - `prompted`: the provider has no schema enforcement for this model (a GitHub
 *   Copilot-hosted Claude model). `createKvoxAi` puts the JSON Schema in the
 *   system prompt, parses the text answer, validates it and asks for ONE repair
 *   when it does not validate (`buildPromptedStructuredRequest` and its siblings
 *   in the `structured` slice).
 *
 * @stability experimental
 */
export type KvoxStructuredOutputMode = 'native' | 'prompted';

/**
 * One model the host enabled, as task-to-model choice reads it: the chooser's
 * candidate flags plus the numbers the token budget takes.
 *
 * @remarks
 * The web task source (`apps/api/src/ai-port/platform-task-model-source.ts`) aliases it as
 * `KvoxEnabledModel` and hands its rows over unchanged.
 *
 * @stability experimental
 */
export interface KvoxAiEnabledModel {
  /** The provider's model id. */
  id: string;
  /** What the admin UI shows. */
  label: string;
  /** Whether the model honours strict structured output. */
  structuredOutput: boolean;
  /** Whether the model can call tools. */
  toolCalling: boolean;
  /** The context window in tokens; `null` when the host does not know it. */
  contextWindow: number | null;
  /** The output ceiling in tokens; `null` when the host does not know it. */
  maxOutputTokens: number | null;
  /**
   * How `generateStructured` holds the model to a schema (#581). Absent means
   * `native`, so every existing row keeps its behaviour.
   */
  structuredOutputMode?: KvoxStructuredOutputMode;
}

/**
 * Everything task-to-model choice and readiness read, in one load: the policy,
 * the active provider and its enabled models.
 *
 * @remarks
 * Mirrors `KvoxAiResolverState` of the web resolver field for field.
 *
 * @stability experimental
 */
export interface KvoxAiModelState {
  /** The chooser's policy plus the deployment's switches and token ceilings. */
  policy: TaskModelPolicy & {
    /** Whether AI is on at all. */
    enabled: boolean;
    /** The deployment's input ceiling in tokens, or `null` for none. */
    maxInputTokens: number | null;
    /** The deployment's output ceiling in tokens, or `null` for none. */
    maxOutputTokens: number | null;
  };
  /** The active provider, or `null` while AI or its provider is off. */
  provider: string | null;
  /** The enabled models of the active provider; empty when there is none. */
  models: KvoxAiEnabledModel[];
}

/**
 * One task's resolved target: provider, model and effort.
 *
 * @stability experimental
 */
export interface KvoxTaskModelTarget {
  /** The provider id. */
  provider: string;
  /** The model id. */
  model: string;
  /** The effort the task runs at, before the wire clamp (`xhigh` to `high`, `none` omits it). */
  effort?: KvoxReasoningEffort;
}

/**
 * Where the host keeps the task-to-model settings. Web: system settings and the
 * enabled `ai_models` rows. Desktop: a local settings file.
 *
 * @remarks
 * Deviates from the #579 sketch, which had only
 * `resolve(userId, task)`: readiness needs the WHOLE state (provider, every
 * enabled model with its limits and flags, the policy), not one answer, to give
 * its reasons in the product's order (graph switch, configured, key, permitted,
 * any model, capability). So the host only LOADS state with {@link KvoxTaskModelSource.load}, and
 * the pure choosing (`chooseTaskModel` and the reason ordering) runs in the
 * package on it, identically on every host. {@link KvoxTaskModelSource.resolve} is the sketch's
 * convenience, optional, for a host's own use: `createKvoxAi` reads {@link KvoxTaskModelSource.load} only.
 *
 * @extensionPoint
 * @stability experimental
 */
export interface KvoxTaskModelSource {
  /**
   * The policy, the active provider and its enabled models. A host may cache
   * (the web resolver keeps a read for five seconds).
   *
   * @param userId - the user the call is for (no host reads per-user state today; the parameter keeps it possible).
   * @returns the state, never `null` (an AI that is off is `provider: null`).
   */
  load(userId: string): Promise<KvoxAiModelState>;

  /**
   * Which provider, model and effort serve a task for this user, or `null` when
   * none can.
   *
   * @param userId - the user the call is for.
   * @param task - the connected-knowledge task or the feature.
   * @returns the target, or `null`.
   */
  resolve?(userId: string, task: AiTaskKey | KvoxAiFeatureId): Promise<KvoxTaskModelTarget | null>;
}

/**
 * What one model can do, as a catalog knows it.
 *
 * @stability experimental
 */
export interface KvoxModelInfo {
  /** The provider's model id. */
  id: string;
  /** The context window in tokens; `null` when unknown (the port floors it). */
  contextWindow: number | null;
  /** The output ceiling in tokens; `null` when unknown (the port floors it). */
  maxOutputTokens: number | null;
  /** Whether the model honours strict structured output. */
  structuredOutput: boolean;
  /** Whether the model can call tools. */
  toolCalling: boolean;
  /** How `generateStructured` holds the model to a schema (#581). Absent means `native`. */
  structuredOutputMode?: KvoxStructuredOutputMode;
}

/**
 * Context window, output ceiling and capability flags per model, for a host
 * that knows more about a model than its {@link KvoxTaskModelSource} carries
 * (Desktop with a bundled catalog). Optional: the web edition's task source
 * already carries every number.
 *
 * @extensionPoint
 * @stability experimental
 */
export interface KvoxModelCatalog {
  /**
   * What `model` of `provider` can do, or `null` when the catalog does not know it.
   *
   * @param provider - the provider id.
   * @param model - the model id.
   * @returns the model's description, or `null`.
   */
  lookup(provider: string, model: string): KvoxModelInfo | null;
}
