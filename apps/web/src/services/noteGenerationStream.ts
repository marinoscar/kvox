/**
 * The note-generation stream — `GET /api/note-generations/{id}/stream` and
 * `GET /api/notes/{id}/stream`, over the same fetch-based SSE client the
 * notification stream uses.
 *
 * ⚠ TWO ROUTES, ONE STREAM, AND THEREFORE ONE MODULE. The API says so in as
 * many words (`note-generation-stream.controller.ts`: "the bytes they receive
 * are identical"); the split exists only because a TEMPLATE PREVIEW has no note
 * to be addressed through. So this file exports two three-line wrappers over
 * one implementation rather than two clients — a second copy of the offset
 * reconciliation below would be a second chance to get "a reconnect replays
 * from zero" wrong, and it would be got wrong in the half nobody was looking at.
 *
 * Issues #56 and #57, epic #45. Thin by design, exactly like
 * `services/notificationStream.ts`: SSE framing, reconnection and backoff live
 * in `services/sse.ts` and are not reimplemented here. What is left is the
 * three things specific to THIS stream — its URL, its three frame names, and
 * how a frame's `data` becomes something a panel can render.
 *
 * =============================================================================
 * A SECOND CONNECTION, AND DELIBERATELY NOT A SECOND APP-WIDE ONE
 * =============================================================================
 *
 * `connectNotificationStream` mounts exactly ONE connection per tab, for the
 * life of the tab, and that must keep being true. This one is its opposite in
 * every respect: opened when a preview or a note generation starts, closed the
 * moment the generation settles or the component unmounts, and never more than
 * one at a time per panel or per note page. Nothing here registers a provider,
 * a context or a module-level singleton — a leaked connection here would be a
 * leaked connection PER PREVIEW and PER NOTE OPENED, which is why
 * `UserNoteTemplatesPage.test.tsx` and `NotePage.test.tsx` both assert the
 * teardown against a fake rather than trusting the effect cleanup to be
 * obviously right.
 *
 * =============================================================================
 * ⚠ OFFSETS, NOT CONCATENATION — THIS IS WHAT MAKES A RECONNECT HARMLESS
 * =============================================================================
 *
 * Every `delta` frame carries the buffer OFFSET it ends at, and the API's own
 * header explains why it chose offsets over a flush counter: resume is a
 * substring slice. `services/sse.ts` does not send `Last-Event-ID` back on
 * reconnect (the notification stream has nothing to resume, so the client never
 * grew the ability), which means a dropped preview connection re-attaches at
 * offset 0 and the server replays the WHOLE buffer.
 *
 * Appending would then duplicate every token the user had already watched
 * arrive. So {@link applyDelta} does not append: a frame ending at `offset` and
 * carrying `delta.length` characters starts at `offset - delta.length`, and the
 * frame is written AT that position. Replayed text overwrites itself with
 * identical bytes; genuinely new text extends the buffer; nothing is ever
 * duplicated or skipped. The operation is idempotent, which is the only
 * property that makes a reconnecting stream safe to render optimistically.
 */

import { API_BASE_URL, api } from './api';
import { connectSse, type SseConnection } from './sse';

/**
 * The three `event:` names this stream emits.
 *
 * MUST MATCH `NOTE_STREAM_DELTA_EVENT` / `_DONE_` / `_ERROR_` in
 * `apps/api/src/notes/generation/note-stream.ts`. A mismatch fails SILENTLY —
 * frames arrive, nothing matches, the panel stays empty forever — so the names
 * are constants compared explicitly rather than string literals in a switch.
 */
export const NOTE_STREAM_DELTA_EVENT = 'delta';
export const NOTE_STREAM_DONE_EVENT = 'done';
export const NOTE_STREAM_ERROR_EVENT = 'error';

/**
 * What an `error` frame blames.
 *
 * The first four are `note_generations.error_class`; `timeout` and `gone` are
 * wire-only — the reader giving up, and the row disappearing mid-connection
 * (a preview's own TTL sweep). Neither is a property of the generation, which
 * is why neither can be looked up afterwards.
 */
export type NoteStreamErrorClass =
  | 'auth'
  | 'refusal'
  | 'rate_limit'
  | 'other'
  | 'timeout'
  | 'gone';

export interface NoteStreamDelta {
  delta: string;
  /** The buffer offset this frame ENDS at. See the header. */
  offset: number;
}

export interface NoteStreamDone {
  status: 'succeeded';
  offset: number;
  /** `null` for a preview — it has no note and therefore no version. */
  currentVersion: number | null;
}

export interface NoteStreamError {
  status: 'failed';
  offset: number;
  errorClass: NoteStreamErrorClass;
  reason: string | null;
}

