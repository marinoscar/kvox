// =============================================================================
// The KVox domain error and reason catalogue (issue #488, epic #486)
// =============================================================================
//
// Before this file the reason strings a client branches on were scattered over
// eight constants in as many API files. Each of those constants still exists,
// under its original name and with the same values, in the slice that owns it
// (`GRAPH_CONFLICT_REASONS`, `NOTE_CONFLICT_REASONS`, `NAME_CHECK_CONFLICT_REASONS`,
// `ASK_CONFLICT_REASONS`, `ASK_FINISH_REASONS`, `PROPOSAL_BAD_REQUEST_REASONS`,
// `DIGEST_UNAVAILABLE_REASONS`, `GRAPH_IMPORT_FAILURE_REASONS`,
// `SEMANTIC_REASONS`, since #571 `TRANSCRIPT_IMPORT_FAILURE_REASONS`, and since #585
// `NOTE_IMPORT_FAILURE_REASONS`). This
// catalogue is the merged, de-duplicated view of them
// (`ai_not_configured` is named by five of those lists and appears here once),
// with the HTTP status the API answers each with. A spec
// (`test/errors-catalogue.test.ts`) asserts that every alias value is in the
// catalogue and that no code appears twice.
//
// ⚠ APPEND-ONLY. A code is a string a client branches on; renaming or removing
// one silently breaks every client that knew the old spelling.
//
// ⚠ THE CODES TRAVEL IN `details.reason`, NOT IN THE TOP-LEVEL `code`. The
// API's global exception filter derives `code` from the status and ignores any
// `code` an exception supplies (`apps/api/src/common/dto/error.dto.ts` publishes
// `code` as a closed enum), so `details.reason` is the field a client reads.
// =============================================================================

/**
 * The domain slices that own error codes.
 *
 * @stability experimental
 */
export type KvoxSlice = 'transcription' | 'transcripts' | 'search' | 'notes' | 'graph' | 'ask';

/**
 * One entry of {@link KVOX_ERROR_CODES}.
 *
 * @stability experimental
 */
export interface KvoxErrorCodeDef {
  /** The string on the wire. Equal to the entry's key. */
  code: string;
  /**
   * The HTTP status the API answers when it raises the code as an error. `200`
   * marks a reason that travels inside a successful response body (a degraded
   * search, an unavailable digest, a finish reason, a failed import's stored
   * `failureReason`) and never as an error response. A code that is both (for
   * example `ai_not_configured`, also reported as `semanticReason`) carries the
   * status of its error use.
   */
  status: 200 | 400 | 403 | 404 | 409 | 413 | 503;
  /** The slice that introduced the code. */
  slice: KvoxSlice;
  /** What it means to the person or client that receives it. */
  description: string;
}

/**
 * Every domain error and reason code, keyed by the code string itself.
 *
 * @remarks
 * Keep the per-slice constants (`NOTE_CONFLICT_REASONS` and the others) in step:
 * the catalogue spec fails when a value exists in one and not in the other.
 *
 * @stability experimental
 */
