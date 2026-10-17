/**
 * The corrections API, as the web app sees it — issue #31, epic #19.
 *
 * The backend half is `packages/kvox-api/src/transcripts/transcripts.controller.ts`'s
 * five correction routes and `dto/transcript-editing.dto.ts`; the op shapes
 * themselves are `packages/kvox-api/src/transcripts/editing/ops.ts`. Every type below is
 * a hand-written mirror of one of those Zod schemas, named identically so the
 * two can be diffed by eye — the same discipline `transcripts.ts` (#30)
 * applies to the read half, and this file is its sibling rather than a second
 * client: the transport, the bearer token and the 401 → refresh → retry all
 * stay the host's (every call takes the {@link KvoxWebHost} first).
 *
 * =============================================================================
 * THE 409 BODY IS UNDER `details`, AND READING IT ANYWHERE ELSE FINDS NOTHING
 * =============================================================================
 *
 * Spec §5 draws the conflict payload at the top level
 * (`{ currentVersion, conflicts }`). It does not arrive that way. This API has
 * ONE error envelope for every operation (status code, code, message and
 * details) and the API's global `HttpExceptionFilter` reads nothing else off a
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

import { KvoxApiError, kvoxGet, kvoxPost } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';
import type { TranscriptSegment, TranscriptSpeaker } from './transcripts.js';
import type {
  UpdateTextOp as ContractUpdateTextOp,
  SetSpeakerOp as ContractSetSpeakerOp,
  JoinOp as ContractJoinOp,
  DeleteSegmentOp as ContractDeleteSegmentOp,
  RenameSpeakerOp as ContractRenameSpeakerOp,
  MergeSpeakersOp as ContractMergeSpeakersOp,
  FindReplaceOp as ContractFindReplaceOp,
} from '@marinoscar/kvox-contract/transcripts';

// =============================================================================
// The ops
// =============================================================================

/**
 * Mirror of `editing/ops.ts`'s `OP_TYPES`. Permanent — see the file header.
 *
 * @stability experimental
 */
export const OP_TYPES = {
  /** Replaces a segment's text. */
  UPDATE_TEXT: 'segment.update_text',
  /** Gives a segment to another speaker. */
  SET_SPEAKER: 'segment.set_speaker',
  /** Splits a segment in two. */
  SPLIT: 'segment.split',
  /** Joins two adjacent segments. */
  JOIN: 'segment.join',
  /** Deletes a segment. */
  DELETE: 'segment.delete',
  /** Renames a speaker. */
  RENAME_SPEAKER: 'speaker.rename',
  /** Creates a speaker. */
  CREATE_SPEAKER: 'speaker.create',
  /** Merges speakers into one. */
  MERGE_SPEAKERS: 'speaker.merge',
  /** Replaces every match of a find query. */
  FIND_REPLACE: 'transcript.find_replace',
} as const;

/**
 * The most ops one batch may carry (`MAX_OPS_PER_BATCH`, spec §4.1).
 *
 * @stability experimental
 */
export const MAX_OPS_PER_BATCH = 200;

/**
 * Longest speaker display name the API will store.
 *
 * @stability experimental
 */
export const MAX_SPEAKER_NAME = 120;

/**
 * Longest search or replacement string a find & replace may carry.
 *
 * @stability experimental
 */
export const MAX_FIND_LENGTH = 500;

/**
 * `segment.update_text`: replace one segment's text.
 *
 * @stability experimental
 */
export type UpdateTextOp = ContractUpdateTextOp;

/**
 * `segment.set_speaker`: give one segment to another speaker.
 *
 * @stability experimental
 */
export type SetSpeakerOp = ContractSetSpeakerOp;

/**
 * ⚠ EXACTLY ONE of `atWordIndex` / `atCharOffset`, never both and never
 * neither: the API `.refine()`s on it and answers 400 otherwise. The editor
 * splits at the caret, which is a character offset into the text it rendered —
 * so it sends `atCharOffset` and lets the server resolve the word index it
 * records.
 *
 * @stability experimental
 */