/**
 * A sentence a user can act on, per error class.
 *
 * The API's `reason` is preferred wherever it sent one — it is the provider's
 * own words about the caller's own account, and paraphrasing it would be
 * throwing away the only specific thing in the frame. These are the fallbacks
 * for the classes that legitimately carry no reason.
 */
const ERROR_CLASS_FALLBACKS: Record<NoteStreamErrorClass, string> = {
  auth: 'Your AI provider rejected the key saved for your account.',
  refusal: 'Your AI provider declined to produce this output.',
  rate_limit: 'Your AI provider is rate-limiting your account right now. Try again shortly.',
  other: 'The generation could not be completed.',
  timeout:
    'This view stopped waiting. The generation may well still be running — reopen the page to ' +
    'pick it back up.',
  gone: 'This generation is no longer available to read. Run it again.',
};

/** The sentence to render for one `error` frame. Never an empty string. */
export function describeStreamError(error: NoteStreamError): string {
  const reason = error.reason?.trim();
  return reason ? reason : ERROR_CLASS_FALLBACKS[error.errorClass];
}

// =============================================================================
// Parsing — validated, never cast
// =============================================================================

function asObject(data: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  return raw as Record<string, unknown>;
}

/**
 * Parse a `delta` frame, or `null` if it is not one.
 *
 * VALIDATED RATHER THAN CAST, for the same reason
 * `parseNotificationEvent` is: `JSON.parse` returns `any`, and a bare cast
 * would let a truncated frame through to arithmetic on `undefined`, which
 * silently corrupts the whole buffer rather than costing one frame.
 */
export function parseDeltaFrame(data: string): NoteStreamDelta | null {
  const value = asObject(data);
  if (!value) return null;
  if (typeof value.delta !== 'string') return null;
  if (typeof value.offset !== 'number' || !Number.isFinite(value.offset)) return null;
  return { delta: value.delta, offset: value.offset };
}

/** Parse a `done` frame, or `null`. */
export function parseDoneFrame(data: string): NoteStreamDone | null {
  const value = asObject(data);
  if (!value) return null;
  if (value.status !== 'succeeded') return null;
  if (typeof value.offset !== 'number') return null;
  const version = value.currentVersion;
  if (!(typeof version === 'number' || version === null)) return null;
  return { status: 'succeeded', offset: value.offset, currentVersion: version };
}

const ERROR_CLASSES: readonly string[] = [
  'auth',
  'refusal',
  'rate_limit',
  'other',
  'timeout',
  'gone',
];

/**
 * Parse an `error` frame, or `null`.
 *
 * An UNRECOGNISED `errorClass` is widened to `'other'` rather than dropped —
 * the opposite choice from the fields above, and the right one here: a newer
 * server naming a class this bundle has never heard of is still telling us the
 * generation failed, and swallowing that would leave a spinner running
 * forever. The fields that carry MEANING are validated; the field that carries
 * a LABEL is degraded.
 */
export function parseErrorFrame(data: string): NoteStreamError | null {
  const value = asObject(data);
  if (!value) return null;
  if (value.status !== 'failed') return null;
  if (typeof value.offset !== 'number') return null;
  const errorClass =
    typeof value.errorClass === 'string' && ERROR_CLASSES.includes(value.errorClass)
      ? (value.errorClass as NoteStreamErrorClass)
      : 'other';
  const reason = typeof value.reason === 'string' ? value.reason : null;
  return { status: 'failed', offset: value.offset, errorClass, reason };
}

/**
 * Write one delta into the buffer at the position its offset implies.
 *
 * ⚠ NOT AN APPEND. See the file header — a reconnect replays from offset 0, and
 * appending would duplicate everything the user already watched arrive. Writing
 * at `offset - delta.length` makes a replay a no-op and genuinely new text an
 * extension, so the same function is correct for both without knowing which it
 * is looking at.
 *
 * A frame whose start is BEYOND the buffer we hold (a gap, which this API's
 * own contract says cannot happen but a proxy truncating a response could
 * manufacture) is appended rather than padded with spaces: inventing
 * whitespace to preserve an offset would put characters on the user's screen
 * that no model produced.
 */
export function applyDelta(buffer: string, frame: NoteStreamDelta): string {
  const start = frame.offset - frame.delta.length;
  if (start < 0 || start > buffer.length) return buffer + frame.delta;
  return buffer.slice(0, start) + frame.delta;
}

// =============================================================================
// The connection
// =============================================================================

/** The preview stream's URL, resolved against the same base as every other API call. */
export function noteGenerationStreamUrl(generationId: string): string {
  return `${API_BASE_URL}/note-generations/${encodeURIComponent(generationId)}/stream`;
}

