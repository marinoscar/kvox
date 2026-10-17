/**
 * Importing a `kvox.transcript/v1` file — issue #571 (docs/specs/transcription.md §8.2).
 *
 * `POST /api/transcripts/imports` takes the very file the JSON exporter writes and
 * turns it back into a transcript: segments, speakers and their names, the
 * recording date. No audio is stored and no transcription job runs, so the
 * transcript answers `status: 'ready'` at once, with
 * `playbackStatus: 'not_needed'`, `provider: 'import'` and `hasAudio: false`.
 *
 * The request goes through `host.http.postFormData` (`kvoxPostFormData`), the
 * same as the notes source upload and the graph import, so the host's token,
 * 401 retry and maintenance handling all still apply. The answer is parsed with
 * the contract's `transcriptImportResponseSchema`, and a refusal is turned into
 * a sentence a person can act on by {@link transcriptImportErrorMessage}.
 */

import {
  TRANSCRIPT_IMPORT_FAILURE_REASONS,
  transcriptImportErrorDetailsSchema,
  transcriptImportResponseSchema,
} from '@marinoscar/kvox-contract/transcripts';
import type {
  TranscriptImportErrorDetails as ContractTranscriptImportErrorDetails,
  TranscriptImportFailureReason as ContractTranscriptImportFailureReason,
} from '@marinoscar/kvox-contract/transcripts';

import { KvoxApiError, kvoxPostFormData } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';
import type { TranscriptDetail } from './transcripts.js';

/**
 * Why an import was refused: `details.reason` of a 400. Alias of the contract's
 * `TranscriptImportFailureReason`.
 *
 * @stability experimental
 */
export type TranscriptImportFailureReason = ContractTranscriptImportFailureReason;

/**
 * The `details` of a 400 from the import: the reason and, for some reasons, the
 * first problems found. Alias of the contract's `TranscriptImportErrorDetails`.
 *
 * @stability experimental
 */
export type TranscriptImportErrorDetails = ContractTranscriptImportErrorDetails;

/**
 * The largest file the import accepts by default (25 MiB), checked in the browser
 * before the upload so an oversized file is refused without sending it. The API's
 * own limit is authoritative: a deployment that lowered it still answers 413.
 *
 * @stability experimental
 */
export const TRANSCRIPT_IMPORT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The `accept` attribute of the import's file input.
 *
 * @stability experimental
 */
export const TRANSCRIPT_IMPORT_ACCEPT = '.json,application/json';

/**
 * The `provider` an imported transcript carries. Mirrors the API's
 * `TRANSCRIPT_IMPORT_PROVIDER`; persisted, so never renamed.
 *
 * @stability experimental
 */
export const TRANSCRIPT_IMPORT_PROVIDER = 'import';

/** How many of a refusal's `details.issues` the message lists. */
const ISSUES_SHOWN = 3;

/**
 * `POST /api/transcripts/imports` — create a transcript from a `kvox.transcript/v1` file.
 *
 * Multipart with a single `file` part; needs `transcripts:write`. Answers the new
 * transcript exactly as `GET /api/transcripts/:id` does. A refusal rejects with a
 * {@link KvoxApiError} (400 with `details.reason`, 413 over the size limit); give
 * it to {@link transcriptImportErrorMessage} for the copy.
 *
 * @param host - The host.
 * @param file - The JSON file the user chose.
 * @returns The created transcript.
 *
 * @stability experimental
 */
export async function importTranscript(host: KvoxWebHost, file: File): Promise<TranscriptDetail> {
  const form = new FormData();
  form.append('file', file);
  const answer = await kvoxPostFormData<unknown>(host, '/transcripts/imports', form);
  return transcriptImportResponseSchema.parse(answer) as TranscriptDetail;
}

/**
 * The `details` of an import refusal, when the error carries a recognised one.
 *
 * @param error - Anything `importTranscript` rejected with.
 * @returns The parsed details, or `null`.
 *
 * @stability experimental
 */
export function transcriptImportErrorDetails(error: unknown): TranscriptImportErrorDetails | null {
  if (!(error instanceof KvoxApiError) || error.status !== 400) return null;
  const parsed = transcriptImportErrorDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

function issuesSuffix(details: TranscriptImportErrorDetails): string {
  const issues = details.issues ?? [];
  if (issues.length === 0) return '';
  const shown = issues
    .slice(0, ISSUES_SHOWN)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message));
  const more = issues.length > ISSUES_SHOWN ? ` (and ${issues.length - ISSUES_SHOWN} more)` : '';
  return ` ${shown.join('; ')}${more}.`;
}

/**
 * A sentence for a failed import, written for the person who chose the file.
 *
 * @param error - Anything `importTranscript` (or the size guard) rejected with.
 * @returns The message to show.
 *
 * @stability experimental
 */
export function transcriptImportErrorMessage(error: unknown): string {
  if (error instanceof KvoxApiError) {
    if (error.status === 413) {
      return 'That file is larger than this deployment accepts for an import.';
    }
    if (error.status === 403) {
      return 'You do not have permission to import transcripts.';
    }
    const details = transcriptImportErrorDetails(error);
    if (details) {
      switch (details.reason) {
        case TRANSCRIPT_IMPORT_FAILURE_REASONS.NOT_JSON:
          return 'That file is not valid JSON. Choose a transcript exported from KVox as JSON.';
        case TRANSCRIPT_IMPORT_FAILURE_REASONS.UNSUPPORTED_SCHEMA:
          return "This isn't a KVox transcript export (kvox.transcript/v1).";
        case TRANSCRIPT_IMPORT_FAILURE_REASONS.INVALID_DOCUMENT:
          return `This transcript export is not valid, so it was not imported.${issuesSuffix(details)}`;
        case TRANSCRIPT_IMPORT_FAILURE_REASONS.DUPLICATE_ID:
          return `This transcript export repeats a speaker or line id, so it was not imported.${issuesSuffix(details)}`;
        case TRANSCRIPT_IMPORT_FAILURE_REASONS.UNKNOWN_SPEAKER:
          return `A line in this transcript export names a speaker the file does not list, so it was not imported.${issuesSuffix(details)}`;
        case TRANSCRIPT_IMPORT_FAILURE_REASONS.EMPTY_TRANSCRIPT:
          return 'This transcript export has no lines, so there is nothing to import.';
      }
    }
    if (error.status === 400) {
      return 'The file could not be read. Choose a transcript exported from KVox as JSON.';
    }
    if (error.status > 0 && error.message) return error.message;
  }
  return 'The transcript could not be imported. Try again.';
}

/**
 * The browser-side check run before uploading: refuses an empty or oversized file.
 *
 * @param file - The chosen file.
 * @param maxBytes - The ceiling; default {@link TRANSCRIPT_IMPORT_MAX_BYTES}.
 * @returns `null` when the file may be sent, else the message to show.
 *
 * @stability experimental
 */
export function checkTranscriptImportFile(
  file: Pick<File, 'size'>,
  maxBytes: number = TRANSCRIPT_IMPORT_MAX_BYTES,
): string | null {
  if (file.size === 0) return 'That file is empty. Choose a transcript exported from KVox as JSON.';
  if (file.size > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    return `That file is too large to import. Transcript exports up to ${mb} MB can be imported.`;
  }
  return null;
}
