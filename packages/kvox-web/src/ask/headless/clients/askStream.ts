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
 * A caller that already holds some of the answer — a page opened
 * mid-stream, whose `GET` returned the buffer so far — passes it as
 * `resume.content`: the connection then starts at that offset
 * (`?lastEventId=<length>`, which #379 honours when no header is sent) and the
 * buffer is seeded with it. Every reconnect after that re-asks from where the
 * last frame ended (`connectKvoxSse` sends its `id:`, a content offset, as
 * `Last-Event-ID`, and #379 prefers the header) and the server replays from
 * there; {@link applyDelta} writes each frame AT the position its offset
 * implies, so replayed text overwrites itself with identical characters and
 * nothing is ever shown twice.
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

import { connectKvoxSse } from '../../../core/headless/index.js';
import type { KvoxSseEvent, KvoxWebHost, SseConnection } from '../../../core/headless/index.js';
import { applyDelta, parseDeltaFrame } from '../../../notes/headless/index.js';
import type { NoteStreamDelta } from '../../../notes/headless/index.js';
import { ASK_ERROR_CLASSES, ASK_FINISH_REASONS } from './ask.js';
import type { AskCitation, AskErrorClass, AskFinishReason, AskToolCall } from './ask.js';

/**
 * The `event:` name of a text frame. MUST MATCH `packages/kvox-api/src/ask/stream/ask-stream.ts`
 * (#379); a mismatch fails silently, so the four names are constants.
 *
 * @stability experimental
 */
export const ASK_STREAM_DELTA_EVENT = 'delta';
/**
 * The `event:` name of a tool-progress frame (the one frame the note stream does not have).
 *
 * @stability experimental
 */
export const ASK_STREAM_STEP_EVENT = 'step';
/**
 * The `event:` name of the frame that ends a turn successfully.
 *
 * @stability experimental
 */
export const ASK_STREAM_DONE_EVENT = 'done';
/**
 * The `event:` name of the frame that ends a turn in failure.
 *
 * @stability experimental
 */
export const ASK_STREAM_ERROR_EVENT = 'error';

/**
 * #376's error classes plus the wire-only `gone` (the row vanished: the
 * conversation was deleted).
 *
 * @stability experimental
 */
export type AskStreamErrorClass = AskErrorClass | 'gone';

/**
 * A parsed `delta` frame: exactly the note stream's.
 *
 * @stability experimental
 */
export type AskStreamDelta = NoteStreamDelta;

/**
 * A parsed `step` frame.
 *
 * @stability experimental
 */
export interface AskStreamStep {
  /** The step's position in the turn; the key steps are de-duplicated by. */
  index: number;
  /** The tool the agent called. */
  name: string;
  /** A human line, for example "Looked up Acme (Organization)". */
  summary: string;
  /** How many rows the tool returned. */
  resultCount: number;
  /** The tool's error, or `null`. */
  error: string | null;
  /** The current content offset. A step frame never advances it. */
  offset: number;
}

/**
 * A parsed `done` frame.
 *
 * @stability experimental
 */
export interface AskStreamDone {
  /** Always `succeeded`. */
  status: 'succeeded';
  /** The content offset the stream ended at. */
  offset: number;
  /** The answer's resolved citations. */
  citations: AskCitation[];
  /** Why the turn ended; anything but `stop` is "stopped early". */
  finishReason: AskFinishReason;
  /** Tokens the prompt used, or `null`. */
  promptTokens: number | null;
  /** Tokens the answer used, or `null`. */
  completionTokens: number | null;
}

/**
 * A parsed `error` frame.
 *
 * @stability experimental
 */
export interface AskStreamError {
  /** Always `failed`. */
  status: 'failed';
  /** The content offset the stream reached before failing. */
  offset: number;
  /** What the failure is blamed on. */
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

/**
 * Parses a `delta` frame, or `null`. Exactly the note stream's shape.
 *
 * @param data - The frame's `data` line.
 * @returns The frame, or `null` when it is not one.
 *
 * @stability experimental
 */
export function parseAskDelta(data: string): AskStreamDelta | null {
  return parseDeltaFrame(data);
}

/**
 * Parses a `step` frame, or `null`. `index` and `offset` carry meaning and are required.
 *
 * @param data - The frame's `data` line.
 * @returns The frame, or `null` when it is not one.
 *
 * @stability experimental
 */
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
 * Parses one citation from a `done` frame, or `null` when it is not one.
 *
 * A malformed entry is DROPPED rather than failing the frame: the rest of the
 * answer's citations are still true, and a marker whose citation is missing is
 * rendered exactly like an invalid one (removed, and counted).
 *
 * @param raw - One entry of the frame's `citations`.
 * @returns The citation, or `null`.
 *
 * @stability experimental
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

/**
 * Parses the `citations` of a `done` frame, dropping every malformed entry.
 *
 * @param raw - The frame's `citations`.
 * @returns The well-formed citations; empty when `raw` is not an array.
 *
 * @stability experimental
 */
export function parseAskCitations(raw: unknown): AskCitation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseAskCitation).filter((c): c is AskCitation => c !== null);
}

/**
 * Parses a `done` frame, or `null`.
 *
 * An unrecognised `finishReason` is read as `stop`: the answer is finished,
 * and a newer server naming a cap this bundle does not know should still end
 * the spinner rather than leave it running.
 *
 * @param data - The frame's `data` line.
 * @returns The frame, or `null` when it is not one.
 *
 * @stability experimental
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
 * Parses an `error` frame, or `null`. An unrecognised `errorClass` widens to
 * `other` (the note stream's rule: the label degrades, the failure is never
 * dropped).
 *
 * @param data - The frame's `data` line.
 * @returns The frame, or `null` when it is not one.
 *
 * @stability experimental
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

/**
 * A step frame as the `AskToolCall` the UI renders. The frame carries no
 * arguments or duration.
 *
 * @param step - A parsed `step` frame.
 * @returns The tool call.
 *
 * @stability experimental
 */
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

/**
 * The stream's path below the API base, optionally starting at an offset the
 * caller already holds (`?lastEventId=`, which #379 honours when no
 * `Last-Event-ID` header is sent).
 *
 * @param messageId - The assistant message to stream.
 * @param fromOffset - The content offset the caller already holds.
 * @returns The path.
 *
 * @stability experimental
 */
export function askMessageStreamPath(messageId: string, fromOffset = 0): string {
  const base = `/ask/messages/${encodeURIComponent(messageId)}/stream`;
  return fromOffset > 0 ? `${base}?lastEventId=${Math.floor(fromOffset)}` : base;
}

/**
 * Callbacks of {@link connectAskStream}.
 *
 * @stability experimental
 */
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

/**
 * What the caller already holds of the answer, so the stream resumes after it.
 *
 * @stability experimental
 */
export interface AskStreamResume {
  /** The answer text the caller already holds (the conversation `GET`'s `content`). */
  content?: string;
  /** Step indexes the caller already holds, so they are not re-reported. */
  knownStepIndexes?: readonly number[];
}

/**
 * Attaches to one assistant message and streams it (#379).
 *
 * `resume` is optional: without it the stream starts at offset 0 and replays
 * everything, which is always correct, merely redundant. SELF-CLOSING on a
 * terminal frame, and still to be closed by its owner on unmount.
 *
 * @param host - The host whose `sse` port carries the stream.
 * @param messageId - The assistant message to stream.
 * @param handlers - Content, step, done and error callbacks.
 * @param resume - What the caller already holds.
 * @returns A handle whose `close()` ends the connection.
 *
 * @stability experimental
 */
export function connectAskStream(
  host: KvoxWebHost,
  messageId: string,
  handlers: AskStreamHandlers,
  resume: AskStreamResume = {},
): SseConnection {
  let buffer = resume.content ?? '';
  const seenSteps = new Set<number>(resume.knownStepIndexes ?? []);
  let settled = false;
  const controller = new AbortController();
  const connection: SseConnection = { close: () => controller.abort() };

  const onEvent = (frame: KvoxSseEvent): void => {
    // A frame after a terminal one can only come from a connection already
    // asked to close whose in-flight read has not unwound yet.
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
    // Anything else is a newer server talking to an older bundle: ignored.
  };

  // Nothing to refetch on a (re)connect: the server replays from the offset
  // (the URL's on the first attempt, the last frame's `id:` on later ones) and
  // `applyDelta` absorbs the overlap. A fatal rejection (the session ended) is
  // swallowed: the page shows the stored message regardless.
  void connectKvoxSse(host, askMessageStreamPath(messageId, buffer.length), {
    signal: controller.signal,
    onEvent,
  }).catch(() => undefined);

  return connection;
}
