// =============================================================================
// Transcript request and response shapes (issue #25, epic #19)
// =============================================================================
//
// ZOD, NOT class-validator, and that is not a style preference. `app.module.ts`
// registers `ZodValidationPipe` as this application's single global `APP_PIPE`
// and never registers Nest's `ValidationPipe`, so a `class-validator` decorator
// on a DTO here would be inert metadata: the body would reach the controller
// COMPLETELY UNVALIDATED while looking validated. `createZodDto` publishes the
// same schema to OpenAPI, so one definition serves the runtime check and the
// documentation at once — there is no second place for the two to disagree.
//
// -----------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT IN A RESPONSE
// -----------------------------------------------------------------------------
//
//   • `provider_job_id`. The vendor's own handle for this job. It is of no use
//     to a client, and publishing it hands anybody who can read a transcript a
//     stable identifier in a third party's system.
//   • `source_object_id` / `raw_result_object_id`. Storage ids for objects the
//     generic endpoints refuse to serve anyway (`managed_by`, §9.3). The one
//     object a client legitimately needs is reached through
//     `GET /:id/audio`, which signs a URL rather than naming a row.
//   • `provider_options`. It carries what was asked for, not what the user
//     needs to see; `language` and `speakersExpected` are surfaced as their own
//     fields where they matter.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `transcripts.status` — the top-level lifecycle (spec §1.1). */
export const TRANSCRIPT_STATUSES = [
  'uploading',
  'processing',
  'ready',
  'failed',
  'deleting',
] as const;