export const KVOX_ERROR_CODES = {
  // --- 409: conflicts -------------------------------------------------------
  ai_not_configured: {
    code: 'ai_not_configured',
    status: 409,
    slice: 'notes',
    description:
      'The deployment has not enabled AI, or permits no model this build can run. Also reported as `semanticReason` by search.',
  },
  ai_key_missing: {
    code: 'ai_key_missing',
    status: 409,
    slice: 'notes',
    description:
      'The caller has saved no API key. Domain AI runs on the caller\'s own account. Also reported as `semanticReason` and `digestUnavailable`.',
  },
  model_lacks_capability: {
    code: 'model_lacks_capability',
    status: 409,
    slice: 'graph',
    description: 'The resolved model cannot do what the task needs (structured output, tool calls).',
  },
  graph_disabled: {
    code: 'graph_disabled',
    status: 409,
    slice: 'graph',
    description: 'The deployment has switched connected knowledge off.',
  },
  stale_base_version: {
    code: 'stale_base_version',
    status: 409,
    slice: 'notes',
    description: 'A note write named a `baseVersion` that is no longer current; `details.currentVersion` says what is.',
  },
  already_current: {
    code: 'already_current',
    status: 409,
    slice: 'notes',
    description: 'A restore named the note version that is already current.',
  },
  template_required: {
    code: 'template_required',
    status: 409,
    slice: 'notes',
    description: 'The note\'s template was deleted; a regeneration needs one named.',
  },
  generating: {
    code: 'generating',
    status: 409,
    slice: 'notes',
    description: 'The note is being generated; a second writer is not available.',
  },
  derived_notes_exist: {
    code: 'derived_notes_exist',
    status: 409,
    slice: 'notes',
    description: 'Another note names this one as its source.',
  },
  deleting: {
    code: 'deleting',
    status: 409,
    slice: 'notes',
    description: 'The note is already on its way out.',
  },
  name_check_running: {
    code: 'name_check_running',
    status: 409,
    slice: 'transcripts',
    description: 'A name check is already running for this transcript.',
  },
  transcript_not_ready: {
    code: 'transcript_not_ready',
    status: 409,
    slice: 'transcripts',
    description: 'The transcript is not `ready` (still processing, failed, ...).',
  },
  extraction_running: {
    code: 'extraction_running',
    status: 409,
    slice: 'graph',
    description: 'An extraction is already running for this source.',
  },
  proposal_not_draft: {
    code: 'proposal_not_draft',
    status: 409,
    slice: 'graph',
    description: 'The proposal has already left `draft` (committed, discarded, failed, ...).',
  },
  stale_note_version: {
    code: 'stale_note_version',
    status: 409,
    slice: 'graph',
    description: 'The note changed since the proposal was extracted from it.',
  },
  revert_conflict: {
    code: 'revert_conflict',
    status: 409,
    slice: 'graph',
    description: 'A later change touches what a revert would undo.',
  },
  note_not_ready: {
    code: 'note_not_ready',
    status: 409,
    slice: 'graph',
    description: 'The note is not `ready` (still generating, failed, ...).',
  },
  proposal_not_committed: {
    code: 'proposal_not_committed',
    status: 409,
    slice: 'graph',
    description: 'A revert of a proposal that is not, or is no longer, `committed`.',
  },
  stale_segment_rev: {
    code: 'stale_segment_rev',
    status: 409,
    slice: 'graph',
    description: 'An evidence span names a transcript segment revision that has moved on since.',
  },
  graph_empty: {
    code: 'graph_empty',
    status: 409,
    slice: 'graph',
    description: 'An export of a graph with nothing readable in it.',
  },
  offer_decided: {
    code: 'offer_decided',
    status: 409,
    slice: 'graph',
    description: 'An import\'s attribute offer that was already accepted or rejected.',
  },
  ask_turn_running: {
    code: 'ask_turn_running',
    status: 409,
    slice: 'ask',
    description: 'The conversation already has an answer being written.',
  },

  // --- 400: requests invalid in themselves ----------------------------------
  span_mismatch: {
    code: 'span_mismatch',
    status: 400,
    slice: 'graph',
    description: 'The selected text does not match the source at those positions.',
  },
  span_outside_source: {
    code: 'span_outside_source',
    status: 400,
    slice: 'graph',
    description: 'An evidence span lies outside the source it names.',
  },
  would_orphan: {
    code: 'would_orphan',
    status: 400,
    slice: 'graph',
    description: 'The change would leave an accepted row with no evidence.',
  },
  not_json: {
    code: 'not_json',
    status: 400,
    slice: 'transcripts',
    description: 'A transcript import: the uploaded file is not UTF-8 JSON.',
  },
  unsupported_schema: {
    code: 'unsupported_schema',
    status: 400,
    slice: 'transcripts',
    description:
      'A transcript import: the file is JSON but not a `kvox.transcript/v1` document (a foreign file, or a later version).',
  },
  invalid_document: {
    code: 'invalid_document',
    status: 400,
    slice: 'transcripts',
    description:
      'A transcript import: the document fails the published schema, or holds a value a transcript cannot store; `details.issues` lists where.',
  },
  unknown_speaker: {
    code: 'unknown_speaker',
    status: 400,
    slice: 'transcripts',
    description: 'A transcript import: a segment names a speaker the file does not declare.',
  },
  duplicate_id: {
    code: 'duplicate_id',
    status: 400,
    slice: 'transcripts',
    description: 'A transcript import: two speakers, or two segments, share an id.',
  },
  empty_transcript: {
    code: 'empty_transcript',
    status: 400,
    slice: 'transcripts',
    description: 'A transcript import: the document holds no segments.',
  },
  not_text: {
    code: 'not_text',
    status: 400,
    slice: 'notes',
    description: 'A note import: the uploaded file is not UTF-8 text.',
  },
  invalid_front_matter: {
    code: 'invalid_front_matter',
    status: 400,
    slice: 'notes',
    description: 'A note import: the file opens a front matter block that is not closed or not `key: value` lines; `details.line` names the line.',
  },
  unsupported_note_format: {
    code: 'unsupported_note_format',
    status: 400,
    slice: 'notes',
    description: 'A note import: the front matter names a note format other than `kvox.note/v1`; `details.schema` echoes it.',
  },
  empty_note: {
    code: 'empty_note',
    status: 400,
    slice: 'notes',
    description: 'A note import: nothing is left once the front matter, title and provenance are read.',
  },

  // --- 200: reasons carried inside a successful response body ---------------
  embedding_unsupported: {
    code: 'embedding_unsupported',
    status: 200,
    slice: 'search',
    description: 'The active AI provider has no embeddings endpoint, so the vector arm did not run.',
  },
  no_indexed_content: {
    code: 'no_indexed_content',
    status: 200,
    slice: 'search',
    description: 'Nothing in the deployment has been embedded yet.',
  },
  embedding_failed: {
    code: 'embedding_failed',
    status: 200,
    slice: 'search',
    description: 'The provider refused, timed out, throttled or returned an unusable vector; the lexical ranking answered.',
  },
  embeddings_unavailable: {
    code: 'embeddings_unavailable',
    status: 200,
    slice: 'search',
    description: 'The host has no embeddings model, or one whose vectors are not 1536 wide, so the vector arm did not run.',
  },
  parse_error: {
    code: 'parse_error',
    status: 200,
    slice: 'graph',
    description: 'A graph import failed: the uploaded file did not parse (stored as the proposal\'s `failureReason`).',
  },
  too_large: {
    code: 'too_large',
    status: 200,
    slice: 'graph',
    description: 'A graph import failed: the file holds more triples or bytes than one import can take.',
  },
  ontology_version_newer: {
    code: 'ontology_version_newer',
    status: 200,
    slice: 'graph',
    description: 'A graph import failed: the file was written against a newer major ontology version.',
  },
  migration_pending: {
    code: 'migration_pending',
    status: 200,
    slice: 'graph',
    description: 'A graph import failed: an ontology migration the file needs has not run.',
  },
  shacl_violations: {
    code: 'shacl_violations',
    status: 200,
    slice: 'graph',
    description: 'A graph import failed: the file does not conform to the ontology; nothing was imported.',
  },
  empty: {
    code: 'empty',
    status: 200,
    slice: 'graph',
    description: 'A graph import failed: the file holds nothing the graph can take.',
  },
  stop: {
    code: 'stop',
    status: 200,
    slice: 'ask',
    description: 'Ask finish reason: the answer ended normally. Every other finish reason means "stopped early".',
  },
  step_cap: {
    code: 'step_cap',
    status: 200,
    slice: 'ask',
    description: 'Ask finish reason: the agent loop hit its step ceiling.',
  },
  token_cap: {
    code: 'token_cap',
    status: 200,
    slice: 'ask',
    description: 'Ask finish reason: the answer hit its token ceiling.',
  },
  time_cap: {
    code: 'time_cap',
    status: 200,
    slice: 'ask',
    description: 'Ask finish reason: the answer hit its time ceiling.',
  },
} as const satisfies Record<string, KvoxErrorCodeDef>;

/**
 * A code of {@link KVOX_ERROR_CODES}.
 *
 * @stability experimental
 */
export type KvoxErrorCode = keyof typeof KVOX_ERROR_CODES;

/**
 * Whether `value` is a code of {@link KVOX_ERROR_CODES}.
 *
 * @param value - Anything, typically a `details.reason` read off an error body.
 * @returns `true` when the catalogue defines the code.
 *
 * @stability experimental
 */
export function isKvoxErrorCode(value: unknown): value is KvoxErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KVOX_ERROR_CODES, value);
}
