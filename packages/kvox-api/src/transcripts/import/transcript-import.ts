import {
  MAX_SPEAKER_NAME,
  MAX_TITLE_LENGTH,
  TRANSCRIPT_DOCUMENT_V1_SCHEMA,
  TRANSCRIPT_IMPORT_FAILURE_REASONS,
  TRANSCRIPT_IMPORT_MAX_ISSUES,
  transcriptDocumentV1Schema,
  type TranscriptDocumentV1,
  type TranscriptImportFailureReason,
} from '@marinoscar/kvox-contract/transcripts';

import { ORDINAL_GAP } from '../editing/ordinals.js';
import { defaultSpeakerName } from '../editing/speaker-identity.js';
import type { WordsAlignmentValue } from '../editing/editing-state.js';
import {
  countSegmentWords,
  type OriginalSegmentInput,
  type OriginalSpeakerInput,
} from '../original-version.js';

// =============================================================================
// The JSON import's pure half (issue #571; docs/specs/transcription.md §8.2)
// =============================================================================
//
// `parseTranscriptImport` turns the uploaded bytes into a validated
// `kvox.transcript/v1` document or a typed failure; `planTranscriptImport` maps
// that document onto the rows a transcript is made of. Neither touches the
// database, the clock (the caller passes `now`) or a random source, so the web
// edition, KVox Desktop and the conformance kit all parse and plan a file the
// same way. `TranscriptImportService` is the half that writes.
//
// THE ORDER OF THE CHECKS IS THE ORDER A CLIENT CAN ACT ON THEM:
//   1. `not_json`            the bytes are not UTF-8 JSON.
//   2. `unsupported_schema`  JSON, but not ours: no `schema` field, or another
//                            value (a foreign export, or a `kvox.transcript/v2`
//                            this build does not read). Checked BEFORE the shape,
//                            so a v2 file is "upgrade KVox", never 40 issues.
//   3. `invalid_document`    a v1 document the published schema rejects, or a
//                            value no transcript can hold (an offset past what an
//                            int4 column stores, `endMs < startMs`, a recording
//                            date before 1970 or in the future, a speaker name
//                            longer than a rename accepts).
//   4. `duplicate_id`        two speakers, or two segments, with one id.
//   5. `unknown_speaker`     a segment naming an undeclared speaker.
//   6. `empty_transcript`    no segments: nothing to read, note or link.
//
// SPEAKERS. A file speaker whose name is still a placeholder (`Speaker A`, the
// exact spelling `defaultSpeakerName` produces) becomes an unidentified speaker
// with that label, exactly what ingest writes. A speaker with a real name gets the
// next free letter as its label, the name as its display name, and an entry in
// `speaker_identities`: the state naming "Speaker C" as that person through the
// API leaves behind (§4.6), so the graph's speaker link treats it the same way.
// =============================================================================

/**
 * `transcripts.provider` of an imported transcript. Never a provider id in the
 * transcription registry, so nothing tries to submit, poll or delete it remotely
 * (`provider_job_id` stays null); the export reports it as the provider id.
 *
 * @stability experimental
 */
export const TRANSCRIPT_IMPORT_PROVIDER = 'import';

/**
 * Whether a transcript with this `provider` has a recording (#571).
 *
 * The one predicate behind both the list/detail `hasAudio` field and the 404
 * `GET /api/transcripts/:id/audio` answers for an import, so the two can never
 * disagree: an imported transcript's source object is the JSON file it was made
 * from, not audio.
 *
 * @param provider - `transcripts.provider`.
 * @returns `false` for an imported transcript, `true` otherwise.
 *
 * @stability experimental
 */
export function transcriptHasAudio(provider: string): boolean {
  return provider !== TRANSCRIPT_IMPORT_PROVIDER;
}

/**
 * The largest value an `int4` column (`start_ms`, `end_ms`, `duration_ms`) holds.
 *
 * @stability experimental
 */
export const TRANSCRIPT_IMPORT_MAX_OFFSET_MS = 2_147_483_647;

/** How far past `now` a recording date may sit: the tolerance `PATCH` allows. */
const RECORDED_AT_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** The title of an imported transcript whose file carries a blank one. */
const UNTITLED_IMPORT = 'Imported transcript';

/**
 * One problem with an imported file.
 *
 * @stability experimental
 */
export interface TranscriptImportIssue {
  /** A dotted path into the document; `""` for the root. */
  path: string;
  /** What is wrong there. */
  message: string;
}

