/**
 * "Fix names with AI" — the web client for issues #329 and #330, epic #326.
 *
 * The backend half is `packages/kvox-api/src/transcripts/transcript-name-checks.controller.ts`
 * and `dto/transcript-name-check.dto.ts`. Every type below is a hand-written
 * mirror of one of those Zod schemas, named identically so the two can be
 * diffed by eye — the same discipline `transcriptEditing.ts` applies. The
 * transport, the bearer token and the `{ data }` unwrap all stay the host's:
 * every call takes the {@link KvoxWebHost} first.
 *
 * A name check never changes the transcript by itself. It PROPOSES; the user
 * accepts (`apply`) or rejects. `apply` writes ordinary `segment.update_text`
 * corrections through the same path as `POST /:id/operations`, so its 409 has
 * exactly that endpoint's conflict shape and `parseOperationsConflict` reads it.
 */

import { KvoxApiError, kvoxGet, kvoxPost } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';
import type { TranscriptSegment, TranscriptSpeaker } from './transcripts.js';

/**
 * How hard the AI name check looks: `standard` or `thorough`.
 *
 * @stability experimental
 */
export type NameCheckMode = 'standard' | 'thorough';

/**
 * Where a name-check run is in its life.
 *
 * @stability experimental
 */
export type NameCheckStatus = 'pending' | 'running' | 'ready' | 'failed';

/**
 * Mirror of `nameCheckEstimateSchema`.
 *
 * @stability experimental
 */
export interface NameCheckEstimate {
  /** The estimated input tokens. */
  inputTokens: number;
  /** The number of model requests. */
  requests: number;
  /** The number of candidate spans. */
  candidates: number;
}

/**
 * Mirror of `nameCheckRunSchema`.
 *
 * @stability experimental
 */
export interface NameCheckRun {
  /** The run's id. */
  id: string;
  /** The transcript it checked. */
  transcriptId: string;
  /** How hard it looked. */
  mode: NameCheckMode;
  /** Where the run is. */
  status: NameCheckStatus;
  /** The transcript version the run read. */
  basedOnVersion: number;
  /** The names and terms the user supplied. */
  terms: string[];
  /** The AI provider used, or null. */
  providerId: string | null;
  /** The model used, or null. */
  model: string | null;
  /** How many candidate spans were examined. */
  candidateCount: number;
  /** How many suggestions the run produced. */
  suggestionCount: number;
  /** The estimated input tokens. */
  inputTokens: number;
  /** The output tokens spent. */
  outputTokens: number;
  /** `auth` / `refusal` / `input` / `budget` / `other` when `failed`. */
  errorClass: string | null;
  /** The error message when it failed, or null. */
  error: string | null;
  /** When it was created (ISO 8601). */
  createdAt: string;
  /** When the run started (ISO 8601), or null. */
  startedAt: string | null;
  /** When transcription completed, or null. */
  completedAt: string | null;
}

/**
 * Mirror of `nameSuggestionSchema`.
 *
 * @stability experimental
 */
export interface NameSuggestion {
  /** The suggestion's id. */
  id: string;
  /** The segment the span is in. */
  segmentId: string;
  /** The segment's speaker. */
  speakerId: string;
  /** Where the line starts in the media, in milliseconds. */
  startMs: number;
  /** UTF-16 offsets into the segment's CURRENT text (stored offsets when `stale`). */
  start: number;
  /** Where the span ends, as an offset into the segment's text. */
  end: number;
  /** The text as the transcript has it. */
  original: string;
  /** The text the AI proposes. */
  replacement: string;
  /** The AI's confidence from 0 to 1, or null. */
  confidence: number | null;
  /** Why the AI proposed it, or null. */
  reason: string | null;
  /** `phonetic` or `discovery`. */
  source: string;
  /** A short excerpt of the current line around the span. */
  preview: string;
  /** The line no longer contains `original` at a unique position. */
  stale: boolean;
}

/**
 * How many of a run's suggestions are in each state.
 *
 * @stability experimental
 */
export interface NameSuggestionCounts {
  /** Suggestions awaiting a decision. */
  pending: number;
  /** Suggestions that were accepted. */
  accepted: number;
  /** Suggestions that were rejected. */
  rejected: number;
  /** Suggestions whose line changed so they no longer apply. */
  stale: number;
}

/**
 * Mirror of `latestNameCheckSchema`.
 *
 * @stability experimental
 */
export interface LatestNameCheck {
  /** The latest run, or null when there is none. */
  run: NameCheckRun | null;
  /** The run's PENDING suggestions, in reading order. */
  suggestions: NameSuggestion[];
  /** How many suggestions are in each state. */
  counts: NameSuggestionCounts;
}

/**
 * The body of `POST /api/transcripts/:id/name-checks`.
 *
 * @stability experimental
 */
export interface CreateNameCheckInput {
  /** How hard to look; defaults to `standard`. */
  mode?: NameCheckMode;
  /** Names and terms to look for. */
  terms?: string[];
  /** Restrict the check to these speakers. */
  speakerIds?: string[];
}

/**
 * The run a request created and the cost estimate the dialog shows before it proceeds.
 *
 * @stability experimental
 */
export interface CreateNameCheckResult {
  /** The run that was created. */
  run: NameCheckRun;
  /** The cost estimate. */
  estimate: NameCheckEstimate;
}

