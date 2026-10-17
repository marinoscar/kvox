import { KVOX_EMBEDDING, KVOX_EMBEDDING_PROVIDER } from '../embedding/index.js';
import { KVOX_EMBEDDING_FEATURES, KVOX_FEATURE_TASK, type KvoxAiFeatureId } from '../features/index.js';
import type { KvoxAiModelState, KvoxAiRuntime, KvoxModelCatalog, KvoxTaskModelSource } from '../runtime/index.js';
import { chooseTaskModel, toPlatformReasoningEffort, type PlatformReasoningEffort } from '../tasks/index.js';
import type { KvoxAiReadiness, KvoxAiReason, KvoxReasoningEffort } from '../types/index.js';

// =============================================================================
// Readiness and reasoning effort, over the host's model state (issue #579)
// =============================================================================
//
// "Can this user run this feature, and on what?" answered ONCE for every host,
// from two host answers: the task-model state (`KvoxTaskModelSource.load`: the
// policy, the active provider and its enabled models) and whether a key exists
// (`KvoxAiRuntime.readiness`). Moved from `PlatformKvoxAi.readiness()` and
// `effortFor()` (`apps/api/src/ai-port/platform-kvox-ai.ts`), unchanged.
//
// THE REASON ORDER is the product's, as the retired resolver had it: graph switch,
// configured, key, permitted, any model, capability. A caller (the onboarding
// checklist, the port's `resolveTask`, the graph's run resolver) branches on the
// FIRST reason, so the order is behaviour.
//
// ⚠ NEVER THE KEY. `hasKey` is the runtime's existence answer; nothing here reads,
// holds or returns a credential.
// =============================================================================

/**
 * The conservative context window for a model whose row carries no number.
 *
 * @stability experimental
 */
export const FLOOR_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * The conservative output ceiling for a model whose row carries no number.
 *
 * @stability experimental
 */
export const FLOOR_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Derives the readiness of `feature` from the model state and the key answer.
 * Pure.
 *
 * @remarks
 * Per feature:
 * - an embedding feature: the catalog embeddings model (the catalog, not the
 *   policy, picks it); not configured without a provider, else the key;
 * - a task feature (`graph_*`): `chooseTaskModel`, then the reasons in the
 *   product's order (graph switch, configured, key, permitted, any model,
 *   capability);
 * - a feature with no task (notes, name check): the requested model when it is
 *   enabled, else the default model.
 *
 * The token numbers are the model's OWN (what `computeTokenBudget` takes): the
 * row's, else the catalog's, else the floors. They are null only when there is no
 * model, or for an embeddings model.
 *
 * @param input - the state, the feature, the per-run model pick, the key answer and an optional catalog.
 * @returns the readiness.
 * @stability experimental
 */
export function deriveReadiness(input: {
  state: KvoxAiModelState;
  feature: KvoxAiFeatureId;
  requested: string | null;
  hasKey: boolean;
  catalog?: KvoxModelCatalog;
}): KvoxAiReadiness {
  const { state, feature, hasKey } = input;
  const asked = input.requested;
  const notConfigured = state.provider === null || state.models.length === 0;
  const task = KVOX_FEATURE_TASK[feature];
  const embedding = KVOX_EMBEDDING_FEATURES.includes(feature);

  let model: string | null = null;
  let source: KvoxAiReadiness['source'] = 'none';
  let reasoningEffort: KvoxReasoningEffort = state.policy.reasoningEffort;
  let reason: KvoxAiReason | null = null;

  if (embedding) {
    // The catalog, not the policy, picks an embeddings model.
    model = KVOX_EMBEDDING.model;
    source = 'default';
    reason = state.provider === null ? 'ai_not_configured' : !hasKey ? 'ai_key_missing' : null;
  } else if (task !== null) {
    // Order, as the retired resolver had it: graph switch, configured, key,
    // permitted, any model, capability.
    const choice = chooseTaskModel({ policy: state.policy, models: state.models, task, requested: asked });
    model = choice.model;
    source = choice.source;
    reasoningEffort = choice.reasoningEffort;

    if (choice.problem === 'graph_disabled') reason = 'graph_disabled';
    else if (notConfigured) reason = 'ai_not_configured';
    else if (!hasKey) reason = 'ai_key_missing';
    else if (choice.problem === 'not_permitted') reason = 'model_not_permitted';
    else if (choice.problem === 'no_model' || choice.model === null) reason = 'ai_not_configured';
    else if (choice.problem === 'lacks_capability') reason = 'model_lacks_capability';
  } else {
    // No task: the requested model when enabled, else the default model.
    if (notConfigured) reason = 'ai_not_configured';
    else if (!hasKey) reason = 'ai_key_missing';

    const wanted = asked ?? state.policy.defaultModel;
    const enabled = wanted !== null && state.models.some((entry) => entry.id === wanted);
    if (enabled) {
      model = wanted;
      source = asked !== null ? 'requested' : 'default';
    } else if (reason === null) {
      reason = asked !== null ? 'model_not_permitted' : 'ai_not_configured';
      model = asked;
      source = asked !== null ? 'requested' : 'none';
    }
  }

  const row = model !== null ? state.models.find((entry) => entry.id === model) : undefined;
  const known =
    model !== null && state.provider !== null && input.catalog !== undefined
      ? input.catalog.lookup(state.provider, model)
      : null;

  return {
    ok: reason === null,
    reason,
    provider: state.provider,
    model,
    source,
    contextWindowTokens:
      model === null || embedding
        ? null
        : (row?.contextWindow ?? known?.contextWindow ?? FLOOR_CONTEXT_WINDOW_TOKENS),
    maxOutputTokens:
      model === null || embedding ? null : (row?.maxOutputTokens ?? known?.maxOutputTokens ?? FLOOR_MAX_OUTPUT_TOKENS),
    reasoningEffort,
    hasKey,
  };
}

