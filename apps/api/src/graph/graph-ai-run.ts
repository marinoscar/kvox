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

import type { AiReasoningEffort } from '../ai-port/ai-task-keys';

/** The numbers a prompt is planned against. */
export interface GraphAiRun {
  /** The provider the call will run on (`openai` today). */
  providerId: string;
  /** The model the call will run on. */
  model: string;
  /** The effort this call will actually send. */
  reasoningEffort: AiReasoningEffort;
  /** The model's OWN context window and output ceiling, before any policy cap. */
  modelLimits: { contextWindowTokens: number; maxOutputTokens: number };
  /** The deployment's optional spend caps and default effort. */
  policy: {
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
    reasoningEffort: AiReasoningEffort;
  };
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