/**
 * Why an imported file was refused, as the route reports it in a 400's `details`.
 *
 * @stability experimental
 */
export interface TranscriptImportFailure {
  /** Discriminant. */
  ok: false;
  /** `details.reason`. */
  reason: TranscriptImportFailureReason;
  /** The human-readable message. */
  message: string;
  /** The first problems found (at most `TRANSCRIPT_IMPORT_MAX_ISSUES`). */
  issues?: TranscriptImportIssue[];
  /** For `unsupported_schema`: the `schema` string the file carries, if any. */
  schema?: string;
}

/**
 * The outcome of {@link parseTranscriptImport}.
 *
 * @stability experimental
 */
export type TranscriptImportParseResult =
  | {
      /** Discriminant. */
      ok: true;
      /** The validated document. */
      document: TranscriptDocumentV1;
    }
  | TranscriptImportFailure;

/**
 * Parses and validates an uploaded `kvox.transcript/v1` file.
 *
 * @param body - the file's bytes (or its text).
 * @param options - `now`, against which a recording date in the future is refused.
 * @returns the document, or the typed failure.
 * @stability experimental
 */
export function parseTranscriptImport(
  body: Uint8Array | string,
  options: { now: Date },
): TranscriptImportParseResult {
  // ---- 1. UTF-8 JSON -------------------------------------------------------
  let text: string;

  try {
    text = typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return fail('NOT_JSON', 'The file is not UTF-8 text.');
  }

  let value: unknown;

  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return fail('NOT_JSON', 'The file is not valid JSON.');
  }

  // ---- 2. Ours, and this version -------------------------------------------
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('UNSUPPORTED_SCHEMA', `The file is not a ${TRANSCRIPT_DOCUMENT_V1_SCHEMA} document.`);
  }

  const declared = (value as Record<string, unknown>).schema;

  if (declared !== TRANSCRIPT_DOCUMENT_V1_SCHEMA) {
    return {
      ...fail(
        'UNSUPPORTED_SCHEMA',
        typeof declared === 'string'
          ? `The file is a "${declared.slice(0, 100)}" document; this server imports ${TRANSCRIPT_DOCUMENT_V1_SCHEMA}.`
          : `The file has no "schema" field naming ${TRANSCRIPT_DOCUMENT_V1_SCHEMA}; it is not a KVox transcript export.`,
      ),
      ...(typeof declared === 'string' ? { schema: declared.slice(0, 100) } : {}),
    };
  }

  // ---- 3. The published shape, then what a transcript can hold --------------
  const parsed = transcriptDocumentV1Schema.safeParse(value);

  if (!parsed.success) {
    return fail(
      'INVALID_DOCUMENT',
      'The file does not match the published kvox.transcript/v1 schema.',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  const document = parsed.data;
  const doc = document.transcript;
  const storable: TranscriptImportIssue[] = [];

  if (doc.durationMs > TRANSCRIPT_IMPORT_MAX_OFFSET_MS) {
    storable.push({ path: 'transcript.durationMs', message: tooLarge() });
  }

  doc.speakers.forEach((speaker, index) => {
    if (speaker.displayName.trim().length > MAX_SPEAKER_NAME) {
      storable.push({
        path: `transcript.speakers.${index}.displayName`,
        message: `A speaker name may be at most ${MAX_SPEAKER_NAME} characters.`,
      });
    }
  });

  doc.segments.forEach((segment, index) => {
    const at = `transcript.segments.${index}`;

    if (segment.startMs > TRANSCRIPT_IMPORT_MAX_OFFSET_MS) storable.push({ path: `${at}.startMs`, message: tooLarge() });
    if (segment.endMs > TRANSCRIPT_IMPORT_MAX_OFFSET_MS) storable.push({ path: `${at}.endMs`, message: tooLarge() });
    if (segment.endMs < segment.startMs) {
      storable.push({ path: `${at}.endMs`, message: 'A segment cannot end before it starts.' });
    }
  });

  if (doc.recordedAt !== undefined) {
    const ms = new Date(doc.recordedAt).getTime();

    if (Number.isNaN(ms) || ms < 0) {
      storable.push({ path: 'transcript.recordedAt', message: 'A recording cannot be dated before 1970-01-01T00:00:00Z.' });
    } else if (ms > options.now.getTime() + RECORDED_AT_FUTURE_TOLERANCE_MS) {
      storable.push({ path: 'transcript.recordedAt', message: 'A recording cannot be dated in the future.' });
    }
  }

  if (storable.length > 0) {
    return fail('INVALID_DOCUMENT', 'The file holds values a transcript cannot store.', storable);
  }

  // ---- 4. Unique ids --------------------------------------------------------
  const duplicates = [
    ...duplicateIssues(doc.speakers.map((speaker) => speaker.id), 'transcript.speakers', 'speaker'),
    ...duplicateIssues(doc.segments.map((segment) => segment.id), 'transcript.segments', 'segment'),
  ];

  if (duplicates.length > 0) {
    return fail('DUPLICATE_ID', 'Two speakers, or two segments, share an id.', duplicates);
  }

  // ---- 5. Every segment's speaker is declared -------------------------------
  const declaredSpeakers = new Set(doc.speakers.map((speaker) => speaker.id));
  const unknown: TranscriptImportIssue[] = [];

  doc.segments.forEach((segment, index) => {
    if (!declaredSpeakers.has(segment.speakerId)) {
      unknown.push({
        path: `transcript.segments.${index}.speakerId`,
        message: `No speaker with id "${segment.speakerId.slice(0, 100)}" is declared.`,
      });
    }
  });

  if (unknown.length > 0) {
    return fail('UNKNOWN_SPEAKER', 'A segment names a speaker the file does not declare.', unknown);
  }

  // ---- 6. Something to read ---------------------------------------------------
  if (doc.segments.length === 0) {
    return fail('EMPTY_TRANSCRIPT', 'The file holds no segments.');
  }

  return { ok: true, document };
}

/**
 * One speaker of an import plan: the row to create, and the name to record in
 * `speaker_identities` once the row has an id (null for a placeholder speaker).
 *
 * @stability experimental
 */
export interface TranscriptImportSpeakerPlan extends OriginalSpeakerInput {
  /** The identified name, or null when the speaker is still on its placeholder. */
  identity: string | null;
}

/**
 * Everything a valid file becomes: the transcript's columns and its version-1 rows.
 *
 * @stability experimental
 */
export interface TranscriptImportPlan {
  /** `transcripts.title`. */
  title: string;
  /** `transcripts.language`. */
  language: string | null;
  /** `transcripts.duration_ms`: the file's, or the last segment end when that is later. */
  durationMs: number;
  /** `transcripts.recorded_at`: the file's `recordedAt`, else its `createdAt`. */
  recordedAt: Date;
  /** `transcripts.speaker_count`. */
  speakerCount: number;
  /** `transcripts.word_count`, counted as ingest counts it. */
  wordCount: number;
  /** The speaker rows, in the file's order (which is their colour order). */
  speakers: TranscriptImportSpeakerPlan[];
  /** The segment rows, in the file's order, with gap-based ordinals. */
  segments: OriginalSegmentInput[];
  /** Where the file came from, recorded under `providerOptions.importedFrom`. */
  importedFrom: {
    /** The file's format identifier. */
    schema: string;
    /** The transcript id in the system that exported it. */
    sourceTranscriptId: string;
    /** The version that was exported. */
    sourceVersion: number;
    /** The provider that transcribed the original, when the file says. */
    sourceProvider: {
      /** The provider id (`assemblyai`), when the file names one. */
      id: string | null;
      /** The provider's model, when the file names one. */
      model: string | null;
    } | null;
  };
}

/**
 * Maps a validated document onto the rows of a new transcript. Pure and total
 * over anything {@link parseTranscriptImport} accepted.
 *
 * @param document - a document {@link parseTranscriptImport} accepted.
 * @returns the plan.
 * @stability experimental
 */
export function planTranscriptImport(document: TranscriptDocumentV1): TranscriptImportPlan {
  const doc = document.transcript;
  const speakers = planSpeakers(doc.speakers);

  const segments: OriginalSegmentInput[] = doc.segments.map((segment, index) => {
    const words = (segment.words ?? []).map((word) => ({
      t: word.text,
      s: word.startMs,
      e: word.endMs,
      c: word.confidence ?? null,
    }));

    return {
      speakerKey: segment.speakerId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      ordinal: (index + 1) * ORDINAL_GAP,
      text: segment.text,
      words,
      wordsAlignment: alignmentOf(segment.wordsAlignment, words.length),
      confidence: segment.confidence ?? null,
      // The file is this transcript's ORIGINAL, as the provider's result is
      // for an uploaded one: version 1, `ai_original`, every segment `ai`.
      origin: 'ai',
    };
  });

  const lastEnd = segments.reduce((max, segment) => Math.max(max, segment.endMs), 0);
  const title = doc.title.trim().slice(0, MAX_TITLE_LENGTH);
  const language = doc.language?.trim() || null;

  return {
    title: title.length > 0 ? title : UNTITLED_IMPORT,
    language,
    durationMs: Math.max(doc.durationMs, lastEnd),
    recordedAt: new Date(doc.recordedAt ?? doc.createdAt),
    speakerCount: speakers.length,
    wordCount: countSegmentWords(segments),
    speakers,
    segments,
    importedFrom: {
      schema: document.schema,
      sourceTranscriptId: doc.id,
      sourceVersion: doc.version,
      sourceProvider: doc.provider
        ? { id: doc.provider.id ?? null, model: doc.provider.model ?? null }
        : null,
    },
  };
}

/**
 * The speakers' labels and names. See the file header.
 */
function planSpeakers(
  speakers: TranscriptDocumentV1['transcript']['speakers'],
): TranscriptImportSpeakerPlan[] {
  const taken = new Set<string>();

  // First pass: placeholder names claim their own labels, in file order.
  const placeholderLabels = speakers.map((speaker) => {
    const label = placeholderLabel(speaker.displayName.trim());

    if (label === null || taken.has(label)) return null;

    taken.add(label);

    return label;
  });

  let next = 0;
  const freshLabel = (): string => {
    let label = letterLabel(next++);

    while (taken.has(label)) label = letterLabel(next++);

    taken.add(label);

    return label;
  };

  return speakers.map((speaker, index) => {
    const name = speaker.displayName.trim();
    const own = placeholderLabels[index];

    if (own !== null) {
      return { key: speaker.id, label: own, displayName: name, colorIndex: index, identity: null };
    }

    const label = freshLabel();

    // A blank name, or a placeholder whose label another speaker already
    // claimed, is still unnamed: it gets the placeholder of its own label
    // rather than becoming a person called "Speaker A".
    if (name.length === 0 || placeholderLabel(name) !== null) {
      return { key: speaker.id, label, displayName: defaultSpeakerName(label), colorIndex: index, identity: null };
    }

    return { key: speaker.id, label, displayName: name, colorIndex: index, identity: name };
  });
}

/** The label a placeholder name (`Speaker A`) carries, or null for a real name. */
function placeholderLabel(name: string): string | null {
  const prefix = defaultSpeakerName('');

  if (!name.startsWith(prefix)) return null;

  const label = name.slice(prefix.length);

  return label.length > 0 && label.trim() === label && defaultSpeakerName(label) === name ? label : null;
}

/** `0 → A`, `25 → Z`, `26 → AA`: the diarization labels a provider uses. */
function letterLabel(index: number): string {
  let label = '';
  let n = index;

  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);

  return label;
}

