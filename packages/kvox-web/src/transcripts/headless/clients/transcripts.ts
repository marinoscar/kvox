/**
 * The transcripts API, as a host sees it — issue #30, epic #19.
 *
 * The backend half is `packages/kvox-api/src/transcripts/transcripts.controller.ts` and
 * `dto/transcript.dto.ts`; every type below is a hand-written mirror of a Zod
 * schema in that file, named identically so the two can be diffed by eye. Every
 * call takes the {@link KvoxWebHost} first and goes through the `kvox*` helpers
 * of the core slice, so the transport (the bearer token, the one-shot
 * 401 → refresh → retry, the maintenance recogniser) stays the host's.
 *
 * =============================================================================
 * TWO OF THE ELEVEN CALLS ARE CONDITIONAL GETS, AND THAT IS THE POINT
 * =============================================================================
 *
 * `GET /:id` and `GET /:id/segments` answer a weak ETag (`W/"v<n>"`) and a
 * `304` to a matching `If-None-Match`. A plain JSON request returns the parsed
 * payload and nothing else, so a caller can never see the `ETag` header it
 * would have to send back, and a `304` carries no body to unwrap. Those two
 * calls therefore use `host.http.requestWithMeta` (`kvoxGetWithMeta`), which
 * reports the status and the headers and resolves on a `304`.
 *
 * That matters because `useTranscript` polls those two routes every five
 * seconds while a transcript is processing. Without the validator, every poll
 * ships the full detail payload — speakers, statuses, the lot — for an answer
 * that has not moved; with it, the common case costs a request line and a
 * header block.
 *
 * `conditionalGet` below is NARROW: it adds the `If-None-Match` header when it
 * has a validator and folds the answer into {@link ConditionalResult}. The 401
 * path and the URL base are the host's, so a token that expires mid-poll is
 * refreshed by the ONE implementation that knows how.
 */

import { kvoxDelete, kvoxGet, kvoxGetWithMeta, kvoxPatch, kvoxPost } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';

// =============================================================================
// The shapes (mirrors of `dto/transcript.dto.ts`)
// =============================================================================

/**
 * `transcripts.status` — the top-level lifecycle (spec §1.1).
 *
 * @stability experimental
 */
export type TranscriptStatus =
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleting';

/**
 * `transcription_status` — the provider round trip (spec §1.2).
 *
 * @stability experimental
 */
export type TranscriptionStatus =
  | 'waiting_input'
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * `playback_status` — the transcode sub-pipeline (spec §1.3).
 *
 * @stability experimental
 */
export type PlaybackStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'not_needed';

/**
 * How the CALLER reaches a transcript — not the owner's relationship to it.
 *
 * @stability experimental
 */
export type TranscriptAccessRole = 'owner' | 'editor' | 'viewer';

/**
 * One speaker of a transcript, as `GET /api/transcripts/:id` lists them.
 *
 * @stability experimental
 */
export interface TranscriptSpeaker {
  /** The speaker's id. */
  id: string;
  /** The provider's own label (`"A"`), or null for a user-created speaker. */
  label: string | null;
  /** The name shown for the speaker. */
  displayName: string;
  /** Stable index into the client's speaker palette — see `speakerColor`. */
  colorIndex: number;
  /** The revision of the entity, compared when an edit is applied. */
  rev: number;
}

/**
 * One word timing. Terse keys, because a long transcript has millions.
 *
 * @stability experimental
 */
export interface TranscriptWord {
  /** The word itself. */
  t: string;
  /** Start, milliseconds from the beginning of the media. */
  s: number;
  /** End, milliseconds from the beginning of the media. */
  e: number;
  /** Provider confidence 0..1, or null when it reported none. */
  c: number | null;
}

/**
 * One segment, WITHOUT its words. See `GET /:id/words` for those.
 *
 * @stability experimental
 */
