// =============================================================================
// The streaming contract, as data (issue #52, epic #45, docs/specs/notes.md §5)
// =============================================================================
//
// Everything in this file is PURE: no Prisma, no `@Injectable`, no clock, no
// timers. It owns the two decisions the stream is made of —
//
//   • "what text has this client not seen yet?" ({@link KvoxStreamCursor}), and
//   • "what does a frame look like on the wire?" (the three builders below)
//
// — so both can be tested by calling a function with a string, and so the poll
// loop in `note-generation-stream.service.ts` is left containing nothing but
// scheduling and I/O. The same discipline `stream-flusher.ts` states for the
// WRITE side, applied to the READ side.
//
// -----------------------------------------------------------------------------
// ⚠ `id:` IS THE BUFFER OFFSET, NOT `note_generations.last_event_id`
// -----------------------------------------------------------------------------
//
// This is a deliberate divergence from docs/specs/notes.md §5.2, which
// described `id:` as the row's `last_event_id` counter. ISSUE #52 SPECIFIES
// THE OFFSET — "every frame carries a monotonic `id:` equal to the buffer
// offset it ends at" — and the issue wins where the two disagree.
//
// It is also the better of the two, for a reason worth recording so nobody
// "restores" the spec's version later: resume is a SUBSTRING SLICE. An offset
// answers `content.slice(offset)` directly and needs nothing else to be true;
// the row's counter answers it only via a second mapping from "flush number" to
// "character position" that nothing stores and nothing could reconstruct after
// the fact. With offsets, a resumed connection cannot repeat or skip a byte
// even if a flush was lost, a row was rewritten, or the client's id came from
// a different build. `last_event_id` stays exactly as #49 writes it — it is
// still the cheap "has anything changed?" signal a note detail page reads — it
// simply is not what travels as `id:`.
//
// OFFSETS ARE UTF-16 CODE-UNIT INDICES, matching `String.prototype.slice`,
// which is what makes `slice(offset)` and `id: <length>` the same number by
// construction. Every boundary this file ever slices at is a length the WRITER
// already produced (the flusher writes whole accumulated content, never a
// fragment of a delta), so a boundary can never land inside a surrogate pair.
// =============================================================================

/**
 * The `event:` name of a frame that carries appended text.
 *
 * @stability experimental
 */
export const KVOX_STREAM_DELTA_EVENT = 'delta';

/**
 * The `event:` name of the frame that ends a stream successfully.
 *
 * @stability experimental
 */
export const KVOX_STREAM_DONE_EVENT = 'done';

/**
 * The `event:` name of the frame that ends a stream with a failure.
 *
 * @stability experimental
 */
export const KVOX_STREAM_ERROR_EVENT = 'error';

/**
 * What an `error` frame blames.
 *
 * The first four are `note_generations.error_class` verbatim — the classes #49
 * records. The last two are WIRE-ONLY and never exist in the database, because
 * neither is a property of the generation:
 *
 *   • `timeout` — the connection hit its duration cap while the generation was
 *     still not terminal. The JOB may well be fine; this is the reader giving
 *     up, not the work failing.
 *   • `gone` — the row disappeared mid-connection (a preview's TTL sweep, or
 *     the parent note being purged). There is no row left to carry a class.
 *
 * @stability experimental
 */
export type KvoxStreamErrorClass =
  | 'auth'
  | 'refusal'
  | 'rate_limit'
  | 'other'
  | 'timeout'
  | 'gone';

/**
 * `event: delta` — the text appended since the client's position.
 *
 * @stability experimental
 */
export interface KvoxStreamDeltaData {
  /** The text appended since the client's position. */
  delta: string;
  /**
   * The buffer offset this frame ends at — the same number as its `id:`.
   *
   * Duplicated into the body ON PURPOSE, and it cannot disagree with the `id:`
   * because both are rendered from this one field ({@link toDeltaFrame}). A
   * client that only ever looks at `data` (the overwhelmingly common shape for
   * a hand-rolled parser) can still resume, instead of having to plumb the
   * protocol-level `id` field through to its own state.
   */
  offset: number;
}

/**
 * `event: done` — the generation settled successfully.
 *
 * @stability experimental
 */
export interface KvoxStreamDoneData {
  /** Always `succeeded`. */
  status: 'succeeded';
  /** The buffer offset this frame ends at — the same number as its `id:`. */
  offset: number;
  /**
   * The note's `currentVersion` after the commit, or `null` for a PREVIEW.
   *
   * `null` is a statement, not a missing value: a preview has no note, writes
   * no `note_versions` row, and therefore has no version to name.
   */
  currentVersion: number | null;
}

/**
 * `event: error` — this stream is over, and why.
 *
 * @stability experimental
 */
export interface KvoxStreamErrorData {
  /** Always `failed`. */
  status: 'failed';
  /** The buffer offset the stream reached. */
  offset: number;
  /** What the frame blames. */
  errorClass: KvoxStreamErrorClass;
  /** The sentence #49 recorded in `error_detail`, when there is one. */
  reason: string | null;
}

/**
 * One message in the shape `@Sse()` serialises.
 *
 * Structurally `@nestjs/common`'s `MessageEvent`, redeclared locally for the
 * identical reason `NotificationStreamService` redeclares it next door: this
 * file stays free of framework imports and testable by calling functions.
 *
 * @stability experimental
 */
export interface KvoxStreamMessage {
  /** The frame body. */
  data?: string | object;
  /** The `event:` name. */
  type?: string;
  /** The `id:`, the buffer offset the frame ends at. */
  id?: string;
  /** An SSE comment line. */
  comment?: string;
}