// TODO(web-domain): align with @marinoscar/kvox-contract
export interface SplitOp {
  /** The operation type. */
  op: typeof OP_TYPES.SPLIT;
  /** The segment to split. */
  segmentId: string;
  /** The segment's revision the client saw. */
  rev: number;
  /** Split before this word. */
  atWordIndex?: number;
  /** Split at this character offset into the text. */
  atCharOffset?: number;
  /** The LATER half's speaker, when the split is also a speaker correction. */
  newSpeakerId?: string | null;
}

/**
 * `segment.join`: join two adjacent segments.
 *
 * ⚠ `segmentIds` and `revs` are LENGTH-2 ARRAYS, in reading order, not a pair
 * of scalar fields. The API models them as an array of length two (and
 * deliberately not a tuple, for the OpenAPI reason in `ops.ts`), so the two
 * arrays are positionally paired: `revs[0]` is `segmentIds[0]`'s.
 *
 * @stability experimental
 */
export type JoinOp = ContractJoinOp;

/**
 * `segment.delete`: delete one segment.
 *
 * @stability experimental
 */
export type DeleteSegmentOp = ContractDeleteSegmentOp;

/**
 * `speaker.rename`: rename one speaker.
 *
 * @stability experimental
 */
export type RenameSpeakerOp = ContractRenameSpeakerOp;

/**
 * No id and no colour: both are the server's to choose, and it records them.
 *
 * @stability experimental
 */
// TODO(web-domain): align with @marinoscar/kvox-contract
export interface CreateSpeakerOp {
  /** The operation type. */
  op: typeof OP_TYPES.CREATE_SPEAKER;
  /** The new speaker's name. */
  displayName: string;
}

/**
 * `speaker.merge`: merge speakers into a target.
 *
 * @stability experimental
 */
export type MergeSpeakersOp = ContractMergeSpeakersOp;

/**
 * `transcript.find_replace`: replace every match of a find query.
 *
 * Expanded server-side into concrete `segment.update_text` ops before anything
 * is recorded (spec §4.2), which is why "Replace all" is ONE op and therefore
 * one version however many segments it rewrites.
 *
 * @stability experimental
 */
export type FindReplaceOp = ContractFindReplaceOp;

/**
 * One edit operation of a batch: the union `POST /api/transcripts/:id/operations` accepts.
 *
 * @stability experimental
 */
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

/**
 * What a `speaker.merge` moved, so the UI can offer a real Undo.
 *
 * @stability experimental
 */
export interface MergeUndo {
  /** The speaker the others were merged into. */
  targetId: string;
  /** The speakers that were merged away. */
  sources: {
    /** The merged-away speaker's id. */
    speakerId: string;
    /** Its provider label, or null. */
    label: string | null;
    /** Its display name. */
    displayName: string;
    /** Its palette index. */
    colorIndex: number;
    /** The segments that were on this speaker immediately before the merge. */
    segmentIds: string[];
  }[];
}

/**
 * The result of an accepted batch: the new version and the speakers and segments as they now are.
 *
 * @stability experimental
 */
export interface OperationsResult {
  /** The transcript's version after the batch. */
  version: number;
  /** A one-line description of the batch. */
  summary: string;
  /** True when this response replays an earlier, identical `clientBatchId`. */
  idempotentReplay: boolean;
  /** The speakers as they now are. */
  speakers: TranscriptSpeaker[];
  /** The segments the batch changed. */
  segments: TranscriptSegment[];
  /** One entry per `speaker.merge` in the batch. Empty for every other batch. */
  merges: MergeUndo[];
}

/**
 * The body of `POST /api/transcripts/:id/operations`.
 *
 * @stability experimental
 */
