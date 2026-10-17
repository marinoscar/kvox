// =============================================================================
// Importing a `kvox.transcript/v1` file (issue #571; docs/specs/transcription.md §8.2)
// =============================================================================
//
// `POST /api/transcripts/imports` takes the very file the JSON exporter writes and
// turns it back into a transcript: segments, speakers, speaker names and the
// recording date, with no audio and no transcription job.
//
// ⚠ THE ZOD SCHEMA BELOW MIRRORS `schemas/transcript-export.v1.schema.json` EXACTLY.
// Strict objects (`additionalProperties: false`) at every level, the same required
// lists, the same integer and range constraints. It is not a looser "what the
// importer happens to read": a file the published schema rejects is a file this
// schema rejects, and the reverse. `test/transcript-import.test.ts` proves the two
// agree (the schema's own example parses, the property and required lists match
// level by level, an extra property is refused at each level). When the JSON
// Schema gains a field (the rule is "a field is added, never removed or
// repurposed"), it is added here in the same change.
//
// What the JSON Schema CANNOT say (a segment's `speakerId` names a declared
// speaker, ids are unique, `endMs >= startMs`, at least one segment) is checked by
// the API package's parser after this schema passes, with its own reasons below.
// =============================================================================

import { z } from 'zod';

import { transcriptDetailSchema } from './transcript.js';

/**
 * The format identifier of a v1 transcript file: the `schema` field's only legal value
 * and the JSON Schema's title. Permanent (a v2 is a new identifier, never this one renumbered).
 *
 * @stability experimental
 */
export const TRANSCRIPT_DOCUMENT_V1_SCHEMA = 'kvox.transcript/v1';

/** The word-timing trust levels, as the JSON Schema's `wordsAlignment` enum lists them. */
const WORDS_ALIGNMENTS = ['exact', 'interpolated', 'none'] as const;

const offsetMs = z.number().int().min(0);
const confidence = z.number().min(0).max(1).nullable();
const dateTime = z.iso.datetime({ offset: true });

/**
 * One word timing of a v1 file (`transcript.segments[].words[]`).
 *
 * @stability experimental
 */
export const transcriptDocumentWordSchema = z.strictObject({
  text: z.string(),
  startMs: offsetMs,
  endMs: offsetMs,
  confidence: confidence.optional(),
});

/**
 * One segment of a v1 file.
 *
 * @stability experimental
 */
export const transcriptDocumentSegmentSchema = z.strictObject({
  id: z.string(),
  speakerId: z.string(),
  startMs: offsetMs,
  endMs: offsetMs,
  text: z.string(),
  confidence: confidence.optional(),
  wordsAlignment: z.enum(WORDS_ALIGNMENTS).optional(),
  words: z.array(transcriptDocumentWordSchema).optional(),
});

/**
 * One speaker of a v1 file.
 *
 * @stability experimental
 */
export const transcriptDocumentSpeakerSchema = z.strictObject({
  id: z.string(),
  displayName: z.string(),
  talkTimeMs: offsetMs.optional(),
});

/**
 * The `transcript` object of a v1 file.
 *
 * @stability experimental
 */
export const transcriptDocumentBodySchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  language: z.string().nullable(),
  durationMs: offsetMs,
  version: z.number().int().min(1),
  author: z
    .strictObject({
      displayName: z.string().optional(),
      email: z.email().optional(),
    })
    .nullable()
    .optional(),
  createdAt: dateTime,
  exportedAt: dateTime,
  recordedAt: dateTime.optional(),
  provider: z
    .strictObject({
      id: z.string().optional(),
      model: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  speakers: z.array(transcriptDocumentSpeakerSchema),
  segments: z.array(transcriptDocumentSegmentSchema),
});

/**
 * A whole `kvox.transcript/v1` file, the Zod twin of the published JSON Schema
 * (`@marinoscar/kvox-contract/schemas/transcript-export.v1.json`).
 *
 * @stability experimental
 */
export const transcriptDocumentV1Schema = z.strictObject({
  schema: z.literal(TRANSCRIPT_DOCUMENT_V1_SCHEMA),
  transcript: transcriptDocumentBodySchema,
});

