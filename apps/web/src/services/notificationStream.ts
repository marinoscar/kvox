/**
 * The notification stream — `GET /api/notifications/stream`, over the
 * fetch-based SSE client.
 *
 * Issue #127, epic #109. Thin by design: everything about SSE framing,
 * reconnection and backoff lives in `services/sse.ts`, and everything about
 * what a notification IS lives in `types/index.ts`. What is left here is the
 * three things that are specific to this one stream — its URL, its frame name,
 * and how a frame's `data` becomes something the notification centre can hold.
 *
 * =============================================================================
 * ⚠️ THE STREAM IS NOT A DELIVERY GUARANTEE. READ THIS BEFORE RELYING ON IT.
 * =============================================================================
 *
 * There is no replay. The API buffers nothing, honours no `Last-Event-ID`, and
 * keeps no log — anything published while this connection is down is simply
 * never seen by this tab. `NotificationStreamService`'s own header says so, and
 * it is a design decision rather than a gap to be filled later: the
 * `notifications` TABLE is the source of truth, and one indexed query after a
 * gap is strictly more reliable than any cursor built on top of a stream.
 *
 * Two consequences, and the second is the one that gets forgotten:
 *
 *   1. THE CALLER MUST REFETCH THE LIST AND THE UNREAD COUNT ON EVERY `onOpen`,
 *      not merely on mount. `onOpen` fires on the first connection AND on every
 *      reconnection, which is exactly the signal "there may have been a gap;
 *      re-read the truth". `NotificationProvider` does this — see its
 *      `handleOpen`. Delete that and the bell goes stale after the first
 *      network blip, permanently, with nothing in any log to say why.
 *
 *   2. Even a connection that never drops can miss events. The API's stream
 *      registry is PER PROCESS: with more than one API replica, a tab connected
 *      to pod A receives nothing for an event published on pod B. The
 *      notification is not lost — the row was written before the publish — but
 *      the live nudge is. The same refetch-on-connect covers this, which is why
 *      no separate mechanism exists for it.
 *
 * So: a missed frame is a missing TOAST, never a missing notification. Keep it
 * that way. Anything that makes the centre's contents depend on having received
 * a frame turns a degradation into a defect.
 */

import { API_BASE_URL, api } from './api';
import { connectSse, type SseConnection, type SseState } from './sse';
import type { AppNotification, NotificationStreamEvent } from '../types';

/**
 * The `event:` name the API publishes notifications under.
 *
 * MUST MATCH `NOTIFICATION_SSE_EVENT` in
 * `apps/api/src/notifications/notification-stream.service.ts`. The API names its
 * frames rather than using the default `message` precisely so this client can
 * ignore anything else the stream ever carries; the cost is that the string is
 * declared in two repositories-worth of code and a rename must touch both. A
 * mismatch fails SILENTLY — frames arrive, no listener matches, the bell simply
 * never updates live — which is why it is a named constant here and compared
 * explicitly rather than inlined into a condition.
 */
export const NOTIFICATION_SSE_EVENT = 'notification';

/** The stream's URL, resolved against the same base as every other API call. */
export const NOTIFICATION_STREAM_URL = `${API_BASE_URL}/notifications/stream`;

/**
 * Parse one frame's `data` into a stream event, or `null` if it is not one.
 *
 * VALIDATED, NOT CAST. `JSON.parse` returns `any`, and a bare
 * `as NotificationStreamEvent` would let a malformed or truncated frame through
 * to a component that then renders `undefined` as a title — or worse, calls
 * `new Notification(undefined)`. The check is cheap and this is untrusted input
 * in the only sense that matters: it arrived over a socket and this code cannot
 * see what produced it.
 *
 * Returns `null` rather than throwing, because a bad frame must not kill the
 * read loop. One unparseable event should cost one notification, not the
 * connection.
 *
 * Exported for tests: the framing is verifiable without a network.
 */
export function parseNotificationEvent(data: string): NotificationStreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;

  // Every field the centre actually renders is required. `link` is checked for
  // `string | null` specifically — `undefined` is not acceptable, because the
  // API always sends the key and its absence means the payload is not what this
  // client thinks it is.
  //
  // `toast` (#226) is held to the same standard rather than defaulted, and the
  // choice is deliberate. Defaulting a missing flag to `true` would let a frame
  // this client cannot fully understand re-enable a notification an
  // administrator switched off; defaulting it to `false` would silently drop
  // toasts against a server that is sending them. Requiring it makes the
  // contract explicit — the API always sends the key — and a frame that lacks
  // it is treated like any other malformed frame: dropped here, still present
  // in the table, picked up by the next refetch.
  if (
    typeof value.id !== 'string' ||
    typeof value.eventKey !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.toast !== 'boolean' ||
    !(typeof value.link === 'string' || value.link === null)
  ) {
    return null;
  }

  return {
    id: value.id,
    eventKey: value.eventKey,
    title: value.title,
    body: value.body,
    link: value.link,
    createdAt: value.createdAt,
    toast: value.toast,
  };
}

