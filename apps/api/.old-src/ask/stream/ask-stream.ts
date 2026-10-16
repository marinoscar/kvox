// =============================================================================
// The Ask answer stream's contract, as data (issue #379, epic #348;
// docs/specs/ontology.md §21.4)
// =============================================================================
//
// PURE, like `notes/generation/note-stream.ts` next door, and for the same
// reason: every decision the stream makes — "what text has this client not
// seen?", "which tool steps has it not been told about?", "what does a frame
// look like?" — is a function of a string or an array, testable without a
// timer or a database. The poll loop in `ask-message-stream.service.ts` is
// left containing nothing but scheduling and I/O.
//
// -----------------------------------------------------------------------------
// THE NOTE STREAM'S CONTRACT, VERBATIM FOR TEXT — PLUS ONE ADDITIVE EVENT
// -----------------------------------------------------------------------------
//
// `delta`, `done` and `error` are the note stream's event names and its offset
// rule unchanged: `id:` is the UTF-16 offset into `ask_messages.content` the
// frame ends at, so resume is `content.slice(Last-Event-ID)` and a reconnect
// can neither repeat nor skip a character. The text arithmetic is not
// re-derived here — `NoteStreamCursor`, `toDeltaFrame` and `parseLastEventId`
// are IMPORTED, so the two streams cannot drift apart.
//
// `step` is new: one frame per recorded `tool_calls` entry ("Looked up Acme…").
// It is ADDITIVE in the strict sense — a client that ignores unknown events
// loses no answer text — and its `id:` is the CURRENT offset, which it never
// advances. Advancing it would break "id = content offset" and make a resume
// ambiguous; instead every recorded step is re-sent on every (re)connect, and
// the client de-duplicates by `index` (`apps/web/src/services/askStream.ts`).
// =============================================================================

import { ASK_ERROR_CLASSES, type AskCitation, type AskToolCall } from '../dto/ask.dto';
import {
  NOTE_STREAM_DELTA_EVENT,
  NOTE_STREAM_DONE_EVENT,
  NOTE_STREAM_ERROR_EVENT,
  type NoteStreamDeltaData,
  type NoteStreamMessage,
} from '../../notes/generation/note-stream';

/** The four `event:` names. The first three ARE the note stream's values. */
export const ASK_STREAM_DELTA_EVENT = NOTE_STREAM_DELTA_EVENT;
export const ASK_STREAM_STEP_EVENT = 'step';
export const ASK_STREAM_DONE_EVENT = NOTE_STREAM_DONE_EVENT;
export const ASK_STREAM_ERROR_EVENT = NOTE_STREAM_ERROR_EVENT;

/**
 * What an `error` frame blames: #376's `ASK_ERROR_CLASSES` plus the WIRE-ONLY
 * `gone` — the row disappeared mid-connection (its conversation was deleted),
 * so there is nothing left to carry a stored class. `timeout` doubles as the
 * connection-cap class, told apart from a stored `timeout` by its `reason`
 * ({@link ASK_STREAM_CAP_REASON}), exactly as the note stream does.
 */
export const ASK_STREAM_ERROR_CLASSES = [...ASK_ERROR_CLASSES, 'gone'] as const;
export type AskStreamErrorClass = (typeof ASK_STREAM_ERROR_CLASSES)[number];

/** The `reason` of an `error` frame the READER sent because it hit its duration cap. */
export const ASK_STREAM_CAP_REASON = 'stream_duration_cap';
/** The `reason` of an `error` frame sent because the message row no longer exists. */
export const ASK_STREAM_GONE_REASON = 'message_gone';

export type AskFinishReasonWire = 'stop' | 'step_cap' | 'token_cap' | 'time_cap';

/** `event: delta` — the note stream's shape, unchanged. */
export type AskStreamDeltaData = NoteStreamDeltaData;

/** `event: step` — one recorded tool call. Carries no arguments and no duration. */
export interface AskStreamStepData {
  index: number;
  name: string;
  summary: string;
  resultCount: number;
  error: string | null;
  /** The CURRENT content offset. A step never advances it. */
  offset: number;
}