/**
 * The NOTE stream's URL — issue #57.
 *
 * Addressed by note id rather than generation id, which is the only form a
 * page that has just been navigated to can use: `POST /api/notes` returns a
 * `generationId`, but a user who reloads `/notes/:id`, or opens it from a
 * notification, holds only the note. The API resolves it to the note's
 * `currentGenerationId` server-side and the frames are identical.
 */
export function noteStreamUrl(noteId: string): string {
  return `${API_BASE_URL}/notes/${encodeURIComponent(noteId)}/stream`;
}

export interface NoteGenerationStreamHandlers {
  /** Text arrived. `content` is the WHOLE buffer, already offset-reconciled. */
  onContent: (content: string) => void;
  /** The generation committed. The connection is closed before this is called. */
  onDone: (done: NoteStreamDone) => void;
  /** The generation failed, or the reader gave up. The connection is closed first. */
  onError: (error: NoteStreamError) => void;
}

/**
 * Attach to one generation and stream it.
 *
 * SELF-CLOSING ON A TERMINAL FRAME, unlike `connectNotificationStream`, which
 * is meant to reconnect forever. `connectSse` treats a server-ended stream as
 * something to reconnect to after a backoff; for a preview that would mean
 * re-attaching to a finished generation over and over for as long as the form
 * stayed open. So the terminal frame closes the connection here, BEFORE the
 * callback runs — a handler that unmounted the panel must not race a socket
 * this function still owns.
 *
 * The returned handle is still what the caller must close on unmount: a
 * generation that never settles (the user navigating away mid-stream) reaches
 * no terminal frame and would otherwise hold a connection open against a page
 * that is gone.
 */
export function connectNoteGenerationStream(
  generationId: string,
  handlers: NoteGenerationStreamHandlers,
): SseConnection {
  return connectStream(noteGenerationStreamUrl(generationId), handlers);
}

/**
 * Attach to the generation currently writing into one NOTE and stream it —
 * issue #57.
 *
 * Identical mechanics to the preview above, including the self-close on a
 * terminal frame, because it is literally the same function over a different
 * URL. The only difference a caller sees is in `onDone`: a note's `done` frame
 * carries a real `currentVersion` (a preview's is `null`), which is the signal
 * to re-read the note rather than keep rendering the streamed buffer.
 *
 * ⚠ THE STREAM IS ADDITIVE AND THE CALLER MUST TREAT IT THAT WAY. `note.generate`
 * completes the note with no knowledge of whether anyone is connected — the
 * controller's own header says deleting the whole stream would cost a user the
 * live view and not one character of a note — so closing this connection is
 * never cancelling anything, and a page that implied otherwise would be lying.
 */
export function connectNoteStream(
  noteId: string,
  handlers: NoteGenerationStreamHandlers,
): SseConnection {
  return connectStream(noteStreamUrl(noteId), handlers);
}

/**
 * The one implementation both wrappers above share.
 *
 * Private: a caller naming its own URL would be a caller that could point this
 * at something that is not a note stream, and the two exported wrappers are
 * the complete set of routes the API publishes.
 */
function connectStream(
  url: string,
  handlers: NoteGenerationStreamHandlers,
): SseConnection {
  let buffer = '';
  let settled = false;

  const connection = connectSse({
    url,

    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },

    reauthenticate: () => api.refreshToken(),

    // Nothing to refetch: unlike the notification stream, this one REPLAYS
    // from the client's offset (and, since this client sends no
    // `Last-Event-ID`, from the beginning), so a reconnect recovers its own
    // gap through `applyDelta`. See the header.
    onOpen: () => {},

    onFrame: (frame) => {
      // A frame after a terminal one can only come from a connection we have
      // already asked to close but whose in-flight read has not yet unwound.
      // Delivering it would call `onDone` twice.
      if (settled) return;

      if (frame.event === NOTE_STREAM_DELTA_EVENT) {
        const delta = parseDeltaFrame(frame.data);
        // A malformed frame costs one frame, not the stream: the buffer is
        // offset-addressed, so the next well-formed frame rewrites whatever
        // this one would have contributed.
        if (!delta) return;
        buffer = applyDelta(buffer, delta);
        handlers.onContent(buffer);
        return;
      }

      if (frame.event === NOTE_STREAM_DONE_EVENT) {
        const done = parseDoneFrame(frame.data);
        if (!done) return;
        settled = true;
        connection.close();
        handlers.onDone(done);
        return;
      }

      if (frame.event === NOTE_STREAM_ERROR_EVENT) {
        const error = parseErrorFrame(frame.data);
        if (!error) return;
        settled = true;
        connection.close();
        handlers.onError(error);
      }

      // Anything else is a newer server talking to an older bundle. Ignored
      // rather than treated as an error.
    },
  });

  return connection;
}

export type { SseConnection };
