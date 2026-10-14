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
//
// -----------------------------------------------------------------------------
// THE SPLIT IS DEMAND-DRIVEN, NOT A FIXED RESERVATION (issue #436)
// -----------------------------------------------------------------------------
//
// Before #436 the whole output ceiling was subtracted from the context window
// up front, and both ceilings were administrator-typed numbers every request
// was governed by. With `ai.maxOutputTokens` now `null` by default ("the
// model's own maximum"), that arithmetic would hand a 128,000-token output
// ceiling's worth of window to an answer that is rarely a tenth of that, and
// refuse a long source to pay for it. So the budget now holds back only a
// RESERVE (`OUTPUT_RESERVE_TOKENS`, or the ceiling when smaller) when sizing
// the input, and the output actually REQUESTED for one call shrinks to what
// the window has left once THIS prompt is known — `outputTokensForPrompt`. A
// call site whose prompt can be large must send that, never
// `budget.maxOutputTokens` as it stands.
//
// A typed `ai.maxOutputTokens` is a SPEND CAP on the answer. Reasoning tokens
// are output tokens drawn from the same `max_completion_tokens`, so the
// headroom the call's reasoning effort needs (`REASONING_HEADROOM_TOKENS`) is
// added ON TOP of that cap — bounded by the model's own maximum — rather than
// letting a raised effort silently eat the answer's share.
// =============================================================================

import type { AiReasoningEffort } from '../../ai/ai-settings.schema';
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

/**
 * Extra output tokens a call at each reasoning effort may spend thinking,
 * added on top of a finite answer ceiling (issue #436). `none` sends no
 * `reasoning_effort` at all, so it needs none.
 */
export const REASONING_HEADROOM_TOKENS: Readonly<Record<AiReasoningEffort, number>> = {
  none: 0,
  low: 4_096,
  medium: 16_384,
  high: 32_768,
  xhigh: 65_536,
};

/**
 * The most of the context window held back for the answer when sizing the
 * INPUT allowance (issue #436). The completion actually requested for a given
 * prompt is then whatever the window has left — see {@link outputTokensForPrompt}.
 */
export const OUTPUT_RESERVE_TOKENS = 32_768;

/** The numbers a budget is computed from. */
export interface BudgetInput {
  /** `AiModelDescriptor.contextWindowTokens` for the model being used. */
  contextWindowTokens: number;
  /** `AiModelDescriptor.maxOutputTokens` for that model. */
  modelMaxOutputTokens: number;
  /**
   * `ai.maxOutputTokens` — the deployment's spend cap on one answer, or `null`
   * for "no deployment cap: the model's own maximum".
   */
  policyMaxOutputTokens: number | null;
  /**
   * `ai.maxInputTokens` — the deployment's spend cap on one assembled prompt,
   * or `null` for "the model's own window".
   */
  policyMaxInputTokens: number | null;
  /** A per-task clamp on the answer (e.g. `ASK_MAX_OUTPUT_TOKENS`). */
  taskMaxOutputTokens?: number;
  /** The reasoning effort THIS call will actually send. */
  reasoningEffort?: AiReasoningEffort | null;
}

/** What a budget computation answers. */
export interface TokenBudget {
  /** Tokens available for the assembled prompt. Never negative. */
  availableInputTokens: number;
  /**
   * The completion ceiling for this model under this policy. A call whose
   * prompt can be large sends {@link outputTokensForPrompt} instead.
   */
  maxOutputTokens: number;
  /** The model's context window the budget was computed against. */
  contextWindowTokens: number;
  /** Which bound decided `maxOutputTokens`. */
  outputSource: 'policy' | 'task' | 'model';
  /** Which bound decided `availableInputTokens`. */
  inputSource: 'policy' | 'model';
}

/**
 * How many tokens the prompt may use, and how many the completion may.
 *
 * ⚠ A TYPED CEILING NARROWS, NEVER WIDENS. `ai.maxInputTokens` sits UNDER the
 * model's own window: it exists because the user pays for input tokens on
 * their own account and an operator should be able to bound a 200,000-token
 * transcript costing them several dollars per regeneration. `null` (the
 * default since #436) means the model's own capacity governs.
 */
export function computeTokenBudget(input: BudgetInput): TokenBudget {
  const policyOut = input.policyMaxOutputTokens ?? Infinity;
  const taskOut = input.taskMaxOutputTokens ?? Infinity;
  const answerCeiling = Math.min(policyOut, taskOut);

  let outputCeiling: number;
  let outputSource: TokenBudget['outputSource'];
  if (Number.isFinite(answerCeiling)) {
    const withHeadroom =
      answerCeiling + REASONING_HEADROOM_TOKENS[input.reasoningEffort ?? 'none'];
    if (withHeadroom < input.modelMaxOutputTokens) {
      outputCeiling = withHeadroom;
      outputSource = taskOut <= policyOut ? 'task' : 'policy';
    } else {
      outputCeiling = input.modelMaxOutputTokens;
      outputSource = 'model';
    }
  } else {
    outputCeiling = input.modelMaxOutputTokens;
    outputSource = 'model';
  }

  const outputReserve = Math.min(outputCeiling, OUTPUT_RESERVE_TOKENS);
  const fromModel =
    input.contextWindowTokens - outputReserve - SAFETY_MARGIN_TOKENS;
  const policyIn = input.policyMaxInputTokens ?? Infinity;
  const inputSource: TokenBudget['inputSource'] =
    policyIn < fromModel ? 'policy' : 'model';

  return {
    availableInputTokens: Math.max(0, Math.min(fromModel, policyIn)),
    maxOutputTokens: Math.max(0, outputCeiling),
    contextWindowTokens: input.contextWindowTokens,
    outputSource,
    inputSource,
  };
}

/**
 * The completion to request for a prompt of `promptTokens`: the budget's
 * ceiling, shrunk to what the context window has left once the prompt is in
 * it (issue #436). Never negative.
 */
export function outputTokensForPrompt(
  budget: TokenBudget,
  promptTokens: number,
): number {
  return Math.max(
    0,
    Math.min(
      budget.maxOutputTokens,
      budget.contextWindowTokens - promptTokens - SAFETY_MARGIN_TOKENS,
    ),
  );
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
