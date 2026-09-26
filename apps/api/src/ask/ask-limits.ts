// =============================================================================
// The Ask turn's caps (issue #378, epic #348; docs/specs/ontology.md §21.3)
// =============================================================================
//
// One place for every number that bounds what a single `ask.respond` turn may
// cost the user (their own AI key) and how long they wait. Each cap ends a turn
// with its BEST ANSWER and a `finish_reason` the client renders as "stopped
// early" — never with a failure.
// =============================================================================

export { ASK_TOOL_RESULT_MAX_TOKENS } from './tools/compact-result';

/** Model calls that may request tools. The call after the last one is forced with `toolChoice: 'none'`. */
export const ASK_MAX_TOOL_STEPS = 8;

/** Tool calls executed per step; extras are answered `ok: false` without running. */
export const ASK_MAX_TOOL_CALLS_PER_STEP = 4;

/** Earlier messages of the conversation replayed as history (before budget trimming). */
export const ASK_HISTORY_MESSAGES = 10;

/** Per model call; clamped to the model's (policy-narrowed) output ceiling. */
export const ASK_MAX_OUTPUT_TOKENS = 2000;

/** One model call's timeout (further narrowed by `ai.requestTimeoutMs` when that is shorter). */
export const ASK_CALL_TIMEOUT_MS = 60_000;

/** After this much wall clock, the next call is forced to answer (`time_cap`). */
export const ASK_WALL_CLOCK_SOFT_MS = 4 * 60_000;

/**
 * Text of one model call is held in memory until this many characters arrive
 * with no tool call — only then is it "the answer" and streamed into `content`.
 * Shorter preambles that precede a tool call ("Let me look that up…") never
 * reach the buffer.
 */
export const ASK_ANSWER_HOLD_CHARS = 64;

/** The `ask.respond` job's own runtime ceiling — also the lease, by derivation. */
export const ASK_RESPOND_MAX_RUNTIME_MS = 5 * 60_000;

/** `ask.respond` priority: someone is watching the answer stream. */
export const ASK_RESPOND_PRIORITY = -10;

/** A conversation title derived from the first question is at most this long. */
export const ASK_DERIVED_TITLE_MAX_CHARS = 80;
