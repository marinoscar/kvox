/**
 * The corrections API, as the web app sees it — issue #31, epic #19.
 *
 * The backend half is `apps/api/src/transcripts/transcripts.controller.ts`'s
 * five correction routes and `dto/transcript-editing.dto.ts`; the op shapes
 * themselves are `apps/api/src/transcripts/editing/ops.ts`. Every type below is
 * a hand-written mirror of one of those Zod schemas, named identically so the
 * two can be diffed by eye — the same discipline `services/transcripts.ts`
 * (#30) applies to the read half, and this file is its sibling rather than a
 * second client: the transport, the bearer token and the 401 → refresh → retry
 * all stay in `services/api.ts`.
 *
 * =============================================================================
 * THE 409 BODY IS UNDER `details`, AND READING IT ANYWHERE ELSE FINDS NOTHING
 * =============================================================================
 *
 * Spec §5 draws the conflict payload at the top level
 * (`{ currentVersion, conflicts }`). It does not arrive that way. This API has
 * ONE error envelope for every operation — `{ statusCode, code, message,
 * details }` — and the global `HttpExceptionFilter` reads nothing else off a
 * thrown payload, so the conflict object travels in `details` and a client
 * reaching for `err.currentVersion` silently gets `undefined` and reports a
 * conflict with nothing in it. `parseOperationsConflict` below is the ONE place
 * that unwrapping happens, and it validates the shape rather than casting it:
 * the difference between "this was a conflict we can resolve" and "this was a
 * 409 we do not understand" decides whether the user is offered a choice or an
 * error, and a cast cannot tell them apart.
 *
 * =============================================================================
 * THE OP TYPES ARE PERMANENT
 * =============================================================================
 *
 * Every string in `OP_TYPES` is written into `transcript_versions.ops` as JSONB
 * and replayed by `materialize()` for as long as the transcript exists. This
 * copy exists so the web app never spells one as an inline literal; it must be
 * changed only together with the API's own list, which is to say never.
 */

import { api, ApiError } from './api';
import type { TranscriptSegment, TranscriptSpeaker } from './transcripts';

// =============================================================================
// The ops
// =============================================================================

/** Mirror of `editing/ops.ts`'s `OP_TYPES`. Permanent — see the file header. */
export const OP_TYPES = {
  UPDATE_TEXT: 'segment.update_text',
  SET_SPEAKER: 'segment.set_speaker',
  SPLIT: 'segment.split',
  JOIN: 'segment.join',
  DELETE: 'segment.delete',
  RENAME_SPEAKER: 'speaker.rename',
  CREATE_SPEAKER: 'speaker.create',
  MERGE_SPEAKERS: 'speaker.merge',
  FIND_REPLACE: 'transcript.find_replace',
} as const;

/** The most ops one batch may carry (`MAX_OPS_PER_BATCH`, spec §4.1). */
export const MAX_OPS_PER_BATCH = 200;

/** Longest speaker display name the API will store. */
export const MAX_SPEAKER_NAME = 120;

/** Longest search or replacement string a find & replace may carry. */
export const MAX_FIND_LENGTH = 500;

export interface UpdateTextOp {
  op: typeof OP_TYPES.UPDATE_TEXT;
  segmentId: string;
  rev: number;
  text: string;
}

export interface SetSpeakerOp {
  op: typeof OP_TYPES.SET_SPEAKER;
  segmentId: string;
  rev: number;
  speakerId: string;
}

/**
 * ⚠ EXACTLY ONE of `atWordIndex` / `atCharOffset`, never both and never
 * neither: the API `.refine()`s on it and answers 400 otherwise. The editor
 * splits at the caret, which is a character offset into the text it rendered —
 * so it sends `atCharOffset` and lets the server resolve the word index it
 * records.
 */
export interface SplitOp {
  op: typeof OP_TYPES.SPLIT;
  segmentId: string;
  rev: number;
  atWordIndex?: number;
  atCharOffset?: number;
  /** The LATER half's speaker, when the split is also a speaker correction. */
  newSpeakerId?: string | null;
}

/**
 * ⚠ `segmentIds` and `revs` are LENGTH-2 ARRAYS, in reading order, not a pair
 * of scalar fields. The API models them as `z.array(...).length(2)` (and
 * deliberately not a tuple — see `ops.ts` for the OpenAPI reason), so the two
 * arrays are positionally paired: `revs[0]` is `segmentIds[0]`'s.
 */
export interface JoinOp {
  op: typeof OP_TYPES.JOIN;
  segmentIds: string[];
  revs: number[];
}

export interface DeleteSegmentOp {
  op: typeof OP_TYPES.DELETE;
  segmentId: string;
  rev: number;
}

