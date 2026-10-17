// =============================================================================
// GraphAiRun: what one connected-knowledge model call needs to know (issue #475)
// =============================================================================
//
// A job handler or service that calls a model used to receive an
// `AiModelResolution` from the retired task resolver: a provider object, the
// deployment policy and a token counter. It never needed the provider object;
// it needed these numbers, to size a budget, a row cap and an output ceiling
// BEFORE it spends the user's own key.
//
// `KvoxAi.readiness` answers the same questions (which model, how large a window,
// how much output, which effort, is there a key), and the `ai` namespace
// extension carries the two optional spend caps. `GraphAiRunResolver` folds both
// into this shape, so the prompt-planning code (`planExtraction`,
// `extractionBudget`, `extractionRowCaps`) keeps its arithmetic unchanged and only
// its input type moves.
//
// ⚠ NOTHING HERE HOLDS A KEY OR A PROVIDER OBJECT. The key is resolved by the
// platform at the moment of the call.
// =============================================================================

import type { KvoxAiTarget, KvoxReasoningEffort } from '../ports/index.js';

/**
 * The model's own limits.
 *
 * @stability experimental
 */
export interface GraphAiModelLimits {
  /** The context window, in tokens. */
  contextWindowTokens: number;
  /** The most output tokens the model can produce. */
  maxOutputTokens: number;
}

/**
 * The deployment's spend caps and default reasoning effort for one task.
 *
 * @stability experimental
 */
export interface GraphAiPolicy {
  /** The most input tokens a call may carry, or `null` for no cap. */
  maxInputTokens: number | null;
  /** The most output tokens a call may ask for, or `null` for no cap. */
  maxOutputTokens: number | null;
  /** The default reasoning effort. */
  reasoningEffort: KvoxReasoningEffort;
}

/**
 * The numbers a prompt is planned against.
 *
 * @stability experimental
 */
export interface GraphAiRun {
  /** The resolved model, as the AI port wants it back on the call. */
  target: KvoxAiTarget;
  /** The provider the call will run on (`openai` today). */
  providerId: string;
  /** The model the call will run on. */
  model: string;
  /** The effort this call will actually send. */
  reasoningEffort: KvoxReasoningEffort;
  /** The model's OWN context window and output ceiling, before any policy cap. */
  modelLimits: GraphAiModelLimits;
  /** The deployment's optional spend caps and default effort. */
  policy: GraphAiPolicy;
  /** The local token estimate, bound to this run's model. */
  countTokens: (text: string) => number;
  /**
   * Whether the caller has a key for this provider. Always `true` from a default
   * `resolve()`, which refuses otherwise; meaningful only for an estimate
   * (`requireKey: false`), which counts tokens without spending any.
   */
  keyConfigured: boolean;
  /** Which rank chose the model. */
  source: 'requested' | 'task' | 'default';
}
