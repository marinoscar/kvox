/**
 * "Fix names with AI" — the web client for issues #329 and #330, epic #326.
 *
 * The backend half is `apps/api/src/transcripts/transcript-name-checks.controller.ts`
 * and `dto/transcript-name-check.dto.ts`. Every type below is a hand-written
 * mirror of one of those Zod schemas, named identically so the two can be
 * diffed by eye — the same discipline `services/transcriptEditing.ts` applies.
 * The transport, the bearer token and the `{ data }` unwrap all stay in
 * `services/api.ts`.
 *
 * A name check never changes the transcript by itself. It PROPOSES; the user
 * accepts (`apply`) or rejects. `apply` writes ordinary `segment.update_text`
 * corrections through the same path as `POST /:id/operations`, so its 409 has
 * exactly that endpoint's conflict shape and `parseOperationsConflict` reads it.
 */

import { api, ApiError } from './api';
import type { TranscriptSegment, TranscriptSpeaker } from './transcripts';

export type NameCheckMode = 'standard' | 'thorough';

export type NameCheckStatus = 'pending' | 'running' | 'ready' | 'failed';

/** Mirror of `nameCheckEstimateSchema`. */
export interface NameCheckEstimate {
  inputTokens: number;
  requests: number;
  candidates: number;
}

/** Mirror of `nameCheckRunSchema`. */
export interface NameCheckRun {
  id: string;
  transcriptId: string;
  mode: NameCheckMode;
  status: NameCheckStatus;
  basedOnVersion: number;
  terms: string[];
  providerId: string | null;
  model: string | null;
  candidateCount: number;
  suggestionCount: number;
  inputTokens: number;
  outputTokens: number;
  /** `auth` / `refusal` / `input` / `budget` / `other` when `failed`. */
  errorClass: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Mirror of `nameSuggestionSchema`. */
export interface NameSuggestion {
  id: string;
  segmentId: string;
  speakerId: string;
  startMs: number;
  /** UTF-16 offsets into the segment's CURRENT text (stored offsets when `stale`). */
  start: number;
  end: number;
  original: string;
  replacement: string;
  confidence: number | null;
  reason: string | null;
  /** `phonetic` or `discovery`. */
  source: string;
  /** A short excerpt of the current line around the span. */
  preview: string;
  /** The line no longer contains `original` at a unique position. */
  stale: boolean;
}

export interface NameSuggestionCounts {
  pending: number;
  accepted: number;
  rejected: number;
  stale: number;
}

/** Mirror of `latestNameCheckSchema`. */
export interface LatestNameCheck {
  run: NameCheckRun | null;
  /** The run's PENDING suggestions, in reading order. */
  suggestions: NameSuggestion[];
  counts: NameSuggestionCounts;
}

export interface CreateNameCheckInput {
  mode?: NameCheckMode;
  terms?: string[];
  speakerIds?: string[];
}

export interface CreateNameCheckResult {
  run: NameCheckRun;
  estimate: NameCheckEstimate;
}

export interface ApplyNameSuggestionsResult {
  applied: number;
  stale: number;
  version: number;
  segments: TranscriptSegment[];
  speakers: TranscriptSpeaker[];
}

export interface RejectNameSuggestionsResult {
  rejected: number;
}

/** `details.reason` on a 409 from `POST /:id/name-checks`. */
export type NameCheckConflictReason =
  | 'ai_not_configured'
  | 'ai_key_missing'
  | 'name_check_running'
  | 'transcript_not_ready';

/** Mirror of `MAX_NAME_CHECK_TERMS`. */
export const MAX_NAME_CHECK_TERMS = 200;

/** Mirror of `MAX_NAME_CHECK_DECISIONS`: the most ids one apply/reject may name. */
export const MAX_NAME_CHECK_DECISIONS = 1_000;

/**
 * The server's generic-label rule (`GENERIC_NAME` in
 * `apps/api/src/transcripts/name-check/candidates.ts`), mirrored so the UI
 * never offers to check for "Speaker A" — the server would drop it anyway, and
 * a checklist entry that silently does nothing is a lie the dialog tells.
 */
const GENERIC_NAME = [/^speaker\s*[a-z0-9]+$/i, /^unknown/i];

export function isGenericSpeakerName(name: string): boolean {
  const text = name.trim().replace(/\s+/g, ' ');
  return !text || GENERIC_NAME.some((re) => re.test(text));
}

const base = (transcriptId: string) =>
  `/transcripts/${encodeURIComponent(transcriptId)}/name-checks`;

/** `POST /api/transcripts/:id/name-checks` — 202 with the queued run. */
export async function createNameCheck(
  transcriptId: string,
  input: CreateNameCheckInput,
): Promise<CreateNameCheckResult> {
  return api.post<CreateNameCheckResult>(base(transcriptId), input);
}

/** `GET /api/transcripts/:id/name-checks/estimate?mode=`. */
export async function getNameCheckEstimate(
  transcriptId: string,
  mode: NameCheckMode,
): Promise<NameCheckEstimate> {
  return api.get<NameCheckEstimate>(
    `${base(transcriptId)}/estimate?mode=${encodeURIComponent(mode)}`,
  );
}

/** `GET /api/transcripts/:id/name-checks/latest`. */
export async function getLatestNameCheck(transcriptId: string): Promise<LatestNameCheck> {
  return api.get<LatestNameCheck>(`${base(transcriptId)}/latest`);
}

/** `POST /api/transcripts/:id/name-checks/:checkId/apply`. */
export async function applyNameSuggestions(
  transcriptId: string,
  checkId: string,
  suggestionIds: string[],
): Promise<ApplyNameSuggestionsResult> {
  return api.post<ApplyNameSuggestionsResult>(
    `${base(transcriptId)}/${encodeURIComponent(checkId)}/apply`,
    { suggestionIds },
  );
}

/** `POST /api/transcripts/:id/name-checks/:checkId/reject`. */
export async function rejectNameSuggestions(
  transcriptId: string,
  checkId: string,
  suggestionIds: string[],
): Promise<RejectNameSuggestionsResult> {
  return api.post<RejectNameSuggestionsResult>(
    `${base(transcriptId)}/${encodeURIComponent(checkId)}/reject`,
    { suggestionIds },
  );
}

/**
 * The machine-readable reason behind a name-check 409, or `null`.
 *
 * Read from `details.reason`, never the top-level `code` (which the global
 * filter derives from the status) and never the prose `message`.
 */
export function nameCheckConflictReason(err: unknown): NameCheckConflictReason | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? (reason as NameCheckConflictReason) : null;
}

/** The running check's id from a `name_check_running` 409, when the API sent one. */
export function runningNameCheckId(err: unknown): string | null {
  if (nameCheckConflictReason(err) !== 'name_check_running') return null;
  const checkId = ((err as ApiError).details as { checkId?: unknown }).checkId;
  return typeof checkId === 'string' ? checkId : null;
}
