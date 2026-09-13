/**
 * The notification centre's state — the durable surface of the browser channel.
 *
 * Issue #127, epic #109. Owns the recent-notification list, the unread count,
 * the SSE connection, and the native toast. Mounted once, in `App.tsx`, around
 * the `Layout` route element — so it exists exactly where the app shell (and
 * therefore the bell in the `AppBar`) exists, and nowhere else.
 *
 * =============================================================================
 * THE ORDERING THAT MATTERS: TABLE FIRST, STREAM SECOND, TOAST THIRD
 * =============================================================================
 *
 * Three mechanisms, in strict order of authority, and the whole design of this
 * file follows from it:
 *
 *   1. `GET /api/notifications` + `/unread-count` — THE TRUTH. Everything the
 *      bell renders comes from here. This works with the stream down, with
 *      permission denied, in a browser with no `Notification` API at all, and
 *      after any gap of any length.
 *   2. The SSE stream — LIVENESS ONLY. It makes the centre update without a
 *      refresh. It is not a delivery guarantee (no replay, no `Last-Event-ID`,
 *      per-process fan-out), so a missed frame must only ever cost immediacy.
 *   3. `new Notification(...)` — DECORATION. Raised when permission is already
 *      granted, absent otherwise, and nothing depends on it.
 *
 * Anything that inverts this ordering is a bug even if it works in testing. A
 * list populated only by stream frames looks perfect on a developer's machine
 * and is empty on every page load in production.
 *
 * =============================================================================
 * ⚠️ REFETCH ON EVERY (RE)CONNECT — `handleStreamOpen` BELOW
 * =============================================================================
 *
 * THE STREAM REPLAYS NOTHING. The API buffers no events, honours no
 * `Last-Event-ID`, and keeps no log; anything published while the connection was
 * down is never seen by this tab. Its stream registry is also PER API PROCESS,
 * so with more than one replica a connected tab still misses events published on
 * another pod.
 *
 * Both are survivable for exactly one reason: the `notifications` row is written
 * to the shared database BEFORE it is published, so the table is always right
 * even when the stream is not. The recovery is therefore to RE-READ THE TABLE
 * WHENEVER A CONNECTION IS ESTABLISHED — not just on mount, on EVERY connect,
 * because a reconnect is precisely the event that says "there may have been a
 * gap".
 *
 * If you delete `refresh()` from `handleStreamOpen` because it looks redundant
 * next to the mount fetch: the bell goes stale after the first network blip and
 * stays stale for the life of the tab, and nothing anywhere logs an error. That
 * is the failure this comment exists to prevent.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useIsMounted } from '../hooks/useIsMounted';
import {
  ApiError,
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/api';
import { connectNotificationStream, type SseState } from '../services/notificationStream';
import { showAppNotification } from '../services/browserNotifications';
import { isInternalLink } from '../utils/internalLink';
import type { AppNotification } from '../types';

/**
 * How many notifications the centre holds.
 *
 * The bell is a RECENT list, not an archive — it shows what has happened
 * lately and the unread count tells the honest total. One page, no infinite
 * scroll: a popover the user opens to triage two items should not paginate, and
 * the API caps `pageSize` at 100 anyway because an uncapped page on an
 * unbounded table is a way for any authenticated user to ask for their entire
 * history in one request.
 */
export const RECENT_NOTIFICATION_COUNT = 20;

/**
 * How many notification ids the centre remembers for de-duplication.
 *
 * ⚠️ ISSUE #127 — DELIBERATELY LARGER THAN `RECENT_NOTIFICATION_COUNT`, and the
 * gap between the two numbers is the whole point. The visible list is truncated
 * to 20 because a popover is not an archive; the question "have I already
 * counted this one?" must NOT be truncated with it, because the two have
 * different failure modes. A row pushed off the end of the list by truncation
 * and then re-delivered by the stream is still the SAME notification the server
 * counted exactly once — counting it again is the #127 double-count wearing a
 * different hat, and it would be invisible in testing because it needs 20
 * arrivals before it can happen at all.
 *
 * 10× the visible list makes that unreachable in practice: every duplicate race
 * this defends against — multi-tab fan-out, the reconnect refetch racing a live
 * frame, StrictMode's double connect in development — delivers its copies
 * within seconds of one another, never 200 notifications apart.
 *
 * Bounded rather than unbounded because this provider lives in the app shell of
 * a tab that stays open all day; an unbounded set is a leak nothing ever
 * empties. At the cap the oldest id is dropped, so a re-delivery of something
 * that stale over-counts by one until the next `refresh()` — the same
 * self-healing tolerance every other local count adjustment in this file
 * already relies on.
 */
