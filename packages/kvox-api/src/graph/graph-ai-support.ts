import { ConflictException } from '@nestjs/common';

import { KvoxAiError, KvoxRateLimitError } from '../ports/index.js';
import { aiProviderThrottleKey } from '../core/index.js';

// =============================================================================
// What the graph needs from the AI port besides the call itself (issue #496, epic #491)
// =============================================================================
//
// The 409 a route answers an unready AI feature with, in the product's own words, and
// the translation from the port's single error type to the failure classes the graph's
// handlers branch on. A route and a job both go through here, so the sentences and the
// `details.reason` values (`graph_disabled`, `ai_not_configured`, `ai_key_missing`,
// `model_lacks_capability`) cannot drift apart.
//
// ⚠ NO KEY, NO PROMPT TEXT, NO PROVIDER OBJECT PASSES THROUGH HERE.
// =============================================================================

/** The connected-knowledge tasks that run through the AI port. @stability experimental */
export type GraphAiTask = 'graph.extract' | 'graph.adjudicate' | 'graph.digest';

/** The label each task is shown under, as the 409 sentences name it. @stability experimental */
export const GRAPH_AI_TASK_LABELS: Readonly<Record<GraphAiTask, string>> = {
  'graph.extract': 'Graph extraction',
  'graph.adjudicate': 'Entity matching',
  'graph.digest': 'Entity digest',
};

/** The `details.reason` values an unready AI feature answers with. @stability experimental */
export type GraphAiConflictReason =
  | 'graph_disabled'
  | 'ai_not_configured'
  | 'ai_key_missing'
  | 'model_lacks_capability';

/**
 * A 409 with `details.reason`, the shape every AI conflict of the product has always had.
 *
 * @stability experimental
 */
export class GraphAiConflict extends ConflictException {
  /** Why the feature cannot run. */
  readonly reason: GraphAiConflictReason;

  /**
   * @param reason - the `details.reason` value.
   * @param message - the sentence to show.
   * @param details - further detail merged next to the reason.
   */
  constructor(reason: GraphAiConflictReason, message: string, details: Record<string, unknown> = {}) {
    super({ message, details: { reason, ...details } });
    this.reason = reason;
  }
}

/** What a refusal calls the work, lower-cased mid-sentence. */
function lower(label: string): string {
  return label.toLowerCase();
}

/**
 * `graph_disabled`: the deployment's connected-knowledge switch is off.
 *
 * @returns the exception.
 * @stability experimental
 */
export function graphDisabledConflict(): GraphAiConflict {
  return new GraphAiConflict(
    'graph_disabled',
    'Connected knowledge is switched off for this deployment. An administrator can enable it in AI settings.',
  );
}

/**
 * `ai_not_configured`.
 *
 * @param label - what the work is called.
 * @returns the exception.
 * @stability experimental
 */
export function notConfiguredConflict(label: string): GraphAiConflict {
  return new GraphAiConflict(
    'ai_not_configured',
    `AI features are not configured for this deployment, so ${lower(label)} cannot run. An administrator can enable them in AI settings.`,
  );
}

/**
 * `ai_key_missing`.
 *
 * @param label - what the work is called.
 * @returns the exception.
 * @stability experimental
 */
export function keyMissingConflict(label: string): GraphAiConflict {
  return new GraphAiConflict(
    'ai_key_missing',
    `You have not saved an AI API key. ${label} runs on your own provider account, so it needs your key. Add one in your settings and try again.`,
  );
}

/**
 * `model_lacks_capability`, naming the task, the model and what it lacks.
 *
 * @param input - the label, task, model and the missing capabilities.
 * @returns the exception.
 * @stability experimental
 */
export function lacksCapabilityConflict(input: {
  /**
   * The label.
   */
  label: string;
  /**
   * The task.
   */
  task: string;
  /**
   * The model.
   */
  model: string;
  /**
   * The missing.
   */
  missing: readonly string[];
}): GraphAiConflict {
  return new GraphAiConflict(
    'model_lacks_capability',
    `The model "${input.model}" cannot be used for ${lower(input.label)}: it lacks ${input.missing.join(', ')}. Choose a model that supports it, or ask an administrator to change the task model.`,
    { task: input.task, model: input.model, missing: [...input.missing] },
  );
}

/**
 * The product's 409 for a model resolution the port refused, or the error itself when it
 * is not one of the three "feature cannot run" classes.
 *
 * @param error - what `resolveTask` threw.
 * @param task - the task that was being resolved.
 * @param model - the model the caller asked for, if any.
 * @returns the exception to throw.
 * @stability experimental
 */
export function refusalForResolution(error: unknown, task: GraphAiTask, model: string | null): Error {
  if (!(error instanceof KvoxAiError)) return error instanceof Error ? error : new Error(String(error));

  const label = GRAPH_AI_TASK_LABELS[task];

  switch (error.errorClass) {
    case 'key_missing':
      return keyMissingConflict(label);
    case 'capability':
      return lacksCapabilityConflict({ label, task, model: model ?? 'unknown', missing: ['structuredOutput'] });
    case 'not_configured':
      return notConfiguredConflict(label);
    default:
      return error;
  }
}

/**
 * Rethrows a provider rate limit as the queue's own deferral, on this user's bucket and
 * nobody else's. Anything else is left for the caller to classify.
 *
 * @param error - what a model call threw.
 * @param userId - the user whose own provider account the work spent.
 * @throws KvoxRateLimitError when `error` is a rate limit.
 * @stability experimental
 */
export function rethrowRateLimit(error: unknown, userId: string): void {
  if (error instanceof KvoxRateLimitError) throw error;

  if (error instanceof KvoxAiError && error.errorClass === 'rate_limit') {
    throw new KvoxRateLimitError(aiProviderThrottleKey(userId), error.retryAfterMs, error.message);
  }
}
