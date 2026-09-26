/**
 * The Ask answer stream — `GET /api/ask/messages/{id}/stream` (#379), over the
 * same fetch-based SSE client every other stream in this app uses.
 *
 * A MIRROR OF `services/noteGenerationStream.ts`, not a new design: the API
 * reuses the note stream's `delta | done | error` frame contract verbatim for
 * text (same offset ids, same `NoteStreamCursor`), so this module reuses its
 * {@link applyDelta} rather than re-deriving "write at the offset, never
 * append". What is new is one ADDITIVE frame, `step` — tool progress — and the
 * richer payloads of `done` (citations, finish reason) and `error` (Ask's own
 * error classes).
 *
 * =============================================================================
 * RESUME, AND WHY A RECONNECT CANNOT DUPLICATE TEXT
 * =============================================================================
 *
 * `services/sse.ts` does not send `Last-Event-ID` on its own reconnects (its
 * header explains why). So a caller that already holds some of the answer —
 * a page opened mid-stream, whose `GET` returned the buffer so far — passes it
 * as `resume.content`: the connection then starts at that offset
 * (`?lastEventId=<length>`, which #379 honours when no header is sent) and the
 * buffer is seeded with it. Every reconnect after that re-asks from the same
 * offset and the server replays from there; {@link applyDelta} writes each
 * frame AT the position its offset implies, so replayed text overwrites
 * itself with identical characters and nothing is ever shown twice.
 *
 * `step` frames are re-sent in full on every (re)connect (#379: "all recorded
 * steps are sent once, in index order, before new deltas"). They are
 * de-duplicated here by `index`, so a handler sees each step exactly once per
 * connection object no matter how many times the socket dropped.
 *
 * Like the note stream this connection is SELF-CLOSING on a terminal frame
 * and must still be closed by its owner on unmount. Closing it never cancels
 * anything: `ask.respond` writes the answer whether or not anybody watches
 * (CLAUDE.md, Notes rule 1).
 */

import { API_BASE_URL, api } from './api';
import { applyDelta, parseDeltaFrame } from './noteGenerationStream';
import type { NoteStreamDelta } from './noteGenerationStream';
import { connectSse, type SseConnection } from './sse';
import { ASK_ERROR_CLASSES, ASK_FINISH_REASONS } from './ask';
import type { AskCitation, AskErrorClass, AskFinishReason, AskToolCall } from './ask';

export { applyDelta };

/**
 * The four `event:` names. MUST MATCH `apps/api/src/ask/stream/ask-stream.ts`
 * (#379) — the first three are the note stream's own values, re-exported
 * there. A mismatch fails silently, so they are constants.
 */
export const ASK_STREAM_DELTA_EVENT = 'delta';
export const ASK_STREAM_STEP_EVENT = 'step';
export const ASK_STREAM_DONE_EVENT = 'done';
export const ASK_STREAM_ERROR_EVENT = 'error';

/** #376's error classes plus the wire-only `gone` (the row vanished — conversation deleted). */
export type AskStreamErrorClass = AskErrorClass | 'gone';

export type AskStreamDelta = NoteStreamDelta;

export interface AskStreamStep {
  index: number;
  name: string;
  summary: string;
  resultCount: number;
  error: string | null;
  /** The current content offset. A step frame never advances it. */
  offset: number;
}

export interface AskStreamDone {
  status: 'succeeded';
  offset: number;
  citations: AskCitation[];
  finishReason: AskFinishReason;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface AskStreamError {
  status: 'failed';
  offset: number;
  errorClass: AskStreamErrorClass;
  /** `stream_duration_cap` for the reader giving up (`errorClass: 'timeout'`). */
  reason: string | null;
}

// =============================================================================
// Parsing — validated, never cast (the `noteGenerationStream.ts` rule)
// =============================================================================

function asObject(data: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function intOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A `delta` frame, or `null`. Exactly the note stream's shape. */
export function parseAskDelta(data: string): AskStreamDelta | null {
  return parseDeltaFrame(data);
}

/** A `step` frame, or `null`. `index` and `offset` carry meaning and are required. */
export function parseAskStep(data: string): AskStreamStep | null {
  const value = asObject(data);
  if (!value) return null;
  if (!isFiniteNumber(value.index) || !isFiniteNumber(value.offset)) return null;
  return {
    index: value.index,
    name: typeof value.name === 'string' ? value.name : '',
    summary: typeof value.summary === 'string' ? value.summary : '',
    resultCount: isFiniteNumber(value.resultCount) ? value.resultCount : 0,
    error: stringOrNull(value.error),
    offset: value.offset,
  };
}

const CITATION_KINDS: readonly string[] = ['evidence', 'entity', 'document'];

/**
 * One citation from a `done` frame, or `null` when it is not one.
 *
 * A malformed entry is DROPPED rather than failing the frame: the rest of the
 * answer's citations are still true, and a marker whose citation is missing is
 * rendered exactly like an invalid one (removed, and counted).
 */
export function parseAskCitation(raw: unknown): AskCitation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.marker !== 'string') return null;
  if (typeof value.kind !== 'string' || !CITATION_KINDS.includes(value.kind)) return null;
  const id = stringOrNull(value.id);
  const valid = value.valid === true && id !== null;
  let via: AskCitation['via'] = null;
  if (typeof value.via === 'object' && value.via !== null) {
    const v = value.via as Record<string, unknown>;
    if ((v.kind === 'item' || v.kind === 'relation') && typeof v.id === 'string') {
      via = { kind: v.kind, id: v.id };
    }
  }
  const documentKind =
    value.documentKind === 'transcript' || value.documentKind === 'note' ? value.documentKind : null;
  return {
    marker: value.marker,
    kind: value.kind as AskCitation['kind'],
    id,
    via,
    valid,
    label: stringOrNull(value.label),
    documentKind,
    startMs: intOrNull(value.startMs),
  };
}