const SEEN_NOTIFICATION_ID_MEMORY = 200;

/**
 * Record an id as seen — most-recently-seen LAST — and prune back to the cap.
 *
 * The `delete` before the `add` is not redundant. `Set` preserves INSERTION
 * order and re-adding an existing key does not move it, so without the delete a
 * notification that is still on screen could still hold an ancient position and
 * be the one the cap evicts — reopening the #127 double-count for a row the
 * user can literally see. With it, the ids backing the rendered list are always
 * among the most recent entries, and eviction can only ever reach ids that
 * scrolled out of the centre long ago.
 *
 * MUTATES A `Set` HELD IN A REF, and is therefore only ever called from event
 * callbacks and async code — NEVER from inside a `setState` updater. See
 * `handleNotification` below for why that rule exists.
 */
function rememberNotificationId(seen: Set<string>, id: string): void {
  seen.delete(id);
  seen.add(id);

  while (seen.size > SEEN_NOTIFICATION_ID_MEMORY) {
    const oldest = seen.values().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }
}

export interface NotificationContextValue {
  /** The recent list, newest first. Never `null` — an empty list is a real answer. */
  notifications: AppNotification[];
  /**
   * The AUTHORITATIVE unread count, straight from the API.
   *
   * NOT derived from `notifications`. A count taken from the list caps at
   * `RECENT_NOTIFICATION_COUNT` and under-reports the moment a user has more
   * unread than the page holds — which is exactly when the badge matters most.
   */
  unreadCount: number;
  /** The first load is in flight and nothing has been shown yet. */
  isLoading: boolean;
  /** A fetch failed. A string the bell renders; `null` when healthy. */
  error: string | null;
  /** What the live stream is doing. Purely informational. */
  streamState: SseState;
  /** Re-read the list and the count. Deduped — concurrent calls share one request. */
  refresh: () => Promise<void>;
  /** Mark one read. Optimistic, with the count reconciled from the response. */
  markRead: (id: string) => Promise<void>;
  /** Mark every notification read. */
  markAllRead: () => Promise<void>;
}

/**
 * `null` when no provider is mounted — see `useNotifications` below, which is
 * deliberately tolerant rather than throwing.
 */
