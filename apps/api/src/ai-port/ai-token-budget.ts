// =============================================================================
// The token budget (issue #49, epic #45, docs/specs/notes.md §3.3)
// =============================================================================
//
// MOVED to `@marinoscar/kvox-api/core` (issue #490, epic #486): the pure arithmetic and
// its comments (refuse with a number, never truncate; the demand-driven output split)
// live there now, where the Ask, graph and transcripts slices import them without
// importing the notes slice.
//
// WHAT STAYS HERE is `assertWithinBudget`: the package throws its host-neutral
// `KvoxAiBudgetError`, while this app's job handlers classify failures by `AiBudgetError`
// (`ai-errors.ts`, a platform-aware domain error with `isDomainError`). The wrapper keeps
// that behaviour byte-for-byte: same refusal sentence, same counts, same error class.
// =============================================================================

import { budgetRefusalMessage } from '@marinoscar/kvox-api/core';

import { AiBudgetError } from './ai-errors';

export {
  OUTPUT_RESERVE_TOKENS,
  REASONING_HEADROOM_TOKENS,
  SAFETY_MARGIN_TOKENS,
  budgetRefusalMessage,
  computeTokenBudget,
  outputTokensForPrompt,
} from '@marinoscar/kvox-api/core';
export type { BudgetInput, TokenBudget } from '@marinoscar/kvox-api/core';

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