export interface ApplyOperationsInput {
  /** The `currentVersion` this client last saw. Informational — see spec §5. */
  baseVersion: number;
  /** This batch's idempotency key. Reused verbatim by a retry, never a resend. */
  clientBatchId: string;
  /** The operations, applied in order. */
  ops: TranscriptOp[];
}

/**
 * One entity a rejected batch collided with.
 *
 * @stability experimental
 */
export interface OperationsConflictEntity {
  /** Whether the entity is a segment or a speaker. */
  entity: 'segment' | 'speaker';
  /** The id of the segment or speaker. */
  id: string;
  /** The entity's `rev` right now, or null when another editor deleted it. */
  current: number | null;
}

/**
 * The body of the 409 a batch gets when an entity it touched changed underneath it.
 *
 * @stability experimental
 */
export interface OperationsConflict {
  /** The transcript's version right now. */
  currentVersion: number;
  /** The entities that changed underneath the batch. */
  conflicts: OperationsConflictEntity[];
}

/**
 * `POST /api/transcripts/:id/operations`.
 *
 * @stability experimental
 */
export async function applyOperations(
  host: KvoxWebHost,
  id: string,
  input: ApplyOperationsInput,
): Promise<OperationsResult> {
  return kvoxPost<OperationsResult>(
    host,
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
 *
 * @stability experimental
 */
export function parseOperationsConflict(error: unknown): OperationsConflict | null {
  if (!(error instanceof KvoxApiError) || error.status !== 409) return null;

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
 *
 * @stability experimental
 */
export function newClientBatchId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `batch-${uuid}`;
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// =============================================================================
// GET /:id/search
// =============================================================================

/**
 * One occurrence found by `GET /api/transcripts/:id/search`.
 *
 * @stability experimental
 */
export interface TranscriptSearchMatch {
  /** The segment holding the match. */
  segmentId: string;
  /** The segment's speaker. */
  speakerId: string;
  /** Where in the media this line is, so a hit can be played. */
  startMs: number;
  /** Offsets into the segment's own text, in UTF-16 code units. */
  start: number;
  /** Where the match ends, as an offset into the segment's text. */
  end: number;
  /** A short excerpt around the match. */
  preview: string;
}

/**
 * `GET /api/transcripts/:id/search`: the occurrences of a find query.
 *
 * @stability experimental
 */
export interface TranscriptSearchResult {
  /** The query that was run. */
  q: string;
  /** Whether it matched case. */
  matchCase: boolean;
  /** Whether it matched whole words only. */
  wholeWord: boolean;
  /** The speaker it was restricted to, or null. */
  speakerId: string | null;
  /** Every occurrence, even when `matches` was truncated. */
  total: number;
  /** How many segments contain a match. */
  segmentCount: number;
  /** Whether `matches` was cut short of `total`. */
  truncated: boolean;
  /** The occurrences, in reading order. */
  matches: TranscriptSearchMatch[];
}

/**
 * The query of `GET /api/transcripts/:id/search`.
 *
 * @stability experimental
 */
export interface TranscriptSearchParams {
  /** The text to find. */
  q: string;
  /** Match case. */
  matchCase?: boolean;
  /** Match whole words only. */
  wholeWord?: boolean;
  /** Only this speaker's lines. */
  speakerId?: string | null;
  /** The most matches to return. */
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
 *
 * @stability experimental
 */
export async function searchTranscript(
  host: KvoxWebHost,
  id: string,
  params: TranscriptSearchParams,
): Promise<TranscriptSearchResult> {
  const query: Record<string, string> = { q: params.q };
  query.matchCase = params.matchCase ? 'true' : 'false';
  query.wholeWord = params.wholeWord ? 'true' : 'false';
  if (params.speakerId) query.speakerId = params.speakerId;
  if (params.limit !== undefined) query.limit = String(params.limit);

  return kvoxGet<TranscriptSearchResult>(host, `/transcripts/${encodeURIComponent(id)}/search`, {
    query,
  });
}

// =============================================================================
// GET /:id/versions, GET /:id/versions/:v, POST /:id/versions/:v/restore
// =============================================================================

/**
 * How a version came to be: the AI's original, a user edit, or a restore of an earlier version.
 *
 * @stability experimental
 */
export type TranscriptVersionKind = 'ai_original' | 'edit' | 'restore';

/**
 * Who saved a version.
 *
 * @stability experimental
 */
export interface TranscriptVersionAuthor {
  /** The author's user id. */
  id: string;
  /** The author's display name, or null. */
  name: string | null;
  /** The author's email, or null. */
  email: string | null;
}

/**
 * One row of the version history.
 *
 * @stability experimental
 */
export interface TranscriptVersionSummary {
  /** The version number. */
  version: number;
  /** How the version came to be. */
  kind: TranscriptVersionKind;
  /** A one-line description. */
  summary: string | null;
  /**
   * Who saved it, or **null meaning "the AI"** — the schema's own convention
   * (spec §4.5), not a missing value. Only version 1 is ever null.
   */
  author: TranscriptVersionAuthor | null;
  /** The version this one restored, or null. */
  restoredFromVersion: number | null;
  /** Whether a full snapshot is stored for this version. */
  hasSnapshot: boolean;
  /** How many operations the version recorded. */
  opCount: number;
  /** When it was created (ISO 8601). */
  createdAt: string;
}

/**
 * `GET /api/transcripts/:id/versions`: one page of the history, newest first.
 *
 * @stability experimental
 */
export interface TranscriptVersionsResponse {
  /** The transcript's current version. */
  currentVersion: number;
  /** The versions, newest first. */
  items: TranscriptVersionSummary[];
  /** The cursor of the next page, or null at the end. */
  nextCursor: string | null;
}

/**
 * `GET /api/transcripts/:id/versions/:version`: one version, materialized.
 *
 * @stability experimental
 */
export interface TranscriptVersionDetail extends TranscriptVersionSummary {
  /** The transcript's current version, so a viewer knows how far behind this one is. */
  currentVersion: number;
  /** The speakers as of this version. */
  speakers: TranscriptSpeaker[];
  /** Materialized segments, in reading order, WITHOUT word timings. */
  segments: TranscriptSegment[];
}

/**
 * The query of `GET /api/transcripts/:id/versions`.
 *
 * @stability experimental
 */
export interface TranscriptVersionsParams {
  /** The cursor of the page to read. */
  cursor?: string;
  /** The most rows to return. */
  limit?: number;
}

/**
 * `GET /api/transcripts/:id/versions`.
 *
 * @stability experimental
 */
export async function getTranscriptVersions(
  host: KvoxWebHost,
  id: string,
  params: TranscriptVersionsParams = {},
): Promise<TranscriptVersionsResponse> {
  const query: Record<string, string> = {};
  if (params.cursor) query.cursor = params.cursor;
  if (params.limit !== undefined) query.limit = String(params.limit);
  return kvoxGet<TranscriptVersionsResponse>(host, `/transcripts/${encodeURIComponent(id)}/versions`, {
    query,
  });
}

/**
 * `GET /api/transcripts/:id/versions/:v`.
 *
 * A **409** here is not a conflict in the concurrency sense: it means this
 * version predates the first snapshot and cannot be rebuilt yet. The preview
 * renders that as "not available yet", never as an error the reader caused.
 *
 * @stability experimental
 */
export async function getTranscriptVersion(
  host: KvoxWebHost,
  id: string,
  version: number,
): Promise<TranscriptVersionDetail> {
  return kvoxGet<TranscriptVersionDetail>(
    host,
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
 *
 * @stability experimental
 */
export async function restoreTranscriptVersion(
  host: KvoxWebHost,
  id: string,
  version: number,
  baseVersion: number,
): Promise<OperationsResult> {
  return kvoxPost<OperationsResult>(
    host,
    `/transcripts/${encodeURIComponent(id)}/versions/${version}/restore`,
    { baseVersion },
  );
}