/**
 * Builds a `delta` frame whose `id:` is the data's offset.
 *
 * @param data - the appended text and the offset it ends at.
 * @stability experimental
 */
export function toDeltaFrame(data: KvoxStreamDeltaData): KvoxStreamMessage {
  return { type: KVOX_STREAM_DELTA_EVENT, id: String(data.offset), data };
}

/**
 * Builds a `done` frame whose `id:` is the data's offset.
 *
 * @param data - the success payload.
 * @stability experimental
 */
export function toDoneFrame(data: KvoxStreamDoneData): KvoxStreamMessage {
  return { type: KVOX_STREAM_DONE_EVENT, id: String(data.offset), data };
}

/**
 * Builds an `error` frame whose `id:` is the data's offset.
 *
 * @param data - the failure payload.
 * @stability experimental
 */
export function toErrorFrame(data: KvoxStreamErrorData): KvoxStreamMessage {
  return { type: KVOX_STREAM_ERROR_EVENT, id: String(data.offset), data };
}

/**
 * Where a reconnecting client says it got to.
 *
 * TOTAL OVER GARBAGE, exactly like `readGenerationId` and every other reader of
 * something an earlier build wrote: `Last-Event-ID` is a header a browser, a
 * proxy, a curl invocation or a client from a previous release can put anything
 * at all into. Anything that is not a plain non-negative decimal integer means
 * "start from the beginning" — which replays text the client may already have
 * but can never lose any, and losing text is the only failure mode here that
 * matters.
 *
 * Fastify hands a repeated header through as an array; the FIRST value wins,
 * for the same reason every other header reader picks one rather than joining.
 *
 * @param raw - the `Last-Event-ID` header value, as the framework hands it over.
 * @returns the offset to resume from; `0` for anything unusable.
 * @stability experimental
 */
export function parseLastEventId(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return 0;

  const parsed = Number.parseInt(value.trim(), 10);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Where to resume from: the header if it is usable, otherwise the query.
 *
 * Shared by every offset-resumable SSE route — `GET /api/notes/:id/stream`,
 * `GET /api/note-generations/:id/stream` and `GET /api/ask/messages/:id/stream`
 * (#379) — so the precedence rule cannot drift between them. Moved here from
 * `note-generation-stream.controller.ts` unchanged.
 *
 * ⚠ BOTH CARRY A FRAME ID — WHICH, PER ISSUE #52, IS A BUFFER OFFSET. Not
 * `note_generations.last_event_id`, whose value is a flush counter and would
 * resume a client near the START of the buffer if passed here. Nothing is lost
 * if one is (the replay is simply longer than it needed to be), but the two
 * numbers must not be confused: this file's header records why the offset is
 * what travels.
 *
 * The HEADER WINS because a reconnecting client's header is set by the transport
 * and reflects what actually arrived, while a query parameter is whatever the
 * page had in hand when it opened the connection — and is therefore the older of
 * the two whenever both exist. {@link parseLastEventId} is total, so an unusable
 * header is `0`, which falls through to the query rather than silently
 * restarting a resumable client from the beginning.
 *
 * @param header - the `Last-Event-ID` header value.
 * @param query - the `lastEventId` query value.
 * @returns the offset to resume from.
 * @stability experimental
 */
export function resolveStreamOffset(
  header: string | string[] | undefined,
  query: string | string[] | undefined,
): number {
  const fromHeader = parseLastEventId(header);

  return fromHeader > 0 ? fromHeader : parseLastEventId(query);
}

/**
 * How much of `note_generations.content` one connection has already sent.
 *
 * The entire delta computation, and the reason it is a class rather than four
 * lines inlined in the poll loop: "never re-send and never skip" is a property
 * of a sequence of calls, so it needs something that can be driven through a
 * sequence of calls in a unit test — including the awkward ones (a poll that
 * saw no change, a resume id past the end, a flush landing between two polls).
 *
 * @stability experimental
 */
export class KvoxStreamCursor {
  private offset: number;

  constructor(from = 0) {
    this.offset = from > 0 ? Math.floor(from) : 0;
  }

  /** The buffer offset everything up to which has been sent. */
  get position(): number {
    return this.offset;
  }

  /**
   * The text this client has not seen, or `null` when it is caught up.
   *
   * ⚠ THE CLAMP IS NOT DEFENSIVE NOISE. A client may present a `Last-Event-ID`
   * larger than the buffer — a stale id from a different generation, a garbled
   * proxy header, or (legitimately) a preview row that was recreated. Left
   * alone, the cursor would sit ahead of the content and SKIP every character
   * written until the buffer grew past that bogus position: silent text loss,
   * with no error anywhere. Clamping down to the current length re-sends
   * nothing and loses nothing, which is the only safe direction.
   *
   * `content` is append-only by contract (§5.1: one writer, whole-buffer
   * writes), so `length` never shrinks in practice; the clamp costs one
   * comparison per poll and removes the possibility entirely.
   */
  advance(content: string): KvoxStreamDeltaData | null {
    if (this.offset > content.length) this.offset = content.length;

    if (this.offset === content.length) return null;

    const delta = content.slice(this.offset);

    this.offset = content.length;

    return { delta, offset: this.offset };
  }
}

/**
 * The cursor's former name, from when only note generation streamed.
 *
 * @deprecated Use {@link KvoxStreamCursor}.
 * @stability deprecated
 */
export const NoteStreamCursor = KvoxStreamCursor;

/**
 * The cursor's former name, from when only note generation streamed.
 *
 * @deprecated Use {@link KvoxStreamCursor}.
 * @stability deprecated
 */
export type NoteStreamCursor = KvoxStreamCursor;
