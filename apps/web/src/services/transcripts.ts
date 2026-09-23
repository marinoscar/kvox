/**
 * The transcripts API, as the web app sees it — issue #30, epic #19.
 *
 * The backend half is `apps/api/src/transcripts/transcripts.controller.ts` and
 * `dto/transcript.dto.ts`; every type below is a hand-written mirror of a Zod
 * schema in that file, named identically so the two can be diffed by eye. This
 * module is shaped after `services/transcription.ts`: `services/api.ts` stays
 * the transport (the bearer token, the one-shot 401 → refresh → retry, the
 * maintenance recogniser) and this file holds the calls next to the types they
 * produce.
 *
 * =============================================================================
 * TWO OF THE ELEVEN CALLS DO NOT GO THROUGH `api.get`, AND THAT IS THE POINT
 * =============================================================================
 *
 * `GET /:id` and `GET /:id/segments` answer a weak ETag (`W/"v<n>"`) and a
 * `304` to a matching `If-None-Match`. `ApiService.request` cannot express
 * either half: it returns the parsed `{ data }` envelope and nothing else, so
 * a caller can never see the `ETag` header it would have to send back, and a
 * `304` carries no body for it to unwrap.
 *
 * That matters because `useTranscript` polls those two routes every five
 * seconds while a transcript is processing. Without the validator, every poll
 * ships the full detail payload — speakers, statuses, the lot — for an answer
 * that has not moved; with it, the common case costs a request line and a
 * header block. So `conditionalGet` below issues the raw `fetch` those two
 * calls need.
 *
 * It is a NARROW deviation, not a second client. It resolves its URL against
 * the same `API_BASE_URL` (never a second literal `'/api'` — see that
 * constant's own comment), sends the same bearer token, and delegates the 401
 * path to `api.refreshToken()` so a token that expires mid-poll is refreshed
 * by the ONE implementation that knows how, rather than by a copy here that
 * could race it. What it deliberately does NOT reimplement is the maintenance
 * recogniser: a poll that 503s during a window is one the caller should simply
 * leave stale until the window closes, and the gate is already being tripped
 * by every other request the page makes.
 */

import { api, ApiError, API_BASE_URL } from './api';

// =============================================================================
// The shapes (mirrors of `dto/transcript.dto.ts`)
// =============================================================================

/** `transcripts.status` — the top-level lifecycle (spec §1.1). */
export type TranscriptStatus =
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleting';

/** `transcription_status` — the provider round trip (spec §1.2). */
export type TranscriptionStatus =
  | 'waiting_input'
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** `playback_status` — the transcode sub-pipeline (spec §1.3). */
export type PlaybackStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'not_needed';

/** How the CALLER reaches a transcript — not the owner's relationship to it. */
export type TranscriptAccessRole = 'owner' | 'editor' | 'viewer';

export interface TranscriptSpeaker {
  id: string;
  /** The provider's own label (`"A"`), or null for a user-created speaker. */
  label: string | null;
  displayName: string;
  /** Stable index into the client's speaker palette — see `speakerColor`. */
  colorIndex: number;
  rev: number;
}

/** One word timing. Terse keys, because a long transcript has millions. */
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

/** One segment, WITHOUT its words. See `GET /:id/words` for those. */
export interface TranscriptSegment {
  id: string;
  speakerId: string;
  startMs: number;
  endMs: number;
  /** Gap-based float, so an insert needs no renumbering (spec §3.4). */
  ordinal: number;
  text: string;
  wordsAlignment: 'exact' | 'interpolated' | 'none';
  confidence: number | null;
  origin: 'ai' | 'user';
  rev: number;
  editedAt: string | null;
}

export interface TranscriptSegmentWords {
  segmentId: string;
  startMs: number;
  endMs: number;
  wordsAlignment: 'exact' | 'interpolated' | 'none';
  words: TranscriptWord[];
}

