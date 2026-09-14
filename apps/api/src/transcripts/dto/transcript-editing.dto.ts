// =============================================================================
// Correction request and response shapes (issue #27, epic #19)
// =============================================================================
//
// ZOD, NOT class-validator — see `transcript.dto.ts`'s header for the full
// reason. `app.module.ts` registers `ZodValidationPipe` as this application's
// single global `APP_PIPE` and never registers Nest's `ValidationPipe`, so a
// `class-validator` decorator here would be inert metadata and an op batch
// would reach the reducers COMPLETELY UNVALIDATED while looking validated.
//
// The op schemas themselves live in `../editing/ops.ts`, beside the reducers
// that execute them, rather than here: they are the permanent on-disk
// vocabulary of `transcript_versions.ops` (they are what `materialize()` parses
// back out of JSONB years later), not merely the shape of one HTTP body. This
// file is the envelope around them.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MAX_FIND_LENGTH, MAX_OPS_PER_BATCH, requestOpSchema } from '../editing/ops';
import { transcriptSegmentSchema, transcriptSpeakerSchema } from './transcript.dto';

// -----------------------------------------------------------------------------
// POST /api/transcripts/:id/operations
// -----------------------------------------------------------------------------

export const applyOperationsSchema = z.object({
  /**
   * The `currentVersion` this client last saw.
   *
   * ⚠ INFORMATIONAL, NOT A LOCK (spec §5). It may be stale by the time the
   * batch is applied and the batch still succeeds, because what actually
   * guards each write is the per-entity `rev` inside every op — which is
   * exactly what lets two editors correcting two DIFFERENT lines at the same
   * moment both succeed instead of one of them being told to start over.
   */
  baseVersion: z.number().int().nonnegative(),
  /**
   * The idempotency key for this exact batch.
   *
   * A client that saved successfully but never saw the response — a dropped
   * connection, a backgrounded tab — retries with the SAME value and gets the
   * ORIGINAL result back rather than a second version. Unique per transcript
   * (`transcript_versions`'s `@@unique([transcriptId, clientBatchId])`), so
   * generate a fresh one per batch and reuse it only for a retry of that
   * batch.
   */
  clientBatchId: z.string().trim().min(8).max(200),
  /** Up to 200 ops, applied in order, in one transaction (spec §4.1). */
  ops: z.array(requestOpSchema).min(1).max(MAX_OPS_PER_BATCH),
});

export type ApplyOperationsDto = z.infer<typeof applyOperationsSchema>;

export class ApplyOperationsBodyDto extends createZodDto(applyOperationsSchema) {}

/**
 * What a `speaker.merge` moved, so the correction UI can offer "Undo".
 *
 * The UI's undo restores `version − 1` when nothing newer exists and otherwise
 * sends inverse ops — and an inverse merge is "re-create these speakers, and
 * put exactly these segments back on them". The segment ids are the half of
 * that the client cannot reconstruct on its own once the merge has happened,
 * so the server hands them back with the result.
 */
export const mergeUndoSchema = z.object({
  targetId: z.string(),
  sources: z.array(
    z.object({
      speakerId: z.string(),
      label: z.string().nullable(),
      displayName: z.string(),
      colorIndex: z.number().int(),
      /** The segments that were on this speaker immediately before the merge. */
      segmentIds: z.array(z.string()),
    }),
  ),
});

export class MergeUndoDto extends createZodDto(mergeUndoSchema) {}

export const operationsResultSchema = z.object({
  /** The version this batch created — the transcript's new `currentVersion`. */
  version: z.number().int(),
  /** A human-readable description of what this version changed. */
  summary: z.string(),
  /** Whether this response replays an earlier, identical `clientBatchId`. */
  idempotentReplay: z.boolean(),
  speakers: z.array(transcriptSpeakerSchema),
  /** Every segment, in reading order, WITHOUT word timings — as `GET /:id/segments`. */
  segments: z.array(transcriptSegmentSchema),
  /** One entry per `speaker.merge` in the batch. Empty for every other batch. */
  merges: z.array(mergeUndoSchema),
});

export class OperationsResultDto extends createZodDto(operationsResultSchema) {}

/**
 * The `details` object of a 409 from `POST /:id/operations` (spec §5).
 *
 * ⚠ IT IS `details`, NOT THE WHOLE BODY. The global `HttpExceptionFilter`
 * publishes one error envelope for every operation in this API —
 * `{ statusCode, code, message, details }` — and reads nothing else off a
 * thrown payload. Spec §5 draws this object at the top level; putting it there
 * would have it silently dropped, so it travels in the one field the envelope
 * carries through verbatim.
 */
export const operationsConflictSchema = z.object({
  currentVersion: z.number().int(),
  conflicts: z.array(
    z.object({
      entity: z.enum(['segment', 'speaker']),
      id: z.string(),
      /** The entity's `rev` right now, or null when it has been deleted. */
      current: z.number().int().nullable(),
    }),
  ),
});

export class OperationsConflictDto extends createZodDto(operationsConflictSchema) {}