/**
 * The file's alignment, else `exact` for timings the file carries and `none` when it
 * carries none (spec §3.5: nothing measured, nothing to trust).
 */
function alignmentOf(declared: WordsAlignmentValue | undefined, wordCount: number): WordsAlignmentValue {
  if (declared !== undefined) return declared;

  return wordCount > 0 ? 'exact' : 'none';
}

function duplicateIssues(ids: readonly string[], path: string, noun: string): TranscriptImportIssue[] {
  const seen = new Set<string>();
  const issues: TranscriptImportIssue[] = [];

  ids.forEach((id, index) => {
    if (seen.has(id)) {
      issues.push({ path: `${path}.${index}.id`, message: `Another ${noun} already has the id "${id.slice(0, 100)}".` });
    }

    seen.add(id);
  });

  return issues;
}

function tooLarge(): string {
  return `At most ${TRANSCRIPT_IMPORT_MAX_OFFSET_MS} milliseconds.`;
}

function fail(
  key: keyof typeof TRANSCRIPT_IMPORT_FAILURE_REASONS,
  message: string,
  issues?: TranscriptImportIssue[],
): TranscriptImportFailure {
  return {
    ok: false,
    reason: TRANSCRIPT_IMPORT_FAILURE_REASONS[key],
    message,
    ...(issues !== undefined ? { issues: issues.slice(0, TRANSCRIPT_IMPORT_MAX_ISSUES) } : {}),
  };
}