export interface TranscriptSegment {
  /** The segment's id. */
  id: string;
  /** The speaker. */
  speakerId: string;
  /** Where it starts in the media, in milliseconds. */
  startMs: number;
  /** Where it ends in the media, in milliseconds. */
  endMs: number;
  /** Gap-based float, so an insert needs no renumbering (spec §3.4). */
  ordinal: number;
  /** The segment's text. */
  text: string;
  /** How well the word timings line up with the text: exact, interpolated or none. */
  wordsAlignment: 'exact' | 'interpolated' | 'none';
  /** The provider's confidence from 0 to 1, or null. */
  confidence: number | null;
  /** Whether the text is the AI's or a user's. */
  origin: 'ai' | 'user';
  /** The revision of the entity, compared when an edit is applied. */
  rev: number;
  /** When a user last edited it (ISO 8601), or null. */
  editedAt: string | null;
}

/**
 * The word timings of one segment (`GET /api/transcripts/:id/words`).
 *
 * @stability experimental
 */
export interface TranscriptSegmentWords {
  /** The segment these words belong to. */
  segmentId: string;
  /** Where the segment starts in the media, in milliseconds. */
  startMs: number;
  /** Where the segment ends in the media, in milliseconds. */
  endMs: number;
  /** How well the word timings line up with the text. */
  wordsAlignment: 'exact' | 'interpolated' | 'none';
  /** The words with their timings. */
  words: TranscriptWord[];
}

/**
 * The list-row projection: everything a card needs, nothing more.
 *
 * @stability experimental
 */
export interface TranscriptListItem {
  /** The transcript's id. */
  id: string;
  /** The title the owner gave, or the file name. */
  title: string;
  /** The overall status. */
  status: TranscriptStatus;
  /** The transcription sub-pipeline's status. */
  transcriptionStatus: TranscriptionStatus;
  /** The playback transcode sub-pipeline's status. */
  playbackStatus: PlaybackStatus;
  /** The language code, or null when it was detected or unknown. */
  language: string | null;
  /** The recording's length in milliseconds, or null while unknown. */
  durationMs: number | null;
  /** How many speakers the transcript has. */
  speakerCount: number;
  /** How many words the transcript has. */
  wordCount: number;
  /** The transcript's current version number. */
  currentVersion: number;
  /** Why processing failed, verbatim from the provider, or null. */
  failureReason: string | null;
  /** How the caller reaches the transcript. */
  access: TranscriptAccessRole;
  /**
   * The owner's display name, on EVERY row rather than only shared ones.
   *
   * Issue #29 populates it for owned rows too (the caller's own name), which
   * is what lets a "shared with me" surface render an owner without branching
   * on `access` first — and what stops a list that mixes both kinds needing
   * two row types. The API declares it required, so it is not optional here.
   */
  ownerName: string;
  /**
   * Whether the transcript has a recording to play (#571): `false` for one
   * imported from a `kvox.transcript/v1` file, whose audio URL answers 404;
   * `true` otherwise.
   */
  hasAudio: boolean;
  /**
   * When the recording was made (ISO 8601), issue #352. Defaults to the upload
   * instant; the owner or an editor can correct it. Connected knowledge reads
   * it as the meeting date, so it is never the same fact as `createdAt`.
   */
  recordedAt: string;
  /** When it was created (ISO 8601). */
  createdAt: string;
  /** When it last changed (ISO 8601). */
  updatedAt: string;
}

/**
 * `GET /api/transcripts/:id`.
 *
 * @stability experimental
 */
export interface TranscriptDetail extends TranscriptListItem {
  /** The transcript's speakers. */
  speakers: TranscriptSpeaker[];
  /** Which provider transcribed this. Named for the privacy notice (spec §10). */
  provider: string;
  /** When the provider's copy was deleted, or null if it still exists. */
  remoteDeletedAt: string | null;
  /** When the audio was submitted to the provider, or null. */
  submittedAt: string | null;
  /** When transcription completed, or null. */
  completedAt: string | null;
  /** The uploaded file's name. */
  sourceName: string;
  /** The uploaded file's media type. */
  sourceMimeType: string;
  /** A DECIMAL STRING, not a number — the API sends `bytes` as text. */
  sourceSizeBytes: string;
}

/**
 * `GET /api/transcripts`: one page of the library.
 *
 * @stability experimental
 */