// -----------------------------------------------------------------------------
// GET /api/transcripts/:id/search
// -----------------------------------------------------------------------------

/** The most matches one search response will carry. `total` is still exact. */
export const MAX_SEARCH_MATCHES = 500;

export const transcriptSearchQuerySchema = z.object({
  q: z.string().min(1).max(MAX_FIND_LENGTH),
  // ⚠ `z.enum(['true','false']).transform(...)`, NEVER `z.coerce.boolean()`.
  // A query string arrives as text, and `Boolean('false')` is `true` — so the
  // coercing shortcut turns "the user explicitly turned case sensitivity OFF"
  // into "the user turned it on", silently, for exactly the callers who were
  // being explicit.
  matchCase: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  wholeWord: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  speakerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_MATCHES).optional(),
});

export type TranscriptSearchQueryDto = z.infer<typeof transcriptSearchQuerySchema>;

export class TranscriptSearchQueryParamsDto extends createZodDto(transcriptSearchQuerySchema) {}

export const transcriptSearchSchema = z.object({
  q: z.string(),
  matchCase: z.boolean(),
  wholeWord: z.boolean(),
  speakerId: z.string().nullable(),
  /** Every occurrence in the transcript, even when `matches` was truncated. */
  total: z.number().int(),
  /** How many segments carry at least one occurrence. */
  segmentCount: z.number().int(),
  /** True when `matches` is a prefix of the real result. */
  truncated: z.boolean(),
  matches: z.array(
    z.object({
      segmentId: z.string(),
      speakerId: z.string(),
      /** Where in the media this line is, so a hit can be played. */
      startMs: z.number().int(),
      /** Offsets into the segment's own text, in UTF-16 code units. */
      start: z.number().int(),
      end: z.number().int(),
      /** A short excerpt with the hit in it, for the results list. */
      preview: z.string(),
    }),
  ),
});

export class TranscriptSearchDto extends createZodDto(transcriptSearchSchema) {}

// -----------------------------------------------------------------------------
// GET /api/transcripts/:id/versions
// -----------------------------------------------------------------------------

export const transcriptVersionsQuerySchema = z.object({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type TranscriptVersionsQueryDto = z.infer<typeof transcriptVersionsQuerySchema>;

export class TranscriptVersionsQueryParamsDto extends createZodDto(
  transcriptVersionsQuerySchema,
) {}

export const transcriptVersionSummarySchema = z.object({
  version: z.number().int(),
  kind: z.enum(['ai_original', 'edit', 'restore']),
  summary: z.string().nullable(),
  /**
   * Who saved it, or **null meaning "the AI"** — the schema's own convention
   * (spec §4.5), not a missing value. Only the ingest handler ever leaves it
   * null, and only for version 1.
   */
  author: z
    .object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() })
    .nullable(),
  restoredFromVersion: z.number().int().nullable(),
  /** Whether this version can be materialized without replaying anything. */
  hasSnapshot: z.boolean(),
  opCount: z.number().int(),
  createdAt: z.string(),
});

export class TranscriptVersionSummaryDto extends createZodDto(transcriptVersionSummarySchema) {}

export const transcriptVersionsSchema = z.object({
  currentVersion: z.number().int(),
  items: z.array(transcriptVersionSummarySchema),
  nextCursor: z.string().nullable(),
});

export class TranscriptVersionsDto extends createZodDto(transcriptVersionsSchema) {}

// -----------------------------------------------------------------------------
// GET /api/transcripts/:id/versions/:v
// -----------------------------------------------------------------------------

export const transcriptVersionDetailSchema = transcriptVersionSummarySchema.extend({
  /** The transcript's `currentVersion`, so a client can tell how far back this is. */
  currentVersion: z.number().int(),
  speakers: z.array(transcriptSpeakerSchema),
  /**
   * The materialized segments, in reading order, WITHOUT word timings.
   *
   * Word arrays are excluded for exactly the reason `GET /:id/segments`
   * excludes them: they are the single largest thing in this schema, and a
   * history browser renders text.
   */
  segments: z.array(transcriptSegmentSchema),
});

export class TranscriptVersionDetailDto extends createZodDto(transcriptVersionDetailSchema) {}

// -----------------------------------------------------------------------------
// POST /api/transcripts/:id/versions/:v/restore
// -----------------------------------------------------------------------------

export const restoreVersionSchema = z.object({
  /**
   * The `currentVersion` this client last saw.
   *
   * ⚠ UNLIKE `POST /:id/operations`, THIS ONE MUST MATCH, and a stale value is
   * a 409. A correction batch carries a per-entity `rev` on every op, so a
   * stale `baseVersion` is harmless — the ops themselves say what they expect.
   * A restore carries no such thing: it replaces the ENTIRE current state with
   * an older one, so a client whose view is out of date is asking to discard
   * edits it has never seen. Refusing is the only answer that does not throw
   * away somebody else's work on the strength of a stale screen.
   */
  baseVersion: z.number().int().nonnegative(),
});

export type RestoreVersionDto = z.infer<typeof restoreVersionSchema>;

export class RestoreVersionBodyDto extends createZodDto(restoreVersionSchema) {}