/**
 * Widen a streamed event into a full notification row.
 *
 * TWO DIFFERENCES, AND BOTH ARE RECONCILED HERE. `readAt: null` is not a guess:
 * the API omits the field from the stream because a notification is unread BY
 * DEFINITION at the instant it is published. And `toast` is DROPPED: it is an
 * instruction about this one live delivery ("may the OS bubble be raised?"),
 * not a property of the stored row, and the same notification fetched from
 * `GET /api/notifications` has no such field.
 *
 * Keeping it would make a streamed notification and a fetched one two subtly
 * different objects in the same list — precisely the divergence the API avoided
 * by giving the stream the row's shape in the first place. A caller that needs
 * the flag reads it off the stream event, before this conversion; `onFrame`
 * below holds both.
 */
export function streamEventToNotification(
  event: NotificationStreamEvent,
): AppNotification {
  const { toast: _toast, ...notification } = event;

  return { ...notification, readAt: null };
}

export interface NotificationStreamHandlers {
  /**
   * A notification arrived live.
   *
   * Called only for well-formed `event: notification` frames. Heartbeat
   * comments never reach here — they are consumed by the parser, which is what
   * they are for.
   *
   * TWO ARGUMENTS, DELIBERATELY NOT ONE OBJECT (#227). `notification` is the
   * stored-row shape — `toast`-free, per `streamEventToNotification`'s own
   * documented boundary above — and `toast` is the raw frame's live-delivery
   * instruction, passed alongside rather than folded back in. Re-attaching
   * `toast` to `notification` here would undo the exact separation
   * `streamEventToNotification` exists to make: the STORED shape must stay
   * `toast`-free (it is not a property of the row, and a caller that persists
   * or compares `notification` objects must never see a field that varies by
   * delivery), while the LIVE delivery decision — may the OS bubble fire for
   * THIS arrival? — still needs the flag. Two arguments keep both true at once.
   */
  onNotification: (notification: AppNotification, toast: boolean) => void;
  /**
   * ⚠️ THE REFETCH SIGNAL. Fires on the first connect and on EVERY reconnect.
   *
   * The caller must re-read the list and the unread count here. See this file's
   * header for why nothing else recovers a gap.
   */
  onOpen: () => void;
  /** Connection state, for rendering. Optional. */
  onStateChange?: (state: SseState) => void;
}

/**
 * Connect to this user's notification stream.
 *
 * NO USER ID ARGUMENT, and there is no way to add one: the recipient is the
 * bearer of the token, resolved server-side. That is the isolation property the
 * whole feature rests on — a stream selected by a client-supplied id would be
 * an IDOR, and the API deliberately exposes no parameter that could carry one.
 *
 * Credentials are read through `api` on every attempt rather than captured, so
 * a connection that outlives its 15-minute access token reconnects with the
 * current one; a 401 renews through the same `refreshToken` path every other
 * request uses, so the stream and the REST calls can never disagree about
 * whether the session is alive.
 */
export function connectNotificationStream(
  handlers: NotificationStreamHandlers,
): SseConnection {
  return connectSse({
    url: NOTIFICATION_STREAM_URL,

    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },

    reauthenticate: () => api.refreshToken(),

    onOpen: handlers.onOpen,

    onStateChange: handlers.onStateChange,

    onFrame: (frame) => {
      // Compared by NAME, so anything the stream grows later is ignored rather
      // than mis-parsed as a notification. An unrecognised frame is not an
      // error — it is a newer server talking to an older bundle.
      if (frame.event !== NOTIFICATION_SSE_EVENT) return;

      const event = parseNotificationEvent(frame.data);
      // A malformed frame is dropped silently. The row still exists server-side
      // and the next refetch — on the next reconnect, or the next time the bell
      // is opened — picks it up, so dropping it here costs liveness and nothing
      // more.
      if (!event) return;

      handlers.onNotification(streamEventToNotification(event), event.toast);
    },
  });
}

export type { SseConnection, SseState };