export interface RenameSpeakerOp {
  op: typeof OP_TYPES.RENAME_SPEAKER;
  speakerId: string;
  rev: number;
  displayName: string;
}

/** No id and no colour: both are the server's to choose, and it records them. */
export interface CreateSpeakerOp {
  op: typeof OP_TYPES.CREATE_SPEAKER;
  displayName: string;
}

export interface MergeSpeakersOp {
  op: typeof OP_TYPES.MERGE_SPEAKERS;
  sourceIds: string[];
  targetId: string;
  /**
   * `true` (the API's default) keeps the TARGET's current display name;
   * `false` adopts the FIRST `sourceIds` entry's name onto the target. The
   * merge dialog's "which name to keep" radio is exactly this flag, which is
   * why it is always sent explicitly rather than left to default.
   */
  keepName?: boolean;
}

/**
 * Expanded server-side into concrete `segment.update_text` ops before anything
 * is recorded (spec §4.2), which is why "Replace all" is ONE op and therefore
 * one version however many segments it rewrites.
 */
export interface FindReplaceOp {
  op: typeof OP_TYPES.FIND_REPLACE;
  find: string;
  replace: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  speakerId?: string | null;
}

export type TranscriptOp =
  | UpdateTextOp
  | SetSpeakerOp
  | SplitOp
  | JoinOp
  | DeleteSegmentOp
  | RenameSpeakerOp
  | CreateSpeakerOp
  | MergeSpeakersOp
  | FindReplaceOp;

// =============================================================================
// POST /:id/operations
// =============================================================================

/** What a `speaker.merge` moved, so the UI can offer a real Undo. */
export interface MergeUndo {
  targetId: string;
  sources: {
    speakerId: string;
    label: string | null;
    displayName: string;
    colorIndex: number;
    /** The segments that were on this speaker immediately before the merge. */
    segmentIds: string[];
  }[];
}

export interface OperationsResult {
  version: number;
  summary: string;
  /** True when this response replays an earlier, identical `clientBatchId`. */
  idempotentReplay: boolean;
  speakers: TranscriptSpeaker[];
  segments: TranscriptSegment[];
  /** One entry per `speaker.merge` in the batch. Empty for every other batch. */
  merges: MergeUndo[];
}

export interface ApplyOperationsInput {
  /** The `currentVersion` this client last saw. Informational — see spec §5. */
  baseVersion: number;
  /** This batch's idempotency key. Reused verbatim by a retry, never a resend. */
  clientBatchId: string;
  ops: TranscriptOp[];
}

export interface OperationsConflictEntity {
  entity: 'segment' | 'speaker';
  id: string;
  /** The entity's `rev` right now, or null when another editor deleted it. */
  current: number | null;
}

export interface OperationsConflict {
  currentVersion: number;
  conflicts: OperationsConflictEntity[];
}

/** `POST /api/transcripts/:id/operations`. */
export async function applyOperations(
  id: string,
  input: ApplyOperationsInput,
): Promise<OperationsResult> {
  return api.post<OperationsResult>(
    `/transcripts/${encodeURIComponent(id)}/operations`,
    input,
  );
}

/**
 * The conflict inside a 409, or `null` for anything else.
 *
 * VALIDATES rather than casts. A 409 whose `details` is not this shape is a
 * conflict this client cannot resolve — the honest answer is the error banner,
 * not a conflict card listing zero segments and offering a choice between two
 * things it does not have.
 */
export function parseOperationsConflict(error: unknown): OperationsConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;

  const details = error.details as Partial<OperationsConflict> | undefined;
  if (!details || typeof details.currentVersion !== 'number') return null;
  if (!Array.isArray(details.conflicts)) return null;

  const conflicts: OperationsConflictEntity[] = [];
  for (const entry of details.conflicts) {
    if (!entry || typeof entry !== 'object') continue;
    const { entity, id, current } = entry as OperationsConflictEntity;
    if (entity !== 'segment' && entity !== 'speaker') continue;
    if (typeof id !== 'string') continue;
    conflicts.push({
      entity,
      id,
      current: typeof current === 'number' ? current : null,
    });
  }

  return { currentVersion: details.currentVersion, conflicts };
}

/**
 * A fresh idempotency key.
 *
 * `crypto.randomUUID` where it exists (every browser this app supports, and
 * jsdom under Node 19+), with a `Math.random` fallback rather than a throw: a
 * missing `randomUUID` must not be the reason somebody's correction cannot be
 * saved. The API requires 8–200 characters and nothing else of the format.
 */
export function newClientBatchId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `batch-${uuid}`;
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// =============================================================================
// GET /:id/search
// =============================================================================

