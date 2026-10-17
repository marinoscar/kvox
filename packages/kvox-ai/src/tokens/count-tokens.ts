// =============================================================================
// Local token estimate (issue #475, epic #472)
// =============================================================================
//
// The platform does not count tokens, and the note budget (`notes/generation/
// token-budget.ts`, docs/specs/notes.md §3.3) has always been checked against
// this estimate. It is moved here, unchanged, from the retired OpenAI provider so
// no budget moves. It is local: no network call, no model lookup.
//
// ⚠ IT ROUNDS UP AND TAKES THE LARGER OF TWO ESTIMATES, ON PURPOSE. A count that
// is too LOW lets an over-budget prompt through to the vendor, which rejects it
// after the user has been charged for the attempt; a count that is too HIGH
// costs a little headroom against a large window. Those are not symmetric
// mistakes, so this errs in the safe direction. The word-count term matters for
// text the characters-per-token rule is worst at: heavily punctuated transcript
// prose, CJK, code blocks.
//
// `model` is accepted because the `KvoxAi` contract promises a per-model answer
// and a future refinement belongs behind this signature; every enabled model
// shares one tokenizer family today, so it is deliberately unused.
// =============================================================================

/**
 * Average characters per token. FOUR is the well-known rule of thumb for English
 * prose under a BPE tokenizer.
  *
  * @stability experimental
 */
export const CHARS_PER_TOKEN = 4;

/**
 * An approximate token count for `text`. Zero for the empty string.
 *
 * @stability experimental
 */
export function countTokens(text: string, _model?: string): number {
  if (text.length === 0) return 0;

  const byChars = Math.ceil(text.length / CHARS_PER_TOKEN);
  const words = text.split(/\s+/).filter((word) => word.length > 0).length;

  return Math.max(byChars, words);
}