/** `transcription_status` — the provider round trip (spec §1.2). */
export const TRANSCRIPTION_STATUSES = [
  'waiting_input',
  'queued',
  'submitting',
  'submitted',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;

/** `playback_status` — the transcode sub-pipeline (spec §1.3). */
export const PLAYBACK_STATUSES = [
  'pending',
  'processing',
  'ready',
  'failed',
  'not_needed',
] as const;

/** How the caller reaches this transcript. */
export const TRANSCRIPT_ACCESS_ROLES = ['owner', 'editor', 'viewer'] as const;

/** Longest title this application will store. */
export const MAX_TITLE_LENGTH = 200;

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

/**
 * The file the browser is about to upload.
 *
 * ⚠ `size` IS THE CLIENT'S CLAIM, and every check in `POST /api/transcripts`
 * is made against it. That is not a trust decision — it is the only number
 * available before a single byte has moved, and refusing a 12 GB file before
 * the upload starts is the entire value of checking here. The REAL size is
 * enforced again when the multipart upload completes, where the bytes actually
 * exist; a client that lies here gets a rejected upload rather than a
 * transcription job it should not have had.
 */
export const transcriptSourceSchema = z.object({
  /** Original filename, used for the storage key's extension and the title. */
  name: z.string().trim().min(1).max(512),
  /** Byte length, as the browser reports it. See the note above. */
  size: z.number().int().positive(),
  /**
   * The browser's content type, which is frequently wrong or absent for audio.
   * Optional on purpose: `resolveMimeType` falls back to the extension, which
   * is the ordinary case for `.m4a` and `.amr` on several mobile platforms.
   */
  mimeType: z.string().trim().max(255).optional(),
});

export const createTranscriptSchema = z.object({
  /** Defaults to the source filename when omitted. */
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
  /**
   * Force a language rather than letting the provider detect one. Omitted or
   * null means "detect", which is what the provider is asked to do.
   */
  language: z.string().trim().min(2).max(16).nullable().optional(),
  /**
   * How many speakers to expect. A HINT the provider may bias diarization
   * with, never a constraint, and ignored entirely by a provider whose
   * `speakersExpectedHint` capability is false.
   */
  speakersExpected: z.number().int().min(1).max(50).nullable().optional(),
  source: transcriptSourceSchema,
});

export type CreateTranscriptDto = z.infer<typeof createTranscriptSchema>;

export class CreateTranscriptBodyDto extends createZodDto(createTranscriptSchema) {}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

/** One speaker, as every read surface reports them. */
export const transcriptSpeakerSchema = z.object({
  id: z.string(),
  /** The provider's own label (`"A"`), or null for a user-created speaker. */
  label: z.string().nullable(),
  displayName: z.string(),
  /** Stable index into the client's speaker palette. */
  colorIndex: z.number().int(),
  /** Per-entity optimistic-concurrency counter (spec §5). */
  rev: z.number().int(),
});

export class TranscriptSpeakerDto extends createZodDto(transcriptSpeakerSchema) {}

/** One word timing. Terse keys, because a long transcript has millions. */
export const transcriptWordSchema = z.object({
  /** The word itself. */
  t: z.string(),
  /** Start, milliseconds from the beginning of the media. */
  s: z.number(),
  /** End, milliseconds from the beginning of the media. */
  e: z.number(),
  /** Provider confidence 0..1, or null when it reported none. */
  c: z.number().nullable(),
});

export class TranscriptWordDto extends createZodDto(transcriptWordSchema) {}

/**
 * One segment, WITHOUT its words.
 *
 * The compact shape `GET /:id/segments` returns. Word timings are excluded
 * deliberately and are fetched per time window from `GET /:id/words`: a
 * six-hour recording's word arrays are the single largest thing in this
 * schema, and a segment list that carried them would be tens of megabytes for
 * a view that renders text.
 */
export const transcriptSegmentSchema = z.object({
  id: z.string(),
  speakerId: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  /** Gap-based float, so an insert needs no renumbering (spec §3.4). */
  ordinal: z.number(),
  text: z.string(),
  /** How much to trust this segment's word timings (spec §3.5). */
  wordsAlignment: z.enum(['exact', 'interpolated', 'none']),
  confidence: z.number().nullable(),
  origin: z.enum(['ai', 'user']),
  rev: z.number().int(),
  editedAt: z.string().nullable(),
});

export class TranscriptSegmentDto extends createZodDto(transcriptSegmentSchema) {}

/** A segment WITH its words, for the time-window endpoint. */
export const transcriptSegmentWordsSchema = z.object({
  segmentId: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  wordsAlignment: z.enum(['exact', 'interpolated', 'none']),
  words: z.array(transcriptWordSchema),
});

export class TranscriptSegmentWordsDto extends createZodDto(
  transcriptSegmentWordsSchema,
) {}

/** The list-row projection: everything a card needs, nothing more. */
export const transcriptListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(TRANSCRIPT_STATUSES),
  transcriptionStatus: z.enum(TRANSCRIPTION_STATUSES),
  playbackStatus: z.enum(PLAYBACK_STATUSES),
  language: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  speakerCount: z.number().int(),
  wordCount: z.number().int(),
  currentVersion: z.number().int(),
  failureReason: z.string().nullable(),
  /** How the CALLER reaches this row — not the owner's relationship to it. */
  access: z.enum(TRANSCRIPT_ACCESS_ROLES),
  /**
   * The owner's display name (issue #29).
   *
   * PRESENT ON EVERY ROW, not only shared ones, so a client never has to
   * branch on `access` to know whether the field is meaningful — on an owned
   * row it is simply the caller's own name. `"Shared with me"` renders it;
   * `"Mine"` ignores it.
   *
   * ONE FIELD, NOT AN EMBEDDED OWNER OBJECT: the name is the whole of what a
   * shared row needs, and a `{ id, email, imageUrl }` owner block would put the
   * beginnings of a user directory on a list every user can call. It resolves
   * `displayName` -> `providerDisplayName` -> the address, and the fallback to
   * the address is a deliberate, bounded choice — it is reached only for an
   * account that has never had a name, and only ever discloses the address of
   * somebody who has already chosen to share a private recording with this
   * exact caller. "Shared by (unknown)" on the one screen whose entire job is
   * to say who shared it would be worse.
   */
  ownerName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class TranscriptListItemDto extends createZodDto(transcriptListItemSchema) {}

/** `GET /api/transcripts` — cursor-paginated, newest first. */
export const transcriptListSchema = z.object({
  items: z.array(transcriptListItemSchema),
  /**
   * How many rows match the current filters, ignoring paging.
   *
   * THE FILTERS, NOT THE TABLE, and not "how many are left". It is counted over
   * the same predicate the page is read with, minus the keyset cursor clause,
   * so it is IDENTICAL on page one and on every `loadMore` for an unchanged
   * filter set — a client can render "42 transcripts" once and not watch the
   * number fall as the user pages.
   *
   * Counted rather than estimated: the predicate is already scoped to one
   * caller and covered by `(owner_id, updated_at desc)`, so this is an index
   * scan over that user's rows, and an approximation would be a worse answer
   * for no gain.
   */
  total: z
    .number()
    .int()
    .describe(
      'How many transcripts match the current filters, ignoring paging. Identical on every page of one ' +
        'filter set, so a client can render a result count that does not change as it pages.',
    ),

  /**
   * Opaque cursor for the next page, or null at the end.
   *
   * CURSOR, NOT PAGE NUMBER, because this list is ordered by `updatedAt` and
   * every pipeline transition rewrites that column: offset paging over a list
   * that reorders itself while a user scrolls skips rows and repeats others.
   */
  nextCursor: z.string().nullable(),
});

export class TranscriptListDto extends createZodDto(transcriptListSchema) {}

/** `GET /api/transcripts/:id` — the detail view. */
export const transcriptDetailSchema = transcriptListItemSchema.extend({
  speakers: z.array(transcriptSpeakerSchema),
  /** Which provider transcribed this. Named for the privacy notice (spec §10). */
  provider: z.string(),
  /** Whether the provider's own copy has been deleted (spec §10). */
  remoteDeletedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** Present on the source object, for a client sizing its upload UI. */
  sourceName: z.string(),
  sourceMimeType: z.string(),
  sourceSizeBytes: z.string(),
});

export class TranscriptDetailDto extends createZodDto(transcriptDetailSchema) {}

/** `GET /api/transcripts/:id/segments`. */
export const transcriptSegmentsSchema = z.object({
  /** Echoed so a client can pair a segment list with the version it belongs to. */
  currentVersion: z.number().int(),
  segments: z.array(transcriptSegmentSchema),
});

export class TranscriptSegmentsDto extends createZodDto(transcriptSegmentsSchema) {}

/** `GET /api/transcripts/:id/words`. */
export const transcriptWordsSchema = z.object({
  currentVersion: z.number().int(),
  fromMs: z.number().int(),
  toMs: z.number().int(),
  segments: z.array(transcriptSegmentWordsSchema),
});

export class TranscriptWordsDto extends createZodDto(transcriptWordsSchema) {}

/** `GET /api/transcripts/summary` — the home page's one request. */
export const transcriptSummarySchema = z.object({
  /** Everything still moving: `uploading` or `processing`, newest first. */
  inProgress: z.array(transcriptListItemSchema),
  /** The caller's own most recently touched transcripts, at most eight. */
  recent: z.array(transcriptListItemSchema),
  /** Transcripts other people shared with the caller, at most eight. */
  sharedWithMe: z.array(transcriptListItemSchema),
  counts: z.object({
    owned: z.number().int(),
    shared: z.number().int(),
    inProgress: z.number().int(),
    failed: z.number().int(),
  }),
});

export class TranscriptSummaryDto extends createZodDto(transcriptSummarySchema) {}

/** `GET /api/transcripts/:id/audio`. */
export const transcriptAudioSchema = z.object({
  /** Short-lived signed GET. Never a permanent link. */
  url: z.string(),
  /** Which file the URL points at: the rendition when ready, else the upload. */
  kind: z.enum(['playback', 'original']),
  mimeType: z.string(),
  expiresAt: z.string(),
});

export class TranscriptAudioDto extends createZodDto(transcriptAudioSchema) {}

// -----------------------------------------------------------------------------
// Write
// -----------------------------------------------------------------------------

/**
 * `PATCH /api/transcripts/:id`.
 *
 * ⚠ TITLE ONLY, AND IT IS NOT VERSIONED. A title is metadata about the
 * recording, not content of it: renaming a transcript does not change a single
 * word anybody said, so recording it as a `transcript_versions` row would put
 * a no-op in the edit history that a restore could later "undo" into a name
 * nobody chose. Content edits go through #28's op batches, which are versioned
 * precisely because they change what the transcript says.
 */
export const updateTranscriptSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
});