export const NotificationContext = createContext<NotificationContextValue | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMounted = useIsMounted();

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<SseState>('connecting');

  /**
   * The in-flight refresh, so concurrent callers share one pair of requests.
   *
   * Needed because two refresh triggers fire within milliseconds of each other
   * at startup — the mount effect, and the stream's first `onOpen` — and again
   * whenever a user opens the bell just as the connection recovers. Without
   * this, each pair of duplicate requests can also land out of order and write
   * an older list over a newer one.
   */
  const inFlight = useRef<Promise<void> | null>(null);

  /**
   * ⚠️ #127 — THE IDS THIS TAB HAS ALREADY ACCOUNTED FOR IN `unreadCount`.
   *
   * A REF, not state, for two independent reasons:
   *
   *   1. Nothing renders it. Turning it into state would re-render the whole
   *      shell on every arrival for no visible change.
   *   2. It must be readable and writable SYNCHRONOUSLY, outside React's
   *      update machinery, so the "is this new?" decision can be made once per
   *      stream frame rather than once per updater invocation — see
   *      `handleNotification`.
   *
   * Fed from BOTH sources of truth: every page `refresh()` returns, and every
   * live arrival. Cleared on logout with the rest of the state, so the next
   * user does not inherit the previous one's memory.
   */
  const seenNotificationIds = useRef<Set<string>>(new Set());

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;

    const run = (async () => {
      try {
        // BOTH IN PARALLEL, and the count from its own endpoint rather than
        // counted out of the list — see `unreadCount` above.
        const [page, count] = await Promise.all([
          getNotifications({ page: 1, pageSize: RECENT_NOTIFICATION_COUNT }),
          getUnreadNotificationCount(),
        ]);

        if (!isMounted()) return;
        setNotifications(page.items);
        setUnreadCount(count.unreadCount);
        setError(null);

        // #127: seed the de-dupe memory from the authoritative page, OLDEST
        // FIRST so the newest row ends up most-recently-seen (see
        // `rememberNotificationId`). This closes the reconnect race described
        // in the header: `handleStreamOpen` refetches on EVERY connect, so a
        // live frame for a row this refetch already returned — and already
        // counted, since `count.unreadCount` includes it — must not be counted
        // a second time when it lands. Safe here because we are in async
        // callback code, not a state updater.
        for (let i = page.items.length - 1; i >= 0; i--) {
          rememberNotificationId(seenNotificationIds.current, page.items[i].id);
        }
      } catch (err) {
        if (!isMounted()) return;
        // A 401 is left to `AuthContext` — `ApiService` has already tried to
        // refresh and failed, so the session is going away and a "failed to
        // load notifications" message on top of a redirect to login is noise.
        if (err instanceof ApiError && err.status === 401) return;
        setError(
          err instanceof ApiError ? err.message : 'Failed to load notifications',
        );
      } finally {
        if (isMounted()) setIsLoading(false);
        inFlight.current = null;
      }
    })();

    inFlight.current = run;
    return run;
  }, [isMounted]);

  // ---------------------------------------------------------------------------
  // Writes
  //
  // Declared ABOVE the live-arrival handler that calls `markRead`, rather than
  // below it with the other writes: a `const` referenced before its declaration
  // works here only by the grace of the closure never running during render,
  // which is a fragile thing to rely on and an unpleasant one to re-derive.
  // ---------------------------------------------------------------------------

  const markRead = useCallback(
    async (id: string) => {
      // Snapshot for the rollback below. Taken before the optimistic write so
      // a failure restores exactly what was on screen.
      let previous: AppNotification[] = [];
      setNotifications((current) => {
        previous = current;
        return current.map((item) =>
          item.id === id && item.readAt === null
            ? // A client-side timestamp, and ONLY for the optimistic frame. The
              // server sets the real one; the next refresh overwrites this with
              // it. Nothing reads the value — the UI only asks "is this null?".
              { ...item, readAt: new Date().toISOString() }
            : item,
        );
      });

      try {
        const { unreadCount: next } = await markNotificationRead(id);
        // THE COUNT COMES FROM THE RESPONSE, never decremented locally and
        // never assumed. This is why the endpoint returns it: the round trip
        // that marks read is the same one that reports the new badge, so a
        // click costs one request and the number is always the server's.
        if (isMounted()) setUnreadCount(next);
      } catch (err) {
        if (!isMounted()) return;
        // 404 means it is already gone or was never this user's; the optimistic
        // state is wrong either way, so roll back and re-read rather than
        // leaving a row that claims to be read when the server disagrees.
        setNotifications(previous);
        if (!(err instanceof ApiError && err.status === 401)) void refresh();
      }
    },
    [isMounted, refresh],
  );

  // ---------------------------------------------------------------------------
  // Live arrivals
  // ---------------------------------------------------------------------------

  /**
   * A notification arrived over the stream.
   *
   * Held in a ref and read by the connection effect, so that changing this
   * callback — which it does on every render that changes `navigate` — cannot
   * tear down and re-establish the SSE connection. A connection that reconnects
   * on render is a connection that reconnects constantly.
   */
  const handleNotification = useCallback(
    (notification: AppNotification, toast: boolean) => {
      if (!isMounted()) return;

      // =======================================================================
      // ⚠️ #127: DECIDE NEWNESS HERE, ONCE, BEFORE ANY STATE UPDATER RUNS
      // =======================================================================
      //
      // The bug this replaces incremented `unreadCount` unconditionally while
      // the list deduped by id, so a duplicate frame left ONE row and TWO on
      // the badge — and duplicates are routine, not exotic: multi-tab fan-out,
      // and the reconnect refetch racing the live frame that follows it. The
      // count self-corrected on the next `refresh()`, but until then the badge
      // lied, and the badge is the entire product.
      //
      // The obvious repair — increment from inside the `setNotifications`
      // updater, where the dedupe decision is already made — IS NOT SAFE AND
      // MUST NOT BE REINTRODUCED. A state updater must be PURE: React is free
      // to call it more than once for a single update, and StrictMode
      // double-invokes it on purpose in development precisely to surface code
      // that assumes otherwise. `setUnreadCount` in there would fire twice per
      // arrival and re-create the exact bug under a new cause, visible only in
      // development, which is a worse bug than the one being fixed.
      //
      // So the decision is made against a REF, in plain event-callback code:
      //
      //   * This callback runs EXACTLY ONCE per stream frame. React neither
      //     replays nor double-invokes SSE handlers — only render, effects, and
      //     state updaters get that treatment.
      //   * The updater below stays pure: it reads `current`, returns a value,
      //     touches nothing else. Invoke it once or a hundred times and the
      //     result is identical and the count is untouched.
      //   * The ref survives StrictMode's double mount, so the second
      //     connection's re-delivery of an event in development is recognised
      //     as the duplicate it is instead of counted twice.
      const isNew = !seenNotificationIds.current.has(notification.id);
      rememberNotificationId(seenNotificationIds.current, notification.id);

      setNotifications((current) => {
        // DEDUPE BY ID. The same notification legitimately arrives twice: once
        // live, and again in the refetch that follows a reconnect. Without this
        // the list shows it twice and the two copies disagree about `readAt`
        // the moment one is clicked.
        //
        // KEPT even though `isNew` above already answers the same question, and
        // deliberately not replaced by `if (!isNew) return current`. This is the
        // list's own invariant — no duplicate rows, whatever the id memory says
        // — and it must hold even for an id the cap has evicted. Being a pure
        // function of `current` is also what makes it re-invocation-safe.
        if (current.some((existing) => existing.id === notification.id)) return current;
        return [notification, ...current].slice(0, RECENT_NOTIFICATION_COUNT);
      });

      // ONLY WHEN GENUINELY NEW (#127). Incremented locally rather than
      // refetched: the API told us this is a new, unread notification, and
      // spending a round trip to be told "one more" is waste. Every other path
      // through this file takes the count from the server, so any residual
      // drift is corrected by the next refresh at the latest.
      //
      // The updater form is still required — two arrivals in one batch must
      // stack, not overwrite each other — and it remains pure: `current + 1` is
      // the same answer however many times React asks for it, because the
      // decision to ask at all was already made above.
      if (isNew) setUnreadCount((current) => current + 1);

      // A DUPLICATE RAISES NO SECOND TOAST either — same reasoning as the
      // count. The user has already been interrupted about this notification;
      // a second OS-level popup for one event is the badge lie in audible form.
      if (!isNew) return;

      // =======================================================================
      // ⚠️ #227: THE SERVER-AUTHORITATIVE TOAST GATE
      // =======================================================================
      //
      // `toast` is this frame's OWN, freshly-computed answer to "may this
      // client raise an OS notification for this event?" — see
      // `NotificationStreamEvent.toast` in `types/index.ts`. It is deliberately
      // NOT derived from this tab's own `adminDisabled`/capability state (the
      // config `UserNotificationsPage` reads via `useNotificationConfig`):
      // a long-lived tab's cached `GET /api/notifications/config` can go stale
      // the instant an administrator flips the toggle, and nothing pushes an
      // update to it. Every SSE frame's `toast` flag, by contrast, is computed
      // at PUBLISH time from the policy that held then — so gating here, on the
      // frame itself, is what makes a stale client harmless: even a tab that
      // still believes toasts are enabled cannot raise one the server just said
      // not to show.
      //
      // ONLY THE TOAST IS GATED. `setNotifications` and `setUnreadCount` above
      // already ran unconditionally — `toast: false` does not mean suppressed,
      // it means the OS bubble alone is withheld; the bell, the unread count and
      // the notification centre are unaffected, exactly as the mandatory
      // `security.role_changed` alert's durable record survives an
      // administrator muting its toast. Placed the same way as the `isNew`
      // check above: alongside this call, never inside `setNotifications` or
      // `setUnreadCount`'s updaters.
      if (!toast) return;

      // =======================================================================
      // ⚠️ #224: SUPPRESS THE TOAST WHEN THIS WINDOW IS ALREADY WHAT THE USER
      // IS LOOKING AT — A SECOND, INDEPENDENT GATE ON TOP OF `isNew` ABOVE
      // =======================================================================
      //
      // NOT a replacement for the `isNew` return above, and not merged with it.
      // `isNew` answers "has this notification been accounted for yet" — a
      // question about the EVENT, decided once, from a ref, because a duplicate
      // stream frame must never double-count or double-toast regardless of
      // anything about the window. This answers a completely different
      // question — "is anyone about to miss it if we don't pop a toast" — which
      // is about the TAB'S CURRENT STATE and must be re-evaluated on every
      // genuinely-new arrival, not cached anywhere.
      //
      // The rule (per #224): show an OS notification only when NO window of
      // this registration is both visible and focused. When the tab the user
      // is actually looking at just gained a row in the bell and bumped the
      // badge, an OS popup on top of that is a second, redundant interruption
      // for something already on screen — the badge already IS the feedback.
      // `document.hasFocus()` alone is not enough: a fully covered-but-focused
      // window (alt-tabbed to another app while this browser window still has
      // OS input focus) reports `visibilityState === 'hidden'`, and a visible
      // background tab in the same window is not focused — BOTH conditions are
      // required together for "the user is plausibly looking at this right
      // now", which is exactly why the check is a `&&`, not an `||`.
      //
      // These are DOM globals (`document`, not anything from
      // `browserNotifications.ts`), so the check lives here rather than inside
      // `showAppNotification` — that module's job is "how do I raise a toast
      // given permission and a registration", not "should one be raised at
      // all", and it has no business reaching for `document` to answer a
      // question this file already has the context to ask first.
      //
      // Placed AFTER every state update above (`setNotifications`,
      // `setUnreadCount`) and BEFORE the toast call ONLY — the bell and unread
      // count must update identically whether or not the tab is focused; only
      // the OS-level popup is conditional. Do not move this earlier in the
      // function.
      //
      // A hidden or unfocused tab still gets exactly one toast — this check
      // does nothing there, on purpose. Cross-tab collapsing to ONE toast when
      // several backgrounded tabs are all eligible to show one is a SEPARATE
      // mechanism: the `getNotifications({ tag })` registration-wide guard in
      // `showAppNotification` (`services/browserNotifications.ts`). That one
      // works by reading what the browser has already displayed; this one
      // works by reading what the user is currently looking at. Neither
      // subsumes the other.
      if (document.visibilityState === 'visible' && document.hasFocus()) return;

      // THIRD IN THE ORDERING, and deliberately last: the centre is already
      // correct by this point, so everything below is free to fail. Fired
      // and forgotten — `showAppNotification` resolves with which path (if
      // any) raised the toast, purely for tests/diagnostics, and nothing here
      // is waiting on that answer.
      void showAppNotification(notification, (clicked) => {
        // Marking read on activation matches clicking the row in the bell —
        // the user has demonstrably seen it.
        void markRead(clicked.id);
        if (isInternalLink(clicked.link)) navigate(clicked.link);
      });
    },
    [isMounted, navigate, markRead],
  );

  /**
   * ⚠️ THE GAP RECOVERY. Fires on the first connect AND on every reconnect.
   *
   * See this file's header. The stream replays nothing, so this refetch is the
   * ONLY thing that makes a dropped connection — or an event published on
   * another API replica — harmless. It is not redundant with the mount fetch
   * below: that one covers "the page loaded", this one covers "the connection
   * came back, and we do not know what we missed".
   */
  const handleStreamOpen = useCallback(() => {
    void refresh();
  }, [refresh]);

  // Latest-callback refs, so the connection effect below can depend on
  // `isAuthenticated` ALONE. Putting the handlers in its dependency array would
  // drop and re-open the SSE connection on unrelated re-renders.
  const handlersRef = useRef({ handleNotification, handleStreamOpen });
  useEffect(() => {
    handlersRef.current = { handleNotification, handleStreamOpen };
  }, [handleNotification, handleStreamOpen]);

  // ---------------------------------------------------------------------------
  // Mount fetch — INDEPENDENT of the stream, on purpose
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!isAuthenticated) {
      // Logged out. Clear everything rather than leaving the previous user's
      // notifications rendered behind a login redirect, and reset `isLoading`
      // so a subsequent login shows a spinner rather than a stale empty state.
      setNotifications([]);
      setUnreadCount(0);
      setIsLoading(true);
      setError(null);
      // #127: the id memory is per-session state like everything above it. A
      // stale set would let the next user's first arrivals be mistaken for
      // duplicates on an id collision and silently not counted.
      seenNotificationIds.current.clear();
      return;
    }

    // UNCONDITIONAL, and not folded into the stream's `onOpen`. The centre must
    // populate even when SSE never connects at all — a proxy that buffers the
    // stream, a corporate middlebox that kills it, a browser extension. Making
    // the primary surface's data depend on the optional transport connecting is
    // exactly the coupling this feature is built to avoid. The duplicate
    // request at startup is deduped by `inFlight` above.
    void refresh();
  }, [isAuthenticated, refresh]);

  // ---------------------------------------------------------------------------
  // The stream
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!isAuthenticated) {
      setStreamState('closed');
      return;
    }

    const connection = connectNotificationStream({
      // Indirected through the ref so this effect never re-runs for a changed
      // callback identity.
      onNotification: (notification, toast) =>
        handlersRef.current.handleNotification(notification, toast),
      onOpen: () => handlersRef.current.handleStreamOpen(),
      onStateChange: (state) => {
        if (isMounted()) setStreamState(state);
      },
    });

    // TEARDOWN ON UNMOUNT AND ON LOGOUT. `close()` aborts the in-flight fetch,
    // cancels any pending backoff timer and detaches the `online` listener, so
    // a logged-out tab holds no socket and schedules no work. It is idempotent,
    // which matters under StrictMode's double-mount in development.
    return () => connection.close();
  }, [isAuthenticated, isMounted]);

  // ---------------------------------------------------------------------------
  // The service-worker click bridge — issue #223, epic #215
  // ---------------------------------------------------------------------------
  //
  // `sw.ts`'s `notificationclick` handler is the ONLY place a click on a
  // worker-shown notification (Android's SW-only toast path, or any toast that
  // fires with no page in view — see `showAppNotification` in
  // `services/browserNotifications.ts`, issue #222) can be caught, and that
  // handler has no token to mark anything read with — see the "never call the
  // API" constraint documented at the top of `sw.ts`. So when a page IS open,
  // the worker `postMessage`s the click here instead of acting on it, and this
  // listener finishes the job with the token this page already holds.
  //
  // REUSES `markRead` AND `isInternalLink`/`navigate` RATHER THAN DUPLICATING
  // THEM. This is deliberately the SAME pair of calls `handleNotification`
  // above makes from the in-page toast's `onClick` — a worker-delivered click
  // and a page-delivered click are the same user action wearing two different
  // delivery mechanisms, and a notification clicked via the worker must be
  // indistinguishable in its effect from one clicked via `new Notification()`.
  //
  // `navigator.serviceWorker` can be undefined (no SW support, or a context
  // where `self.serviceWorker` never registers) — guarded rather than asserted,
  // the same posture `browserNotifications.ts` takes everywhere it touches
  // this API.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; id?: unknown; link?: unknown } | null;
      if (!data || data.type !== 'notification-click') return;

      // Matches the toast's `onClick` in `handleNotification` above: mark read
      // first (the click itself is the "seen" signal), then navigate only if
      // the link is a validated in-app destination.
      const link = typeof data.link === 'string' ? data.link : null;
      if (typeof data.id === 'string') void markRead(data.id);
      if (isInternalLink(link)) navigate(link);
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [markRead, navigate]);

  // ---------------------------------------------------------------------------
  // The cold-open `?n=` handler — issue #223, epic #215
  // ---------------------------------------------------------------------------
  //
  // The other half of `sw.ts`'s `notificationclick` handler: when NO page is
  // open to `postMessage`, the worker cannot deliver the click at all — there
  // is nothing listening yet — so it `clients.openWindow()`s the link with the
  // notification id encoded as `?n=<id>` instead, and this effect is what
  // reads that back once the app has booted and (if the user is signed in) a
  // token exists to mark it read with.
  //
  // GUARDED ON `isAuthenticated`, not just presence of `n`: a cold-opened
  // window loads `/login` first for a signed-out user, and this provider
  // itself only mounts inside the authenticated shell (see `App.tsx`) — but
  // `searchParams` is still readable at that point via the router, and calling
  // `markRead` before a session exists would just spend a request on a 401
  // that `markRead` already swallows. Waiting for `isAuthenticated` means the
  // mark-read fires once, right after the shell mounts for real.
  //
  // STRIPPED WITH `replace: true` AFTER CONSUMING IT, not left in the URL: a
  // page refresh must not re-fire the same mark-read (harmless, since
  // `markRead` is idempotent server-side, but noisy) and must not leave `n` in
  // a bookmarked or shared URL. `replace` keeps the strip out of the history
  // stack, so Back does not resurrect the param.
  useEffect(() => {
    if (!isAuthenticated) return;

    const notificationId = searchParams.get('n');
    if (!notificationId) return;

    void markRead(notificationId);

    const next = new URLSearchParams(searchParams);
    next.delete('n');
    setSearchParams(next, { replace: true });
  }, [isAuthenticated, searchParams, markRead, setSearchParams]);

  // ---------------------------------------------------------------------------
  // Writes, continued — `markRead` sits above the live-arrival handler that
  // calls it; `markAllRead` has no such constraint and stays here.
  // ---------------------------------------------------------------------------

  const markAllRead = useCallback(async () => {
    let previous: AppNotification[] = [];
    const now = new Date().toISOString();

    setNotifications((current) => {
      previous = current;
      return current.map((item) => (item.readAt === null ? { ...item, readAt: now } : item));
    });

    try {
      const { unreadCount: next } = await markAllNotificationsRead();
      // NOT `setUnreadCount(0)`. The API returns the real count precisely
      // because a notification can arrive between the update and the count, and
      // hardcoding zero would hide it until the next refresh.
      if (isMounted()) setUnreadCount(next);
    } catch (err) {
      if (!isMounted()) return;
      setNotifications(previous);
      if (!(err instanceof ApiError && err.status === 401)) void refresh();
    }
  }, [isMounted, refresh]);

  const value: NotificationContextValue = {
    notifications,
    unreadCount,
    isLoading,
    error,
    streamState,
    refresh,
    markRead,
    markAllRead,
  };

  return (
    <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
  );
}

/**
 * The notification centre, or `null` where none is mounted.
 *
 * DOES NOT THROW ON A MISSING PROVIDER, unlike `useAuth`, and the difference is
 * deliberate. The only consumer is the bell in the `AppBar`, which is part of
 * the app shell; a shell that refuses to render because an optional data
 * provider is absent turns a missing decoration into a blank page. `AppBar` is
 * also rendered on its own in several test files, and none of them is about
 * notifications.
 *
 * The cost is that a wiring mistake hides the bell silently instead of failing
 * loudly, so the coverage that matters is a POSITIVE assertion — "with the
 * provider mounted, the bell is present" — rather than reliance on a crash.
 */
export function useNotifications(): NotificationContextValue | null {
  return useContext(NotificationContext);
}
