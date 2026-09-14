// =============================================================================
// The token budget (issue #49, epic #45, docs/specs/notes.md §3.3)
// =============================================================================
//
// PURE, for the same reason `prompt.ts` is: this runs once inside
// `POST /api/notes` (#53) and again inside `note.generate`, and the two must
// reach the same number from the same inputs or a note is refused in one place
// and generated in the other.
//
// -----------------------------------------------------------------------------
// IT REFUSES WITH A NUMBER. IT NEVER TRUNCATES.
// -----------------------------------------------------------------------------
//
// Cutting an over-budget source down to whatever fits and generating anyway is
// the obvious alternative and the one §3.3 exists to forbid: a note confidently
// summarising the first third of a meeting READS EXACTLY LIKE a note
// summarising the meeting. There is no marker in the output, nothing for a
// reader to notice, and the failure is therefore invisible — which is the
// precise opposite of "AI proposes, the user controls the truth". A user told
// "this source is about 14,200 tokens and 11,500 are available" can act on it:
// a shorter template, a shorter source, a bigger-context model. A user handed a
// fluent, wrong note cannot act on anything, because they do not know.
//
// That is why `AiBudgetError` takes the two counts as CONSTRUCTOR ARGUMENTS
// rather than optional extras, and why this module's job is to produce the
// sentence rather than a boolean.
// =============================================================================

import { AiBudgetError } from '../../ai/ai-errors';

/**
 * Tokens held back for the framing a provider adds beyond the literal text —
 * role wrappers, message delimiters, the handful of tokens every chat request
 * costs before any content.
 *
 * FIXED AT 500 (spec §3.3) and deliberately generous relative to
 * `countTokens`'s own approximation: being slightly conservative costs a few
 * tokens of headroom, while being slightly optimistic costs a provider-side
 * rejection AFTER the user has been billed for the request.
 */
export const SAFETY_MARGIN_TOKENS = 500;

/** The numbers a budget is computed from. All four are already policy-narrowed. */
export interface BudgetInput {
  /** `AiModelDescriptor.contextWindowTokens` for the model being used. */
  contextWindowTokens: number;
  /** `AiModelDescriptor.maxOutputTokens` for that model. */
  modelMaxOutputTokens: number;
  /** `ai.maxOutputTokens` — the deployment's ceiling on one completion. */
  policyMaxOutputTokens: number;
  /** `ai.maxInputTokens` — the deployment's ceiling on one assembled prompt. */
  policyMaxInputTokens: number;
}

/** What a budget computation answers. */
export interface TokenBudget {
  /** Tokens available for the assembled prompt. Never negative. */
  availableInputTokens: number;
  /** Tokens the completion may use — what `AiGenerateRequest` is given. */
  maxOutputTokens: number;
}

/**
 * How many tokens the prompt may use, and how many the completion may.
 *
 * ⚠ THE SMALLER OF THE TWO CEILINGS, ALWAYS. `ai.maxInputTokens` is a
 * DEPLOYMENT ceiling that sits under the model's own context window, never over
 * it — it exists because the user pays for input tokens on their own account
 * and an operator should be able to bound a 200,000-token transcript costing
 * them several dollars per regeneration. Taking the model's window when the
 * policy is lower would silently discard that lever; taking the policy when the
 * model is smaller would produce a prompt the vendor rejects.
 */
export function computeTokenBudget(input: BudgetInput): TokenBudget {
  const maxOutputTokens = Math.max(
    0,
    Math.min(input.modelMaxOutputTokens, input.policyMaxOutputTokens),
  );

  const fromModel =
    input.contextWindowTokens - maxOutputTokens - SAFETY_MARGIN_TOKENS;

  return {
    availableInputTokens: Math.max(
      0,
      Math.min(fromModel, input.policyMaxInputTokens),
    ),
    maxOutputTokens,
  };
}

/**
 * The sentence a refused generation is explained with.
 *
 * Separate from the throw so the request-time check (#53, a `400`) and the
 * job-time check (a `failed` note) tell the user the SAME thing in the same
 * words — the failure is identical and the two surfaces differ only in how it
 * is delivered.
 */
export function budgetRefusalMessage(input: {
  promptTokens: number;
  availableInputTokens: number;
  model: string;
}): string {
  return (
    `This source is approximately ${input.promptTokens.toLocaleString('en-US')} tokens; ` +
    `${input.model} allows ${input.availableInputTokens.toLocaleString('en-US')} for input ` +
    'with this template and output length. Choose a shorter source, a shorter template, ' +
    'or a model with a larger context window.'
  );
}

/**
 * Throw `AiBudgetError` when the assembled prompt does not fit.
 *
 * ⚠ CALLED BEFORE THE PROVIDER, NEVER DURING. The whole value of this check is
 * that it costs the user nothing: once a request has been made, the input
 * tokens are billed whether or not the completion is any good.
 */
export function assertWithinBudget(input: {
  promptTokens: number;
  availableInputTokens: number;
  model: string;
  providerId: string;
}): void {
  if (input.promptTokens <= input.availableInputTokens) return;

  throw new AiBudgetError(
    budgetRefusalMessage(input),
    input.promptTokens,
    input.availableInputTokens,
    input.providerId,
  );
}