/** `event: done` — the turn completed. */
export interface AskStreamDoneData {
  status: 'succeeded';
  offset: number;
  citations: AskCitation[];
  finishReason: AskFinishReasonWire;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** `event: error` — this stream is over, and why. */
export interface AskStreamErrorData {
  status: 'failed';
  offset: number;
  errorClass: AskStreamErrorClass;
  /** `stream_duration_cap` / `message_gone` for the two reader-side endings; `null` for a stored failure. */
  reason: string | null;
}

/** One message in the shape `@Sse()` serialises — the note stream's type. */
export type AskStreamMessage = NoteStreamMessage;

export function toAskStepFrame(data: AskStreamStepData): AskStreamMessage {
  return { type: ASK_STREAM_STEP_EVENT, id: String(data.offset), data };
}

export function toAskDoneFrame(data: AskStreamDoneData): AskStreamMessage {
  return { type: ASK_STREAM_DONE_EVENT, id: String(data.offset), data };
}

export function toAskErrorFrame(data: AskStreamErrorData): AskStreamMessage {
  return { type: ASK_STREAM_ERROR_EVENT, id: String(data.offset), data };
}

/**
 * A stored `ask_messages.error_class` as the wire's union.
 *
 * Total: `null` on a failed row, or a class a later build added, is `other` —
 * which is exactly what it means to a client. `gone` can never arrive here,
 * because no code path writes it to the column.
 */
export function toAskStreamErrorClass(stored: string | null | undefined): AskStreamErrorClass {
  return typeof stored === 'string' && (ASK_ERROR_CLASSES as readonly string[]).includes(stored)
    ? (stored as AskStreamErrorClass)
    : 'other';
}

/** A stored `finish_reason` as the wire's union. A complete row without one ended normally. */
export function toAskFinishReason(stored: string | null | undefined): AskFinishReasonWire {
  return stored === 'step_cap' || stored === 'token_cap' || stored === 'time_cap' ? stored : 'stop';
}

/**
 * Which recorded tool steps one connection has already announced.
 *
 * `next(toolCalls)` returns the entries not yet sent, in `index` order, and
 * marks them sent — so the first call on a (re)connect replays every recorded
 * step, and each later call yields only what `ask.respond` appended since.
 *
 * ⚠ AN INDEX THAT DISAPPEARS IS FORGOTTEN. `ask.respond` (#378) resets a turn
 * that was rate-limited before any answer text to `status: pending,
 * tool_calls: []` and runs it again later, recording fresh steps from index 0.
 * Remembering the old indexes would silently withhold every step of the rerun;
 * forgetting them re-sends the new ones, and a client that already holds an
 * index from the abandoned attempt simply keeps its de-duplication.
 */
export class StepCursor {
  private readonly sent = new Set<number>();

  next(toolCalls: readonly AskToolCall[]): AskToolCall[] {
    const present = new Set(toolCalls.map((call) => call.index));

    for (const index of this.sent) {
      if (!present.has(index)) this.sent.delete(index);
    }

    const fresh: AskToolCall[] = [];
    const seenNow = new Set<number>();

    for (const call of toolCalls) {
      // A duplicated index in one array is one step, not two.
      if (this.sent.has(call.index) || seenNow.has(call.index)) continue;
      seenNow.add(call.index);
      fresh.push(call);
    }

    fresh.sort((a, b) => a.index - b.index);

    for (const call of fresh) this.sent.add(call.index);

    return fresh;
  }

  /** How many distinct steps have been announced and are still recorded. */
  get size(): number {
    return this.sent.size;
  }
}

/** One recorded tool call as a `step` frame's body, at the given offset. */
export function toStepData(call: AskToolCall, offset: number): AskStreamStepData {
  return {
    index: call.index,
    name: call.name,
    summary: call.summary,
    resultCount: call.resultCount,
    error: call.error,
    offset,
  };
}
