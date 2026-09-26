// =============================================================================
// Graph conflict reasons (#354, epic #344, docs/specs/ontology.md)
// =============================================================================
//
// The `details.reason` strings a 409 from any graph route carries. They travel
// as `throw new ConflictException({ message, details: { reason } })` — the
// `NOTE_CONFLICT_REASONS` pattern (`notes/dto/note.dto.ts`) — because the
// global exception filter ignores a custom `code`, so `details.reason` is the
// only field a client can branch on.
//
// ⚠ APPEND-ONLY. A reason string is a wire contract a client branches on;
// renaming one silently breaks every client that knew the old spelling. Later
// issues append exactly the reasons they introduce and no others:
//   - `note_not_ready` (#363)
//   - `proposal_not_committed`, `stale_segment_rev` (#366)
//   - `graph_empty` (#386)
//
// The four AI reasons (`graph_disabled`, `ai_not_configured`, `ai_key_missing`,
// `model_lacks_capability`) are owned by #360's `AI_CONFLICT_REASONS` and
// repeated here with IDENTICAL strings; #360 adds the equality test. Ask's
// `ask_turn_running` lives in #376's `ASK_CONFLICT_REASONS`, not here.
// =============================================================================

export const GRAPH_CONFLICT_REASONS = {
  /** The deployment has switched connected knowledge off (`ai.graphEnabled`). */
  GRAPH_DISABLED: 'graph_disabled',
  /** The deployment has not enabled AI, or permits no model this build can run. */
  AI_NOT_CONFIGURED: 'ai_not_configured',
  /** The caller has saved no API key. Graph AI runs on their own account. */
  AI_KEY_MISSING: 'ai_key_missing',
  /** An extraction is already running for this source. */
  EXTRACTION_RUNNING: 'extraction_running',
  /** The proposal has already left `draft` (committed, discarded, failed…). */
  PROPOSAL_NOT_DRAFT: 'proposal_not_draft',
  /** The note changed since the proposal was extracted from it. */
  STALE_NOTE_VERSION: 'stale_note_version',
  /** A later change touches what a revert would undo. */
  REVERT_CONFLICT: 'revert_conflict',
  /** The resolved model cannot do what this task needs (e.g. structured output). */
  MODEL_LACKS_CAPABILITY: 'model_lacks_capability',
  /** The note is not `ready` (still generating, failed, …) — #363. */
  NOTE_NOT_READY: 'note_not_ready',
  /** A revert of a proposal that is not (or no longer) `committed` — #366. */
  PROPOSAL_NOT_COMMITTED: 'proposal_not_committed',
  /** An evidence span names a segment `rev` that has moved on since — #366. */
  STALE_SEGMENT_REV: 'stale_segment_rev',
} as const;

export type GraphConflictReason =
  (typeof GRAPH_CONFLICT_REASONS)[keyof typeof GRAPH_CONFLICT_REASONS];