export type UpdateTranscriptDto = z.infer<typeof updateTranscriptSchema>;

export class UpdateTranscriptBodyDto extends createZodDto(updateTranscriptSchema) {}

// -----------------------------------------------------------------------------
// Query
// -----------------------------------------------------------------------------

/** `GET /api/transcripts` query string. */
export const transcriptListQuerySchema = z.object({
  /**
   * `owned` (the caller's own), `shared` (shared with them), or both.
   *
   * Defaults to `all`: a user's list is the list of transcripts they can open,
   * and splitting that by provenance is a filter, not the default view.
   */
  scope: z.enum(['owned', 'shared', 'all']).optional().default('all'),
  /**
   * Filter by TOP-LEVEL status only.
   *
   * Deliberately not by `transcription_status` or `playback_status`: those are
   * sub-pipeline detail, and filtering a list by one would require the caller
   * to know that top-level `processing` can mean either sub-pipeline, or both
   * (spec §1.4).
   */
  status: z.enum(TRANSCRIPT_STATUSES).optional(),
  /** Case-insensitive substring of the title. */
  q: z.string().trim().max(200).optional(),
  /** `nextCursor` from the previous page. */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type TranscriptListQueryDto = z.infer<typeof transcriptListQuerySchema>;

export class TranscriptListQueryParamsDto extends createZodDto(
  transcriptListQuerySchema,
) {}

/** `GET /api/transcripts/:id/words` query string. */
export const transcriptWordsQuerySchema = z
  .object({
    /** Window start, milliseconds. Defaults to the beginning. */
    fromMs: z.coerce.number().int().min(0).optional().default(0),
    /**
     * Window end, milliseconds. Defaults to a five-minute window from
     * `fromMs` — long enough to cover a player's look-ahead, short enough that
     * a careless client cannot ask for a six-hour recording's entire word
     * index in one response.
     */
    toMs: z.coerce.number().int().min(0).optional(),
  })
  .refine((value) => value.toMs === undefined || value.toMs > value.fromMs, {
    message: 'toMs must be greater than fromMs',
  });

export type TranscriptWordsQueryDto = z.infer<typeof transcriptWordsQuerySchema>;

export class TranscriptWordsQueryParamsDto extends createZodDto(
  transcriptWordsQuerySchema,
) {}

/** The default width of a `GET /:id/words` window when `toMs` is omitted. */
export const DEFAULT_WORDS_WINDOW_MS = 5 * 60_000;

/** The widest window one `GET /:id/words` call may ask for. */
export const MAX_WORDS_WINDOW_MS = 30 * 60_000;

// -----------------------------------------------------------------------------
// Create response
// -----------------------------------------------------------------------------

/**
 * `POST /api/transcripts` — the transcript AND the upload it is waiting for.
 *
 * ⚠ TWO OBJECTS IN ONE RESPONSE, ON PURPOSE. Creating a transcript and
 * beginning its upload are one user action ("transcribe this file") and two
 * rows, and a client that had to make two calls could get the first to succeed
 * and the second to fail — leaving a transcript in `uploading` with no
 * multipart upload behind it for `transcripts.housekeeping` to find and fail
 * later. One call, one 201, both rows, or neither.
 *
 * `upload` is exactly `InitUploadResponseDto`, restated structurally rather
 * than `$ref`-ed so this schema stays readable in the published document; the
 * two are checked against each other by `transcripts.service.ts`'s return type.
 */
export const createTranscriptResponseSchema = z.object({
  transcript: transcriptDetailSchema,
  upload: z.object({
    objectId: z.string(),
    uploadId: z.string(),
    partSize: z.number().int().positive(),
    totalParts: z.number().int().positive(),
    presignedUrls: z.array(
      z.object({
        partNumber: z.number().int().positive(),
        url: z.string(),
      }),
    ),
  }),
});

export class CreateTranscriptResponseDto extends createZodDto(
  createTranscriptResponseSchema,
) {}