export interface TranscriptListResponse {
  /** The rows of this page, newest first. */
  items: TranscriptListItem[];
  /**
   * How many rows match the current filters, ignoring paging.
   *
   * THE FILTERS, NOT THE TABLE, and not "how many are left". Identical on page
   * one and on every `loadMore` for an unchanged filter set, so the result
   * count line can be rendered once and does not fall as the user pages.
   */
  total: number;

  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

/**
 * `GET /api/transcripts/:id/segments`: every segment of the current version.
 *
 * @stability experimental
 */
export interface TranscriptSegmentsResponse {
  /** The version these segments belong to. */
  currentVersion: number;
  /** The segments, in reading order. */
  segments: TranscriptSegment[];
}

/**
 * `GET /api/transcripts/:id/words`: the word timings of the segments inside a time window.
 *
 * @stability experimental
 */
export interface TranscriptWordsResponse {
  /** The version these timings belong to. */
  currentVersion: number;
  /** The window's start in the media, in milliseconds. */
  fromMs: number;
  /** The window's end in the media, in milliseconds. */
  toMs: number;
  /** The segments inside the window, each with its words. */
  segments: TranscriptSegmentWords[];
}

/**
 * `GET /api/transcripts/summary`: everything the home page needs in one request.
 *
 * @stability experimental
 */
export interface TranscriptSummary {
  /**
   * Transcripts still uploading or processing, including those shared with the caller.
   */
  inProgress: TranscriptListItem[];
  /** The caller's most recent transcripts. */
  recent: TranscriptListItem[];
  /** The most recent transcripts shared with the caller. */
  sharedWithMe: TranscriptListItem[];
  /**
   * The caller's OWN failed transcripts, newest first, capped at eight (#171).
   *
   * Owner-scoped where `inProgress` unions the caller's shares, because
   * `POST /api/transcripts/:id/retry` is owner-only: somebody else's failure is not
   * an item this user can act on. `counts.failed` below stays the TRUE total
   * from its own `count()`, so a user with thirty failures reads thirty there
   * while this list still carries eight — see the API's `summary()` header.
   */
  failed: TranscriptListItem[];
  /** The true totals, independent of how many rows each list carries. */
  counts: {
    /** How many transcripts the caller owns. */
    owned: number;
    /** How many are shared with the caller. */
    shared: number;
    /**
     * Transcripts still uploading or processing, including those shared with the caller.
     */
    inProgress: number;
    /** How many of the caller's own transcripts failed. */
    failed: number;
  };
}

/**
 * `GET /api/transcripts/:id/audio`.
 *
 * @stability experimental
 */
export interface TranscriptAudio {
  /** Short-lived signed GET. Never a permanent link. */
  url: string;
  /** Which file the URL points at: the rendition when ready, else the upload. */
  kind: 'playback' | 'original';
  /** The media type of the file the URL points at. */
  mimeType: string;
  /** When the URL stops working (ISO 8601). */
  expiresAt: string;
}

/**
 * The file the browser is about to upload. `size` is the client's claim.
 *
 * @stability experimental
 */
export interface CreateTranscriptSource {
  /** The file's name. */
  name: string;
  /** The file's size in bytes, as the client claims it. */
  size: number;
  /** The file's media type. */
  mimeType?: string;
}

/**
 * The body of `POST /api/transcripts`.
 *
 * @stability experimental
 */
export interface CreateTranscriptInput {
  /** The title; defaults to the file name. */
  title?: string;
  /** Null or omitted means "let the provider detect it". */
  language?: string | null;
  /** A HINT the provider may bias diarization with. 1–50, or null for auto. */
  speakersExpected?: number | null;
  /**
   * Names and terms the provider should expect (#327). The server trims and
   * de-duplicates case-insensitively; omit when empty.
   */
  keyterms?: string[];
  /** The file the browser is about to upload. */
  source: CreateTranscriptSource;
}

/**
 * `POST /api/transcripts` — the transcript AND the upload it is waiting for.
 *
 * Both in one response because creating a transcript and beginning its upload
 * are one user action and two rows; see the DTO's own header for why the API
 * refuses to let a client get one without the other.
 *
 * @stability experimental
 */
export interface CreateTranscriptResponse {
  /** The transcript. */
  transcript: TranscriptDetail;
  /** The multipart upload to perform. */
  upload: {
    /** The storage object being uploaded. */
    objectId: string;
    /** The multipart upload id. */
    uploadId: string;
    /** The size of every part but the last, in bytes. */
    partSize: number;
    /** How many parts the file is split into. */
    totalParts: number;
    /** One short-lived signed URL per part. */
    presignedUrls: {
      /** The 1-based part number. */
      partNumber: number;
      /** The signed URL for that part. */
      url: string;
    }[];
  };
}

/**
 * Whose transcripts a list covers. `'all'` is an API value with no library tab.
 *
 * @stability experimental
 */
export type TranscriptScope = 'owned' | 'shared' | 'all';

/**
 * The query of `GET /api/transcripts`.
 *
 * @stability experimental
 */
export interface TranscriptListParams {
  /** Whose transcripts to list; defaults to the caller's own. */
  scope?: TranscriptScope;
  /** Only transcripts in this status. */
  status?: TranscriptStatus;
  /** Case-insensitive substring of the title. */
  q?: string;
  /** The cursor of the page to read. */
  cursor?: string;
  /** The most rows to return. */
  limit?: number;
}

// =============================================================================
// Conditional GET — the ETag path. See the file header for why it exists.
// =============================================================================

/**
 * The result of a conditional read: either fresh data with the validator to
 * send next time, or the server saying "you already have this".
 *
 * A DISCRIMINATED UNION rather than `T | null`, because `null` would collide
 * with a legitimately empty body and — more importantly — would give the
 * caller no way to distinguish "unchanged" (keep what you have, and it is
 * current) from "failed" (keep what you have, and it may be stale). Those need
 * different treatment in a polling hook: one clears the error, one sets it.
 *
 * @stability experimental
 */
export type ConditionalResult<T> =
  | {
      /** Fresh data came back. */
      status: 'ok';
      /** The fresh data. */
      data: T;
      /** The validator to send as `If-None-Match` next time. */
      etag: string | null;
    }
  | {
      /** The server answered 304: what the caller holds is current. */
      status: 'not-modified';
    };

async function conditionalGet<T>(
  host: KvoxWebHost,
  endpoint: string,
  etag: string | null,
): Promise<ConditionalResult<T>> {
  // Sent only when we HAVE one. An `If-None-Match: null` would be a
  // syntactically valid header the server compares against and never
  // matches — a poll that silently lost its own optimisation.
  const response = await kvoxGetWithMeta<T>(host, endpoint, {
    ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
  });

  if (response.status === 304) return { status: 'not-modified' };

  return {
    status: 'ok',
    data: response.data as T,
    etag: response.headers.get('ETag'),
  };
}

// =============================================================================
// Reads
// =============================================================================

/**
 * `GET /api/transcripts`.
 *
 * @stability experimental
 */
export async function getTranscripts(
  host: KvoxWebHost,
  params: TranscriptListParams = {},
): Promise<TranscriptListResponse> {
  const query: Record<string, string> = {};
  if (params.scope) query.scope = params.scope;
  if (params.status) query.status = params.status;
  // Trimmed-empty is omitted rather than sent: `q=` is a filter the API would
  // apply, and "title contains the empty string" is not what the user meant by
  // clearing the box.
  if (params.q && params.q.trim()) query.q = params.q.trim();
  if (params.cursor) query.cursor = params.cursor;
  if (params.limit !== undefined) query.limit = String(params.limit);

  return kvoxGet<TranscriptListResponse>(host, '/transcripts', { query });
}

/**
 * `GET /api/transcripts/summary` — the home page's one request (#32).
 *
 * @stability experimental
 */
export async function getTranscriptSummary(host: KvoxWebHost): Promise<TranscriptSummary> {
  return kvoxGet<TranscriptSummary>(host, '/transcripts/summary');
}

/**
 * `GET /api/transcripts/:id`, conditionally.
 *
 * @stability experimental
 */
export async function getTranscript(
  host: KvoxWebHost,
  id: string,
  etag: string | null = null,
): Promise<ConditionalResult<TranscriptDetail>> {
  return conditionalGet<TranscriptDetail>(host, `/transcripts/${encodeURIComponent(id)}`, etag);
}

/**
 * `GET /api/transcripts/:id/segments`, conditionally.
 *
 * @stability experimental
 */
export async function getTranscriptSegments(
  host: KvoxWebHost,
  id: string,
  etag: string | null = null,
): Promise<ConditionalResult<TranscriptSegmentsResponse>> {
  return conditionalGet<TranscriptSegmentsResponse>(
    host,
    `/transcripts/${encodeURIComponent(id)}/segments`,
    etag,
  );
}

/**
 * `GET /api/transcripts/:id/words` — word timings for ONE window.
 *
 * A window, never the whole transcript: a ten-hour recording's word index is
 * hundreds of megabytes. `toMs` is capped at thirty minutes past `fromMs`
 * server-side and a wider ask is silently narrowed, so the response echoes the
 * window actually served.
 *
 * @stability experimental
 */
export async function getTranscriptWords(
  host: KvoxWebHost,
  id: string,
  fromMs: number,
  toMs?: number,
): Promise<TranscriptWordsResponse> {
  const query: Record<string, string> = { fromMs: String(Math.max(0, Math.floor(fromMs))) };
  if (toMs !== undefined) query.toMs = String(Math.floor(toMs));
  return kvoxGet<TranscriptWordsResponse>(host, `/transcripts/${encodeURIComponent(id)}/words`, {
    query,
  });
}

/**
 * `GET /api/transcripts/:id/audio` — a short-lived signed URL.
 *
 * @stability experimental
 */
export async function getTranscriptAudio(host: KvoxWebHost, id: string): Promise<TranscriptAudio> {
  return kvoxGet<TranscriptAudio>(host, `/transcripts/${encodeURIComponent(id)}/audio`);
}

// =============================================================================
// Writes
// =============================================================================

/**
 * `POST /api/transcripts` — creates the row AND initialises its upload.
 *
 * @stability experimental
 */
export async function createTranscript(
  host: KvoxWebHost,
  input: CreateTranscriptInput,
): Promise<CreateTranscriptResponse> {
  return kvoxPost<CreateTranscriptResponse>(host, '/transcripts', input);
}

/**
 * Body of `PATCH /api/transcripts/:id`. At least one field must be present.
 *
 * @stability experimental
 */
export interface UpdateTranscriptInput {
  /** The new title. */
  title?: string;
  /** ISO 8601 with an offset — `Date.prototype.toISOString()` output qualifies. */
  recordedAt?: string;
}

/**
 * `PATCH /api/transcripts/:id` — title and/or recording date. Not versioned:
 * both are metadata about the recording, not content of it. The 200 body is
 * the fresh detail, which callers apply directly.
 *
 * @stability experimental
 */
export async function updateTranscript(
  host: KvoxWebHost,
  id: string,
  input: UpdateTranscriptInput,
): Promise<TranscriptDetail> {
  return kvoxPatch<TranscriptDetail>(host, `/transcripts/${encodeURIComponent(id)}`, input);
}

/**
 * `PATCH /api/transcripts/:id` with a title only. Kept for existing callers.
 *
 * @stability experimental
 */
export async function renameTranscript(
  host: KvoxWebHost,
  id: string,
  title: string,
): Promise<TranscriptDetail> {
  return updateTranscript(host, id, { title });
}

/**
 * `DELETE /api/transcripts/:id`. Owner only, and there is no path back.
 *
 * @stability experimental
 */
export async function deleteTranscript(host: KvoxWebHost, id: string): Promise<void> {
  await kvoxDelete<void>(host, `/transcripts/${encodeURIComponent(id)}`);
}

/**
 * `POST /api/transcripts/:id/retry`. Owner only; the stage is derived server-side.
 *
 * @stability experimental
 */
export async function retryTranscript(host: KvoxWebHost, id: string): Promise<TranscriptDetail> {
  return kvoxPost<TranscriptDetail>(host, `/transcripts/${encodeURIComponent(id)}/retry`);
}

/**
 * `POST /api/transcripts/:id/cancel`. Owner only.
 *
 * @stability experimental
 */
export async function cancelTranscript(host: KvoxWebHost, id: string): Promise<TranscriptDetail> {
  return kvoxPost<TranscriptDetail>(host, `/transcripts/${encodeURIComponent(id)}/cancel`);
}