export interface TranscriptSearchMatch {
  segmentId: string;
  speakerId: string;
  /** Where in the media this line is, so a hit can be played. */
  startMs: number;
  /** Offsets into the segment's own text, in UTF-16 code units. */
  start: number;
  end: number;
  preview: string;
}

export interface TranscriptSearchResult {
  q: string;
  matchCase: boolean;
  wholeWord: boolean;
  speakerId: string | null;
  /** Every occurrence, even when `matches` was truncated. */
  total: number;
  segmentCount: number;
  truncated: boolean;
  matches: TranscriptSearchMatch[];
}

export interface TranscriptSearchParams {
  q: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  speakerId?: string | null;
  limit?: number;
}

/**
 * `GET /api/transcripts/:id/search`.
 *
 * ⚠ `matchCase`/`wholeWord` are sent as the literal strings `'true'`/`'false'`
 * because the API parses them with `z.enum(['true','false'])` and NOT
 * `z.coerce.boolean()` — deliberately, since `Boolean('false')` is `true`.
 * Sending `?matchCase=0` or omitting the value is therefore a 400, not a
 * silently-defaulted false.
 */
export async function searchTranscript(
  id: string,
  params: TranscriptSearchParams,
): Promise<TranscriptSearchResult> {
  const query = new URLSearchParams({ q: params.q });
  query.set('matchCase', params.matchCase ? 'true' : 'false');
  query.set('wholeWord', params.wholeWord ? 'true' : 'false');
  if (params.speakerId) query.set('speakerId', params.speakerId);
  if (params.limit !== undefined) query.set('limit', String(params.limit));

  return api.get<TranscriptSearchResult>(
    `/transcripts/${encodeURIComponent(id)}/search?${query.toString()}`,
  );
}

// =============================================================================
// GET /:id/versions, GET /:id/versions/:v, POST /:id/versions/:v/restore
// =============================================================================

export type TranscriptVersionKind = 'ai_original' | 'edit' | 'restore';

export interface TranscriptVersionAuthor {
  id: string;
  name: string | null;
  email: string | null;
}

export interface TranscriptVersionSummary {
  version: number;
  kind: TranscriptVersionKind;
  summary: string | null;
  /**
   * Who saved it, or **null meaning "the AI"** — the schema's own convention
   * (spec §4.5), not a missing value. Only version 1 is ever null.
   */
  author: TranscriptVersionAuthor | null;
  restoredFromVersion: number | null;
  hasSnapshot: boolean;
  opCount: number;
  createdAt: string;
}

export interface TranscriptVersionsResponse {
  currentVersion: number;
  items: TranscriptVersionSummary[];
  nextCursor: string | null;
}

export interface TranscriptVersionDetail extends TranscriptVersionSummary {
  currentVersion: number;
  speakers: TranscriptSpeaker[];
  /** Materialized segments, in reading order, WITHOUT word timings. */
  segments: TranscriptSegment[];
}

export interface TranscriptVersionsParams {
  cursor?: string;
  limit?: number;
}

/** `GET /api/transcripts/:id/versions`. */
export async function getTranscriptVersions(
  id: string,
  params: TranscriptVersionsParams = {},
): Promise<TranscriptVersionsResponse> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return api.get<TranscriptVersionsResponse>(
    `/transcripts/${encodeURIComponent(id)}/versions${suffix ? `?${suffix}` : ''}`,
  );
}

/**
 * `GET /api/transcripts/:id/versions/:v`.
 *
 * A **409** here is not a conflict in the concurrency sense: it means this
 * version predates the first snapshot and cannot be rebuilt yet. The preview
 * renders that as "not available yet", never as an error the reader caused.
 */
export async function getTranscriptVersion(
  id: string,
  version: number,
): Promise<TranscriptVersionDetail> {
  return api.get<TranscriptVersionDetail>(
    `/transcripts/${encodeURIComponent(id)}/versions/${version}`,
  );
}

/**
 * `POST /api/transcripts/:id/versions/:v/restore`.
 *
 * ⚠ `baseVersion` MUST match the transcript's current version here, unlike
 * `POST /:id/operations` where it is informational — a restore replaces the
 * whole state, so a stale view is asking to discard edits the caller never saw.
 * A 409 is the API refusing to do that, and the right answer is to re-read and
 * ask again, never to retry with a guessed version.
 */
export async function restoreTranscriptVersion(
  id: string,
  version: number,
  baseVersion: number,
): Promise<OperationsResult> {
  return api.post<OperationsResult>(
    `/transcripts/${encodeURIComponent(id)}/versions/${version}/restore`,
    { baseVersion },
  );
}
