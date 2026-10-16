// =============================================================================
// AI name correction — request and response shapes (issues #328 and #330)
// =============================================================================
//
// ZOD, NOT class-validator — see `transcript.dto.ts`'s header: the global pipe
// is `ZodValidationPipe`, and a class-validator decorator here would be inert.
// =============================================================================

import { z } from 'zod';
import { transcriptSegmentSchema, transcriptSpeakerSchema } from './transcript.js';

/**
 * The most user-supplied terms one request may carry.
 *
 * @stability experimental
 */
export const MAX_NAME_CHECK_TERMS = 200;
/**
 * The longest single term.
 *
 * @stability experimental
 */
export const MAX_NAME_CHECK_TERM_LENGTH = 100;
/**
 * The most suggestions one apply/reject call may name.
 *
 * @stability experimental
 */
export const MAX_NAME_CHECK_DECISIONS = 1_000;

/**
 * `details.reason` on a 409 from `POST /:id/name-checks`.
 *
 * ⚠ IN `details`, NOT THE TOP-LEVEL `code` — the global `HttpExceptionFilter`
 * derives `code` from the status. The two AI reasons carry the same strings
 * `POST /api/notes` uses, so a client handles "not configured" and "no key"
 * once for both features.
 *
 * @stability experimental
 */
export const NAME_CHECK_CONFLICT_REASONS = {
  AI_NOT_CONFIGURED: 'ai_not_configured',
  AI_KEY_MISSING: 'ai_key_missing',
  NAME_CHECK_RUNNING: 'name_check_running',
  TRANSCRIPT_NOT_READY: 'transcript_not_ready',
} as const;

/**
 * Wire constant: name check modes.
 *
 * @stability experimental
 */
export const NAME_CHECK_MODES = ['standard', 'thorough'] as const;

// -----------------------------------------------------------------------------
// POST /api/transcripts/:id/name-checks
// -----------------------------------------------------------------------------

/**
 * Zod schema for the create name check wire shape.
 *
 * @stability experimental
 */
export const createNameCheckSchema = z.object({
  /**
   * `standard` checks phonetic candidates only; `thorough` (#330) also has the
   * model read the whole transcript for mis-hearings a phonetic key misses —
   * several times the tokens, on the caller's own account.
   */
  mode: z.enum(NAME_CHECK_MODES).default('standard'),
  /** Extra names and terms to check for, beyond speaker names and upload keyterms. */
  terms: z
    .array(z.string().trim().min(1).max(MAX_NAME_CHECK_TERM_LENGTH))
    .max(MAX_NAME_CHECK_TERMS)
    .optional(),
  /** Only these speakers' names are checked for. Default: every speaker. */
  speakerIds: z.array(z.string().uuid()).max(MAX_NAME_CHECK_TERMS).optional(),
});

/**
 * The parsed shape of {@link createNameCheckSchema}.
 *
 * @stability experimental
 */
export type CreateNameCheckDto = z.infer<typeof createNameCheckSchema>;

/**
 * Zod schema for the name check estimate query wire shape.
 *
 * @stability experimental
 */
export const nameCheckEstimateQuerySchema = z.object({
  mode: z.enum(NAME_CHECK_MODES).default('standard'),
});

/**
 * The parsed shape of {@link nameCheckEstimateQuerySchema}.
 *
 * @stability experimental
 */
export type NameCheckEstimateQueryDto = z.infer<typeof nameCheckEstimateQuerySchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

/**
 * Zod schema for the name check estimate wire shape.
 *
 * @stability experimental
 */
export const nameCheckEstimateSchema = z.object({
  /** Input tokens across every request, counted by the active provider's tokenizer. */
  inputTokens: z.number().int(),
  /** Provider requests, not counting retries. */
  requests: z.number().int(),
  /** Phonetic candidates to adjudicate. Thorough mode's own findings add to this. */
  candidates: z.number().int(),
});

/**
 * Zod schema for the name check run wire shape.
 *
 * @stability experimental
 */
export const nameCheckRunSchema = z.object({
  id: z.string(),
  transcriptId: z.string(),
  mode: z.enum(NAME_CHECK_MODES),
  status: z.enum(['pending', 'running', 'ready', 'failed']),
  /** The transcript version the check read. */
  basedOnVersion: z.number().int(),
  /** The names and terms checked for. */
  terms: z.array(z.string()),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  candidateCount: z.number().int(),
  suggestionCount: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** `auth` / `refusal` / `input` / `budget` / `other` when `failed`. */
  errorClass: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

/**
 * Zod schema for the create name check response wire shape.
 *
 * @stability experimental
 */
export const createNameCheckResponseSchema = z.object({
  run: nameCheckRunSchema,
  estimate: nameCheckEstimateSchema,
});

/**
 * Zod schema for the name suggestion wire shape.
 *
 * @stability experimental
 */
export const nameSuggestionSchema = z.object({
  id: z.string(),
  segmentId: z.string(),
  speakerId: z.string(),
  startMs: z.number().int(),
  /**
   * UTF-16 offsets into the segment's CURRENT text — relocated when the line
   * was edited since the check ran. The stored offsets when `stale`.
   */
  start: z.number().int(),
  end: z.number().int(),
  original: z.string(),
  replacement: z.string(),
  confidence: z.number().nullable(),
  reason: z.string().nullable(),
  /** `phonetic` or `discovery`. */
  source: z.string(),
  /** A short excerpt of the current line around the span. */
  preview: z.string(),
  /** The line no longer contains `original` at a unique position; applying it will skip it. */
  stale: z.boolean(),
});

/**
 * Zod schema for the name suggestion counts wire shape.
 *
 * @stability experimental
 */
export const nameSuggestionCountsSchema = z.object({
  pending: z.number().int(),
  accepted: z.number().int(),
  rejected: z.number().int(),
  stale: z.number().int(),
});

/**
 * Zod schema for the latest name check wire shape.
 *
 * @stability experimental
 */
export const latestNameCheckSchema = z.object({
  run: nameCheckRunSchema.nullable(),
  /** The run's PENDING suggestions, in reading order. */
  suggestions: z.array(nameSuggestionSchema),
  counts: nameSuggestionCountsSchema,
});

// -----------------------------------------------------------------------------
// Apply / reject
// -----------------------------------------------------------------------------

/**
 * Zod schema for the name check decision wire shape.
 *
 * @stability experimental
 */
export const nameCheckDecisionSchema = z.object({
  suggestionIds: z.array(z.string().uuid()).min(1).max(MAX_NAME_CHECK_DECISIONS),
});

/**
 * The parsed shape of {@link nameCheckDecisionSchema}.
 *
 * @stability experimental
 */
export type NameCheckDecisionDto = z.infer<typeof nameCheckDecisionSchema>;

/**
 * Zod schema for the apply name suggestions result wire shape.
 *
 * @stability experimental
 */
export const applyNameSuggestionsResultSchema = z.object({
  /** Suggestions written into the transcript. */
  applied: z.number().int(),
  /** Suggestions that could not be located in the current text and were marked stale. */
  stale: z.number().int(),
  /** The transcript's `currentVersion` after the apply. */
  version: z.number().int(),
  /** Every segment, as `POST /:id/operations` returns them. */
  segments: z.array(transcriptSegmentSchema),
  speakers: z.array(transcriptSpeakerSchema),
});

/**
 * Zod schema for the reject name suggestions result wire shape.
 *
 * @stability experimental
 */
export const rejectNameSuggestionsResultSchema = z.object({
  rejected: z.number().int(),
});