/**
 * The wire reasoning effort for a call, or `undefined` to omit the parameter.
 * Pure.
 *
 * @remarks
 * A caller's own effort (`override`, the target's) wins and needs no state; an
 * embedding feature never reasons. Otherwise the effort is decided with the same
 * chooser task-to-model choice uses: a task's own effort applies only when the
 * chosen model IS that task's configured model. `none` omits the parameter and
 * `xhigh` is clamped to `high` (`toPlatformReasoningEffort`).
 *
 * @param input - the feature, the per-run model pick, the caller's override and a state loader.
 * @returns the effort to send, or `undefined`.
 * @stability experimental
 */
export async function reasoningEffortFor(input: {
  feature: KvoxAiFeatureId;
  requested: string | null;
  override?: KvoxReasoningEffort;
  state: () => Promise<KvoxAiModelState>;
}): Promise<PlatformReasoningEffort | undefined> {
  if (KVOX_EMBEDDING_FEATURES.includes(input.feature)) return undefined;
  // A per-call override wins over the policy (`'none'` omits reasoning), and needs
  // no settings read.
  if (input.override !== undefined) return toPlatformReasoningEffort(input.override);

  const state = await input.state();
  const task = KVOX_FEATURE_TASK[input.feature];
  const effort: KvoxReasoningEffort =
    task === null
      ? state.policy.reasoningEffort
      : chooseTaskModel({ policy: state.policy, models: state.models, task, requested: input.requested }).reasoningEffort;

  return toPlatformReasoningEffort(effort);
}

/**
 * Answers the readiness of a feature for a user: the model it would run on, its
 * numbers, and the first reason it cannot run.
 *
 * @stability experimental
 */
export interface KvoxAiReadinessReader {
  /**
   * The readiness of `feature` for `userId`.
   *
   * @param userId - the user whose key would pay.
   * @param feature - the registered feature.
   * @param requested - a per-run model pick, or `null`.
   * @returns the readiness (a not-ready answer is a value, not a throw).
   */
  readiness(userId: string, feature: KvoxAiFeatureId, requested?: string | null): Promise<KvoxAiReadiness>;
}

/**
 * Builds the readiness reader `createKvoxAi` uses, over the host's task-model
 * source and runtime. A host that answers readiness elsewhere too (the web
 * onboarding checklist) builds ONE and passes it to `createKvoxAi`, so both
 * answer from the same code.
 *
 * @remarks
 * The key is asked of the active provider, or of the catalog embeddings provider
 * while none is active (the web edition's one provider either way).
 *
 * @param options - the runtime (key presence), the task-model source and an optional catalog.
 * @returns the reader.
 * @stability experimental
 */
export function createKvoxAiReadiness(options: {
  runtime: Pick<KvoxAiRuntime, 'readiness'>;
  taskModels: KvoxTaskModelSource;
  catalog?: KvoxModelCatalog;
}): KvoxAiReadinessReader {
  return {
    async readiness(userId, feature, requested) {
      const state = await options.taskModels.load(userId);
      // Existence only: the runtime never returns the key.
      const { hasKey } = await options.runtime.readiness({
        userId,
        feature,
        provider: state.provider ?? KVOX_EMBEDDING_PROVIDER,
      });
      return deriveReadiness({
        state,
        feature,
        requested: requested ?? null,
        hasKey,
        ...(options.catalog !== undefined ? { catalog: options.catalog } : {}),
      });
    },
  };
}