/** The list-row projection: everything a card needs, nothing more. */
export interface TranscriptListItem {
  id: string;
  title: string;
  status: TranscriptStatus;
  transcriptionStatus: TranscriptionStatus;
  playbackStatus: PlaybackStatus;
  language: string | null;
  durationMs: number | null;
  speakerCount: number;
  wordCount: number;
  currentVersion: number;
  failureReason: string | null;
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
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/transcripts/:id`. */
export interface TranscriptDetail extends TranscriptListItem {
  speakers: TranscriptSpeaker[];
  /** Which provider transcribed this. Named for the privacy notice (spec §10). */
  provider: string;
  remoteDeletedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  sourceName: string;
  sourceMimeType: string;
  /** A DECIMAL STRING, not a number — the API sends `bytes` as text. */
  sourceSizeBytes: string;
}

export interface TranscriptListResponse {
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

export interface TranscriptSegmentsResponse {
  currentVersion: number;
  segments: TranscriptSegment[];
}

export interface TranscriptWordsResponse {
  currentVersion: number;
  fromMs: number;
  toMs: number;
  segments: TranscriptSegmentWords[];
}

export interface TranscriptSummary {
  inProgress: TranscriptListItem[];
  recent: TranscriptListItem[];
  sharedWithMe: TranscriptListItem[];
  /**
   * The caller's OWN failed transcripts, newest first, capped at eight (#171).
   *
   * Owner-scoped where `inProgress` unions the caller's shares, because `POST
   * /api/transcripts/:id/retry` is owner-only: somebody else's failure is not
   * an item this user can act on. `counts.failed` below stays the TRUE total
   * from its own `count()`, so a user with thirty failures reads thirty there
   * while this list still carries eight — see the API's `summary()` header.
   */
  failed: TranscriptListItem[];
  counts: {
    owned: number;
    shared: number;
    inProgress: number;
    failed: number;
  };
}

/** `GET /api/transcripts/:id/audio`. */
export interface TranscriptAudio {
  /** Short-lived signed GET. Never a permanent link. */
  url: string;
  /** Which file the URL points at: the rendition when ready, else the upload. */
  kind: 'playback' | 'original';
  mimeType: string;
  expiresAt: string;
}

/** The file the browser is about to upload. `size` is the client's claim. */
export interface CreateTranscriptSource {
  name: string;
  size: number;
  mimeType?: string;
}

export interface CreateTranscriptInput {
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
  source: CreateTranscriptSource;
}

/**
 * `POST /api/transcripts` — the transcript AND the upload it is waiting for.
 *
 * Both in one response because creating a transcript and beginning its upload
 * are one user action and two rows; see the DTO's own header for why the API
 * refuses to let a client get one without the other.
 */
export interface CreateTranscriptResponse {
  transcript: TranscriptDetail;
  upload: {
    objectId: string;
    uploadId: string;
    partSize: number;
    totalParts: number;
    presignedUrls: { partNumber: number; url: string }[];
  };
}

export type TranscriptScope = 'owned' | 'shared' | 'all';

export interface TranscriptListParams {
  scope?: TranscriptScope;
  status?: TranscriptStatus;
  /** Case-insensitive substring of the title. */
  q?: string;
  cursor?: string;
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
 */
export type ConditionalResult<T> =
  | { status: 'ok'; data: T; etag: string | null }
  | { status: 'not-modified' };

async function conditionalGet<T>(
  endpoint: string,
  etag: string | null,
): Promise<ConditionalResult<T>> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    const token = api.getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    // Sent only when we HAVE one. An `If-None-Match: null` would be a
    // syntactically valid header the server compares against and never
    // matches — a poll that silently lost its own optimisation.
    if (etag) headers['If-None-Match'] = etag;

    return fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'GET',
      headers,
      credentials: 'include',
    });
  };

  let response = await send();

  // The 401 path is delegated, never reimplemented: `ApiService` dedupes
  // concurrent refreshes behind one promise, and a second implementation here
  // would race it and burn the rotating refresh token.
  if (response.status === 401) {
    const refreshed = await api.refreshToken();
    if (!refreshed) throw new ApiError('Unauthorized', 401);
    response = await send();
  }

  if (response.status === 304) return { status: 'not-modified' };

  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as { message?: string; code?: string });
    throw new ApiError(body.message || 'Request failed', response.status, body.code);
  }

  const payload = await response.json();
  return {
    status: 'ok',
    // The same `{ data }` envelope `ApiService.readResponse` unwraps.
    data: (payload.data ?? payload) as T,
    etag: response.headers.get('ETag'),
  };
}

// =============================================================================
// Reads
// =============================================================================

/** `GET /api/transcripts`. */
export async function getTranscripts(
  params: TranscriptListParams = {},
): Promise<TranscriptListResponse> {
  const query = new URLSearchParams();
  if (params.scope) query.set('scope', params.scope);
  if (params.status) query.set('status', params.status);
  // Trimmed-empty is omitted rather than sent: `q=` is a filter the API would
  // apply, and "title contains the empty string" is not what the user meant by
  // clearing the box.
  if (params.q && params.q.trim()) query.set('q', params.q.trim());
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));

  const suffix = query.toString();
  return api.get<TranscriptListResponse>(`/transcripts${suffix ? `?${suffix}` : ''}`);
}

/** `GET /api/transcripts/summary` — the home page's one request (#32). */
export async function getTranscriptSummary(): Promise<TranscriptSummary> {
  return api.get<TranscriptSummary>('/transcripts/summary');
}

/** `GET /api/transcripts/:id`, conditionally. */
export async function getTranscript(
  id: string,
  etag: string | null = null,
): Promise<ConditionalResult<TranscriptDetail>> {
  return conditionalGet<TranscriptDetail>(`/transcripts/${encodeURIComponent(id)}`, etag);
}

/** `GET /api/transcripts/:id/segments`, conditionally. */
export async function getTranscriptSegments(
  id: string,
  etag: string | null = null,
): Promise<ConditionalResult<TranscriptSegmentsResponse>> {
  return conditionalGet<TranscriptSegmentsResponse>(
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
 */
export async function getTranscriptWords(
  id: string,
  fromMs: number,
  toMs?: number,
): Promise<TranscriptWordsResponse> {
  const query = new URLSearchParams({ fromMs: String(Math.max(0, Math.floor(fromMs))) });
  if (toMs !== undefined) query.set('toMs', String(Math.floor(toMs)));
  return api.get<TranscriptWordsResponse>(
    `/transcripts/${encodeURIComponent(id)}/words?${query.toString()}`,
  );
}

/** `GET /api/transcripts/:id/audio` — a short-lived signed URL. */
export async function getTranscriptAudio(id: string): Promise<TranscriptAudio> {
  return api.get<TranscriptAudio>(`/transcripts/${encodeURIComponent(id)}/audio`);
}

// =============================================================================
// Writes
// =============================================================================

/** `POST /api/transcripts` — creates the row AND initialises its upload. */
export async function createTranscript(
  input: CreateTranscriptInput,
): Promise<CreateTranscriptResponse> {
  return api.post<CreateTranscriptResponse>('/transcripts', input);
}

/** `PATCH /api/transcripts/:id` — title only, and not versioned. */
export async function renameTranscript(
  id: string,
  title: string,
): Promise<TranscriptDetail> {
  return api.patch<TranscriptDetail>(`/transcripts/${encodeURIComponent(id)}`, { title });
}

/** `DELETE /api/transcripts/:id`. Owner only, and there is no path back. */
export async function deleteTranscript(id: string): Promise<void> {
  await api.delete<void>(`/transcripts/${encodeURIComponent(id)}`);
}

/** `POST /api/transcripts/:id/retry`. Owner only; the stage is derived server-side. */
export async function retryTranscript(id: string): Promise<TranscriptDetail> {
  return api.post<TranscriptDetail>(`/transcripts/${encodeURIComponent(id)}/retry`);
}

/** `POST /api/transcripts/:id/cancel`. Owner only. */
export async function cancelTranscript(id: string): Promise<TranscriptDetail> {
  return api.post<TranscriptDetail>(`/transcripts/${encodeURIComponent(id)}/cancel`);
}