/**
 * The result of accepting suggestions: how many applied, how many were stale, and the transcript as it now is.
 *
 * @stability experimental
 */
export interface ApplyNameSuggestionsResult {
  /** How many suggestions were applied. */
  applied: number;
  /** How many were skipped because their line changed. */
  stale: number;
  /** The transcript's version after applying. */
  version: number;
  /** The segments that changed. */
  segments: TranscriptSegment[];
  /** The speakers as they now are. */
  speakers: TranscriptSpeaker[];
}

/**
 * The result of rejecting suggestions.
 *
 * @stability experimental
 */
export interface RejectNameSuggestionsResult {
  /** How many suggestions were rejected. */
  rejected: number;
}

/**
 * `details.reason` on a 409 from `POST /:id/name-checks`.
 *
 * @stability experimental
 */
export type NameCheckConflictReason =
  | 'ai_not_configured'
  | 'ai_key_missing'
  | 'name_check_running'
  | 'transcript_not_ready';

/**
 * Mirror of `MAX_NAME_CHECK_TERMS`.
 *
 * @stability experimental
 */
export const MAX_NAME_CHECK_TERMS = 200;

/**
 * Mirror of `MAX_NAME_CHECK_DECISIONS`: the most ids one apply/reject may name.
 *
 * @stability experimental
 */
export const MAX_NAME_CHECK_DECISIONS = 1_000;

/**
 * The server's generic-label rule (`GENERIC_NAME` in
 * `packages/kvox-api/src/transcripts/name-check/candidates.ts`), mirrored so the UI
 * never offers to check for "Speaker A" — the server would drop it anyway, and
 * a checklist entry that silently does nothing is a lie the dialog tells.
 */
const GENERIC_NAME = [/^speaker\s*[a-z0-9]+$/i, /^unknown/i];

/**
 * Whether a speaker name is a generic label (`Speaker A`, `Unknown`) rather than a person's name.
 *
 * @stability experimental
 */
export function isGenericSpeakerName(name: string): boolean {
  const text = name.trim().replace(/\s+/g, ' ');
  return !text || GENERIC_NAME.some((re) => re.test(text));
}

const base = (transcriptId: string) =>
  `/transcripts/${encodeURIComponent(transcriptId)}/name-checks`;

/**
 * `POST /api/transcripts/:id/name-checks` — 202 with the queued run.
 *
 * @stability experimental
 */
export async function createNameCheck(
  host: KvoxWebHost,
  transcriptId: string,
  input: CreateNameCheckInput,
): Promise<CreateNameCheckResult> {
  return kvoxPost<CreateNameCheckResult>(host, base(transcriptId), input);
}

/**
 * `GET /api/transcripts/:id/name-checks/estimate?mode=`.
 *
 * @stability experimental
 */
export async function getNameCheckEstimate(
  host: KvoxWebHost,
  transcriptId: string,
  mode: NameCheckMode,
): Promise<NameCheckEstimate> {
  return kvoxGet<NameCheckEstimate>(host, `${base(transcriptId)}/estimate`, { query: { mode } });
}

/**
 * `GET /api/transcripts/:id/name-checks/latest`.
 *
 * @stability experimental
 */
export async function getLatestNameCheck(
  host: KvoxWebHost,
  transcriptId: string,
): Promise<LatestNameCheck> {
  return kvoxGet<LatestNameCheck>(host, `${base(transcriptId)}/latest`);
}

/**
 * `POST /api/transcripts/:id/name-checks/:checkId/apply`.
 *
 * @stability experimental
 */
export async function applyNameSuggestions(
  host: KvoxWebHost,
  transcriptId: string,
  checkId: string,
  suggestionIds: string[],
): Promise<ApplyNameSuggestionsResult> {
  return kvoxPost<ApplyNameSuggestionsResult>(
    host,
    `${base(transcriptId)}/${encodeURIComponent(checkId)}/apply`,
    { suggestionIds },
  );
}

/**
 * `POST /api/transcripts/:id/name-checks/:checkId/reject`.
 *
 * @stability experimental
 */
export async function rejectNameSuggestions(
  host: KvoxWebHost,
  transcriptId: string,
  checkId: string,
  suggestionIds: string[],
): Promise<RejectNameSuggestionsResult> {
  return kvoxPost<RejectNameSuggestionsResult>(
    host,
    `${base(transcriptId)}/${encodeURIComponent(checkId)}/reject`,
    { suggestionIds },
  );
}

/**
 * The machine-readable reason behind a name-check 409, or `null`.
 *
 * Read from `details.reason`, never the top-level `code` (which the global
 * filter derives from the status) and never the prose `message`.
 *
 * @stability experimental
 */
export function nameCheckConflictReason(err: unknown): NameCheckConflictReason | null {
  if (!(err instanceof KvoxApiError) || err.status !== 409) return null;
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? (reason as NameCheckConflictReason) : null;
}

/**
 * The running check's id from a `name_check_running` 409, when the API sent one.
 *
 * @stability experimental
 */
export function runningNameCheckId(err: unknown): string | null {
  if (nameCheckConflictReason(err) !== 'name_check_running') return null;
  const checkId = ((err as KvoxApiError).details as { checkId?: unknown }).checkId;
  return typeof checkId === 'string' ? checkId : null;
}
