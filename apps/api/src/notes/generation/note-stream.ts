// =============================================================================
// The streaming contract, as data (issue #52, epic #45, docs/specs/notes.md §5)
// =============================================================================
//
// Everything in this file is PURE: no Prisma, no `@Injectable`, no clock, no
// timers. It owns the two decisions the stream is made of —
//
//   • "what text has this client not seen yet?" ({@link NoteStreamCursor}), and
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

/** The three `event:` names this stream emits. Issue #52's list, exactly. */
export const NOTE_STREAM_DELTA_EVENT = 'delta';
export const NOTE_STREAM_DONE_EVENT = 'done';
export const NOTE_STREAM_ERROR_EVENT = 'error';

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
 */
export type NoteStreamErrorClass =
  | 'auth'
  | 'refusal'
  | 'rate_limit'
  | 'other'
  | 'timeout'
  | 'gone';

/** `event: delta` — the text appended since the client's position. */
export interface NoteStreamDeltaData {
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

/** `event: done` — the generation settled successfully. */
export interface NoteStreamDoneData {
  status: 'succeeded';
  offset: number;
  /**
   * The note's `currentVersion` after the commit, or `null` for a PREVIEW.
   *
   * `null` is a statement, not a missing value: a preview has no note, writes
   * no `note_versions` row, and therefore has no version to name.
   */
  currentVersion: number | null;
}

/** `event: error` — this stream is over, and why. */
export interface NoteStreamErrorData {
  status: 'failed';
  offset: number;
  errorClass: NoteStreamErrorClass;
  /** The sentence #49 recorded in `error_detail`, when there is one. */
  reason: string | null;
}

/**
 * One message in the shape `@Sse()` serialises.
 *
 * Structurally `@nestjs/common`'s `MessageEvent`, redeclared locally for the
 * identical reason `NotificationStreamService` redeclares it next door: this
 * file stays free of framework imports and testable by calling functions.
 */
export interface NoteStreamMessage {
  data?: string | object;
  type?: string;
  id?: string;
  comment?: string;
}

export function toDeltaFrame(data: NoteStreamDeltaData): NoteStreamMessage {
  return { type: NOTE_STREAM_DELTA_EVENT, id: String(data.offset), data };
}

export function toDoneFrame(data: NoteStreamDoneData): NoteStreamMessage {
  return { type: NOTE_STREAM_DONE_EVENT, id: String(data.offset), data };
}

export function toErrorFrame(data: NoteStreamErrorData): NoteStreamMessage {
  return { type: NOTE_STREAM_ERROR_EVENT, id: String(data.offset), data };
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
 */
export function parseLastEventId(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return 0;

  const parsed = Number.parseInt(value.trim(), 10);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * How much of `note_generations.content` one connection has already sent.
 *
 * The entire delta computation, and the reason it is a class rather than four
 * lines inlined in the poll loop: "never re-send and never skip" is a property
 * of a sequence of calls, so it needs something that can be driven through a
 * sequence of calls in a unit test — including the awkward ones (a poll that
 * saw no change, a resume id past the end, a flush landing between two polls).
 */
export class NoteStreamCursor {
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
  advance(content: string): NoteStreamDeltaData | null {
    if (this.offset > content.length) this.offset = content.length;

    if (this.offset === content.length) return null;

    const delta = content.slice(this.offset);

    this.offset = content.length;

    return { delta, offset: this.offset };
  }
}