export function parseAskCitations(raw: unknown): AskCitation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseAskCitation).filter((c): c is AskCitation => c !== null);
}

/**
 * A `done` frame, or `null`.
 *
 * An unrecognised `finishReason` is read as `stop`: the answer is finished,
 * and a newer server naming a cap this bundle does not know should still end
 * the spinner rather than leave it running.
 */
export function parseAskDone(data: string): AskStreamDone | null {
  const value = asObject(data);
  if (!value) return null;
  if (value.status !== 'succeeded' || !isFiniteNumber(value.offset)) return null;
  const finishReason =
    typeof value.finishReason === 'string' && (ASK_FINISH_REASONS as readonly string[]).includes(value.finishReason)
      ? (value.finishReason as AskFinishReason)
      : 'stop';
  return {
    status: 'succeeded',
    offset: value.offset,
    citations: parseAskCitations(value.citations),
    finishReason,
    promptTokens: intOrNull(value.promptTokens),
    completionTokens: intOrNull(value.completionTokens),
  };
}

const STREAM_ERROR_CLASSES: readonly string[] = [...ASK_ERROR_CLASSES, 'gone'];

/**
 * An `error` frame, or `null`. An unrecognised `errorClass` widens to `other`
 * (the note stream's rule: the label degrades, the failure is never dropped).
 */
export function parseAskError(data: string): AskStreamError | null {
  const value = asObject(data);
  if (!value) return null;
  if (value.status !== 'failed' || !isFiniteNumber(value.offset)) return null;
  const errorClass =
    typeof value.errorClass === 'string' && STREAM_ERROR_CLASSES.includes(value.errorClass)
      ? (value.errorClass as AskStreamErrorClass)
      : 'other';
  return { status: 'failed', offset: value.offset, errorClass, reason: stringOrNull(value.reason) };
}

/** A step frame as the `AskToolCall` the UI renders. The frame carries no arguments or duration. */
export function stepToToolCall(step: AskStreamStep): AskToolCall {
  return {
    index: step.index,
    name: step.name,
    arguments: {},
    summary: step.summary,
    resultCount: step.resultCount,
    durationMs: 0,
    error: step.error,
  };
}

// =============================================================================
// The connection
// =============================================================================

/** The stream's URL, optionally starting at an offset the caller already holds. */
export function askMessageStreamUrl(messageId: string, fromOffset = 0): string {
  const base = `${API_BASE_URL}/ask/messages/${encodeURIComponent(messageId)}/stream`;
  return fromOffset > 0 ? `${base}?lastEventId=${Math.floor(fromOffset)}` : base;
}

export interface AskStreamHandlers {
  /** Text arrived. `full` is the WHOLE buffer, already offset-reconciled. */
  onContent(full: string): void;
  /** A tool step, each `index` at most once per connection. */
  onStep(step: AskToolCall): void;
  /** The turn completed. The connection is closed before this is called. */
  onDone(done: { citations: AskCitation[]; finishReason: AskFinishReason }): void;
  /** The turn failed, the row vanished, or the reader gave up. Closed first. */
  onError(error: { errorClass: AskStreamErrorClass; reason: string | null }): void;
}

export interface AskStreamResume {
  /** The answer text the caller already holds (the conversation `GET`'s `content`). */
  content?: string;
  /** Step indexes the caller already holds, so they are not re-reported. */
  knownStepIndexes?: readonly number[];
}

/**
 * Attach to one assistant message and stream it (#379).
 *
 * `resume` is optional: without it the stream starts at offset 0 and replays
 * everything, which is always correct, merely redundant.
 */
export function connectAskStream(
  messageId: string,
  handlers: AskStreamHandlers,
  resume: AskStreamResume = {},
): SseConnection {
  let buffer = resume.content ?? '';
  const seenSteps = new Set<number>(resume.knownStepIndexes ?? []);
  let settled = false;

  const connection = connectSse({
    url: askMessageStreamUrl(messageId, buffer.length),
    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },
    reauthenticate: () => api.refreshToken(),
    // Nothing to refetch on a (re)connect: the server replays from the offset
    // in the URL, and `applyDelta` absorbs the overlap. See the header.
    onOpen: () => {},
    onFrame: (frame) => {
      if (settled) return;

      if (frame.event === ASK_STREAM_DELTA_EVENT) {
        const delta = parseAskDelta(frame.data);
        if (!delta) return;
        const next = applyDelta(buffer, delta);
        if (next === buffer) return;
        buffer = next;
        handlers.onContent(buffer);
        return;
      }

      if (frame.event === ASK_STREAM_STEP_EVENT) {
        const step = parseAskStep(frame.data);
        if (!step || seenSteps.has(step.index)) return;
        seenSteps.add(step.index);
        handlers.onStep(stepToToolCall(step));
        return;
      }

      if (frame.event === ASK_STREAM_DONE_EVENT) {
        const done = parseAskDone(frame.data);
        if (!done) return;
        settled = true;
        connection.close();
        handlers.onDone({ citations: done.citations, finishReason: done.finishReason });
        return;
      }

      if (frame.event === ASK_STREAM_ERROR_EVENT) {
        const error = parseAskError(frame.data);
        if (!error) return;
        settled = true;
        connection.close();
        handlers.onError({ errorClass: error.errorClass, reason: error.reason });
      }
      // Anything else is a newer server talking to an older bundle — ignored.
    },
  });

  return connection;
}

export type { SseConnection };