/**
 * The parsed shape of {@link transcriptDocumentV1Schema}.
 *
 * @stability experimental
 */
export type TranscriptDocumentV1 = z.infer<typeof transcriptDocumentV1Schema>;

/**
 * The answer of `POST /api/transcripts/imports` (inside the `{ data }` envelope): the new
 * transcript exactly as `GET /api/transcripts/:id` returns it.
 *
 * @stability experimental
 */
export const transcriptImportResponseSchema = transcriptDetailSchema;

/**
 * The parsed shape of {@link transcriptImportResponseSchema}.
 *
 * @stability experimental
 */
export type TranscriptImportResponse = z.infer<typeof transcriptImportResponseSchema>;

/**
 * `details.reason` on a 400 from `POST /api/transcripts/imports`.
 *
 * ⚠ IN `details`, NOT THE TOP-LEVEL `code`: the host's exception filter derives `code`
 * from the status. Every value is in the error catalogue (`@marinoscar/kvox-contract/errors`).
 * Append-only.
 *
 * @stability experimental
 */
export const TRANSCRIPT_IMPORT_FAILURE_REASONS = {
  /** The file is not UTF-8 JSON at all. */
  NOT_JSON: 'not_json',
  /** JSON, but not a `kvox.transcript/v1` document (a foreign file, or a future version). */
  UNSUPPORTED_SCHEMA: 'unsupported_schema',
  /** A v1 document that fails the published schema or a value the import cannot store. */
  INVALID_DOCUMENT: 'invalid_document',
  /** A segment names a speaker the file does not declare. */
  UNKNOWN_SPEAKER: 'unknown_speaker',
  /** Two speakers, or two segments, share an id. */
  DUPLICATE_ID: 'duplicate_id',
  /** The document has no segments. */
  EMPTY_TRANSCRIPT: 'empty_transcript',
} as const;

/**
 * A value of {@link TRANSCRIPT_IMPORT_FAILURE_REASONS}.
 *
 * @stability experimental
 */
export type TranscriptImportFailureReason =
  (typeof TRANSCRIPT_IMPORT_FAILURE_REASONS)[keyof typeof TRANSCRIPT_IMPORT_FAILURE_REASONS];

/**
 * At most this many problems are listed in `details.issues` of an `invalid_document` 400.
 *
 * @stability experimental
 */
export const TRANSCRIPT_IMPORT_MAX_ISSUES = 20;

/**
 * One problem with an imported file: where it is (a dotted path into the document, `""` for
 * the root) and what is wrong.
 *
 * @stability experimental
 */
export const transcriptImportIssueSchema = z.object({
  path: z.string().describe('Dotted path into the document, e.g. `transcript.segments.3.endMs`.'),
  message: z.string().describe('What is wrong there.'),
});

/**
 * The `details` of a 400 from `POST /api/transcripts/imports`.
 *
 * @stability experimental
 */
export const transcriptImportErrorDetailsSchema = z.object({
  reason: z.enum([
    TRANSCRIPT_IMPORT_FAILURE_REASONS.NOT_JSON,
    TRANSCRIPT_IMPORT_FAILURE_REASONS.UNSUPPORTED_SCHEMA,
    TRANSCRIPT_IMPORT_FAILURE_REASONS.INVALID_DOCUMENT,
    TRANSCRIPT_IMPORT_FAILURE_REASONS.UNKNOWN_SPEAKER,
    TRANSCRIPT_IMPORT_FAILURE_REASONS.DUPLICATE_ID,
    TRANSCRIPT_IMPORT_FAILURE_REASONS.EMPTY_TRANSCRIPT,
  ]),
  issues: z
    .array(transcriptImportIssueSchema)
    .max(TRANSCRIPT_IMPORT_MAX_ISSUES)
    .optional()
    .describe('The first problems found, for `invalid_document`, `unknown_speaker` and `duplicate_id`.'),
  schema: z
    .string()
    .optional()
    .describe('For `unsupported_schema`: the `schema` value the file carries, when it carries a string.'),
});

/**
 * The parsed shape of {@link transcriptImportErrorDetailsSchema}.
 *
 * @stability experimental
 */
export type TranscriptImportErrorDetails = z.infer<typeof transcriptImportErrorDetailsSchema>;
