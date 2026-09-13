/**
 * The event x channel notification preferences matrix.
 *
 * Issue #126, epic #109. Rendered by `pages/UserNotificationsPage.tsx` at
 * `/settings/notifications`.
 *
 * =============================================================================
 * THE SPARSE ABSENT-KEY CONTRACT — READ THIS BEFORE CHANGING ANYTHING HERE
 * =============================================================================
 *
 * The stored document is `user_settings.value.notifications`, channel-outer:
 *
 *     { email: { 'user.welcome': false }, browser: { ... } }
 *
 * A key is present ONLY where the user deliberately chose. Absent — at the
 * namespace, the channel, or the event level — means "use the registry's
 * `defaultEnabled`", resolved at read time by the API
 * (`notifications/notification-preferences.ts`). Three properties depend on
 * that, and each breaks in a way nobody notices for weeks:
 *
 *   1. NO MIGRATION, NO BACKFILL. The feature shipped by reading a key that
 *      does not exist for anybody.
 *   2. NOBODY IS MUTED ON ARRIVAL. Every pre-existing account has no
 *      `notifications` namespace at all; if absent meant "off", the framework
 *      would ship silent for the entire user base, and the only symptom would
 *      be mail nobody receives — a failure with no error anywhere.
 *   3. AN EVENT ADDED LATER IS OPT-OUT, NOT SILENTLY OFF. A user who saved a
 *      preference today has a stored map that says nothing about an event
 *      declared next year; absent-means-default gives them that event's
 *      intended default, where a materialised blob would give them "not in my
 *      map, therefore off".
 *
 * THREE RULES THIS FILE ENFORCES, EACH THE PRECISE OPPOSITE OF THE OBVIOUS
 * IMPLEMENTATION:
 *
 *   A. EVERY CONTROL DERIVES ITS STATE (see `isEventChannelEnabled`) from the
 *      fetched preferences compared against the registry's `defaultEnabled`.
 *      There is NO local `Record<event, boolean>` state in this component, and
 *      there must never be one. The moment a defaulted local object exists, the
 *      first save serialises it and materialises every key in it.
 *
 *   B. NEVER WRITE A FULL PREFERENCES OBJECT — not on mount, not on first
 *      change. Each toggle emits exactly the one `(channel, event, value)` it
 *      changed and the page PATCHes that single key; the API deep-merges per
 *      event, so everything else stays absent.
 *
 *   C. RETURNING A CONTROL TO ITS DEFAULT SENDS A NULL-DELETE (see
 *      `preferenceWriteFor`), never the default value. Writing the default
 *      explicitly works today, and it opts that user in permanently: the key is
 *      materialised, the blob grows for no reason, and if the default ever
 *      changes that user is frozen at the old one with nothing to show why.
 *
 * NO SAVE BUTTON, DELIBERATELY. A batched save needs a full local mirror to
 * diff against, which is exactly the shape that ends up POSTing a materialised
 * object — rule A and rule B fall together the moment a Save button appears.
 * Every toggle is its own PATCH and its own snackbar.
 *
 * =============================================================================
 * RESPONSIVE WITHOUT A BREAKPOINT GATE
 * =============================================================================
 *
 * There is no `useMediaQuery` here and no `display: { xs, sm }` switch between
 * two layouts. `CLAUDE.md` names five coupled breakpoint gates that move
 * together or not at all (`Layout.tsx`'s `showRail`, `BottomNav`'s self-gate,
 * `<main>`'s padding, and `isCompactWindow` in both `SettingsHub.tsx` and
 * `AppBar.tsx`); a sixth gate here would be a sixth thing to keep in lockstep
 * for no gain.
 *
 * Instead each row is ONE flex container that wraps: the event's label and
 * description take the left, the channel switches the right, and on a narrow
 * viewport the switches simply flow underneath. Every switch carries its own
 * visible channel label, so the matrix is self-describing at every width — no
 * column header row that has to survive being wrapped away, which is precisely
 * where a table layout breaks down in a 320px drill-down.
 */

import { useId } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import type {
  NotificationChannel,
  NotificationEventDef,
  NotificationPreferences,
} from '../../types';
import type { NotificationCapability } from '../../hooks/useNotificationCapability';
import { AddToHomeScreenPanel } from './AddToHomeScreenPanel';

// =============================================================================
// Derivation — the pure half, exported so it can be reasoned about and tested
// without a DOM.
// =============================================================================

/**
 * Is this event enabled on this channel, for this user?
 *
 * THE MIRROR OF THE API'S `isChannelEnabled`, function for function, including
 * the order of its checks — `mandatory` first, then the three-level fallback.
 * Two implementations of one rule is a drift risk, and it is accepted here for
 * one reason: the alternative is a per-user "resolved preferences" endpoint,
 * i.e. the server materialising exactly the defaulted object this whole design
 * refuses to store. The UI reads the raw sparse document and applies the same
 * rule; the SERVER's copy remains the only one that decides delivery, so a
 * drift shows as a wrong checkbox, never as a wrong send.
 *
 * `mandatory` is checked BEFORE the stored value, so a preference row that
 * disables a mandatory event — one written before the event became mandatory,
 * or by a crafted PATCH — renders as ON, which is what the user will actually
 * receive. Rendering the stored `false` there would be an honest reading of the
 * document and a lie about the behaviour.
 *
 * @param preferences the raw stored namespace, or `undefined` when the user has
 *                    never saved a preference — the single most common case.
 */
export function isEventChannelEnabled(
  event: NotificationEventDef,
  channel: NotificationChannel,
  preferences: NotificationPreferences | undefined,
): boolean {
  if (event.mandatory) return true;

  const channelPrefs = preferences?.[channel];
  // Level 1: no namespace, or nothing stored for this channel.
  if (!channelPrefs) return event.defaultEnabled;

  // Level 2: `hasOwnProperty`, never `channelPrefs[key] !== undefined` and
  // never a truthiness test. A stored `false` is a real, deliberate choice and
  // must not collapse into "absent"; and an own-property check is also what
  // keeps an event key like `constructor` or `toString` from resolving to a
  // function off `Object.prototype`. This object came out of a user-writable
  // JSONB column, so that is not hypothetical.
  if (!Object.prototype.hasOwnProperty.call(channelPrefs, event.key)) {
    return event.defaultEnabled;
  }

  // Level 3: honour it only if it is a boolean. Anything else was not written
  // by this system, so it is not a choice this system will honour.
  const choice = channelPrefs[event.key];
  return typeof choice === 'boolean' ? choice : event.defaultEnabled;
}

/**
 * What to send for a control the user has just moved to `nextEnabled`.
 *
 * `null` is a JSON Merge Patch DELETE and is the WHOLE POINT of this function:
 * when the new state equals the registry default, the correct write is to
 * remove the key and return the user to "no opinion", not to pin today's
 * default into their document. See rule C in the file header.
 *
 * Both directions matter, which is why this compares against `defaultEnabled`
 * rather than special-casing "re-enabling":
 *   * default `true`, user muted it, user un-mutes  -> next `true`  -> DELETE
 *   * default `false`, user opted in, user opts out -> next `false` -> DELETE
 * and a first, non-default change stores the explicit boolean.
 */
export function preferenceWriteFor(
  event: NotificationEventDef,
  nextEnabled: boolean,
): boolean | null {
  return nextEnabled === event.defaultEnabled ? null : nextEnabled;
}

// =============================================================================
// Channel presentation
// =============================================================================

/**
 * The visible label per channel.
 *
 * Keyed by the channels this build knows about. `channelLabel` is DEFENSIVE
 * about the lookup — a newer server can declare a channel this bundle has
 * never heard of (the registry is server-owned, which is the entire point of
 * fetching it rather than mirroring it), and the right behaviour then is to
 * render the raw key rather than put an empty label on a live control.
 */
const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: 'Email',
  browser: 'Browser',
  // The push column (#228). `pushChannelState()` below disables it while the
  // deployment has push off, and notes when this device has not granted
  // permission. Rows appear only for events that declare `push`.
  push: 'Push',
};

function channelLabel(channel: NotificationChannel): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/**
 * How a gated channel column must behave: whether its control is disabled,
 * the terse note beside it, and the banner above the whole matrix.
 *
 * SHARED BY `browserChannelState` AND `pushChannelState` — originally this
 * was `BrowserChannelState`, named for its one caller, but `push` needs the
 * exact same three fields (a control can be live or not, with or without a
 * one-line reason, with or without a banner explaining why) for a completely
 * different underlying reason (an unimplemented feature, not a browser
 * permission). Two interfaces that are structurally identical and diverge
 * only in field NAMES would be the worse choice here: every caller below —
 * the channel-state lookup, the render column, the banner block — treats
 * both the same way, and a shared name says so instead of asking the reader
 * to notice two shapes happen to line up. `email` never produces one of
 * these at all: it is never gated, so it simply has no entry wherever these
 * are collected (see `channelStates` in the component below).
 */
interface ChannelState {
  disabled: boolean;
  /** Terse note beside the control. `null` when there is nothing to add. */
  note: string | null;
  /** The banner above the matrix. `null` when the channel is fully working. */
  alert: { severity: 'info' | 'warning'; title: string; body: string } | null;
}

/**
 * How the browser column must behave for a given CAPABILITY state.
 *
 * SEPARATED FROM THE JSX so the honest answer to "what does `denied` do?" is
 * one readable table rather than eight ternaries spread through a render, and
 * so the copy is assertable without a DOM. #126 wrote this over the 4-state
 * permission; #221 widened it to `NotificationCapability`, and the widening is
 * the whole point:
 *
 *   EVERY ARM MUST NAME A DIFFERENT THING TO DO.
 *
 * That is the rule this function exists to keep. Before #221 an iOS Safari tab,
 * a plain-HTTP origin and a browser from 2011 all rendered the identical "not
 * supported by this browser" — one of which is a lie, one of which blames the
 * wrong party, and none of which tells the user the fix. If a new state is
 * added here and its copy could be swapped with another arm's without anyone
 * noticing, the state is not pulling its weight and should not exist.
 *
 * `disabled` is true only where the app genuinely cannot deliver AND cannot
 * recover — a control that looks live but can never take effect is worse than
 * one that explains itself:
 *   * `admin-disabled`   — the server will not send on this channel at all.
 *   * `insecure-context` — the API cannot exist over plain HTTP.
 *   * `unsupported`      — no `Notification` API at all. Nothing to configure.
 *   * `denied`           — the browser refused; nothing this application does
 *                          can undo that, only the user in their browser's site
 *                          settings.
 *   * `ios-needs-install`— nothing to configure until the app is installed;
 *                          iOS does not even offer a permission before then.
 *   * `sw-unavailable`   — NOT disabled. Degraded, not blocked, and reached
 *                          only with permission ALREADY GRANTED: the page-level
 *                          `Notification` fallback may still deliver, and a
 *                          stored preference is still meaningful. A warning
 *                          explains the risk; a disabled control would overstate
 *                          it, and copy that told the user to enable something
 *                          would be addressing a step they have already taken.
 *   * `default`          — NOT disabled. The permission has not been asked for
 *                          yet, and the stored preference is still meaningful:
 *                          it is what takes effect the moment permission is
 *                          granted. Disabling it would force the user to grant
 *                          permission before they are allowed to express an
 *                          opinion, which is backwards.
 *   * `granted`          — nothing to say.
 */
export function browserChannelState(
  capability: NotificationCapability,
): ChannelState {
  switch (capability) {
    case 'granted':
      return { disabled: false, note: null, alert: null };

    case 'admin-disabled':
      return {
        disabled: true,
        note: 'Turned off by an administrator',
        alert: {
          // `info`, not `warning`: nothing is broken and nothing is at risk.
          // This is a deliberate configuration, and the only useful thing to
          // say is that no amount of fiddling on this page will change it.
          severity: 'info',
          title: 'Browser notifications are turned off for this application',
          body:
            'An administrator has disabled browser notifications for everyone, ' +
            'so nothing you change here will make them appear. Email ' +
            'notifications are unaffected. Ask an administrator if you need ' +
            'them turned back on.',
        },
      };

    case 'insecure-context':
      return {
        disabled: true,
        note: 'Requires a secure (HTTPS) connection',
        alert: {
          severity: 'warning',
          title: 'Notifications need a secure connection',
          // NAMES THE localhost EXEMPTION on purpose: in practice the person
          // most likely to see this state is a developer running the app over
          // plain HTTP on a LAN address, and "use HTTPS" alone reads as
          // "impossible locally" when it is not.
          body:
            'This page is not being served over HTTPS, so your browser will ' +
            'not allow notifications here. Open the site over HTTPS to turn ' +
            'them on. (localhost counts as secure — a plain http:// address ' +
            'on any other host does not.)',
        },
      };

    case 'unsupported':
      return {
        disabled: true,
        note: 'Not supported by this browser',
        alert: {
          severity: 'info',
          // NARROWED BY #221. This arm used to absorb iOS tabs and insecure
          // origins, so its copy had to hedge about HTTPS; both now have their
          // own state, and this one can say the single true thing that is left.
          title: 'This browser cannot show notifications',
          body:
            'This browser does not provide the notifications API, so there is ' +
            'nothing to turn on here. Email notifications are unaffected.',
        },
      };

    case 'ios-needs-install':
      return {
        disabled: true,
        note: 'Add to Home Screen to enable',
        alert: {
          severity: 'info',
          title: 'Add this app to your Home Screen',
          // DELIBERATELY SHORT. #231 adds the illustrated step-by-step panel;
          // this is the inline note that has to be right on its own until then,
          // and the one thing it must not do is repeat the old lie that the
          // browser is incapable.
          body:
            'On iPhone and iPad, notifications work only for a web app added ' +
            'to the Home Screen. In Safari, tap the Share button, choose "Add ' +
            'to Home Screen", then open the app from there and allow ' +
            'notifications.',
        },
      };

    case 'sw-unavailable':
      return {
        // NOT DISABLED — degraded, not blocked. See the header above.
        disabled: false,
        note: 'Allowed, but delivery may be limited',
        alert: {
          severity: 'warning',
          // THE COPY MUST NOT READ AS "YOU CANNOT ENABLE THESE". Permission is
          // already granted in this state — the capability hook only reports it
          // for a granted device (see `useNotificationCapability`'s header) —
          // so the user has done everything asked of them and the remaining
          // problem is ours, not theirs.
          title: 'Notifications are on, but may not always arrive',
          body:
            'You have allowed browser notifications, but the background ' +
            'service worker did not register, so some may not appear — on ' +
            'Android in particular it is the only way they can be shown. ' +
            'Reloading the page usually fixes it, and everything still ' +
            'arrives in the notification centre either way.',
        },
      };

    case 'denied':
      return {
        disabled: true,
        note: 'Blocked by your browser',
        alert: {
          severity: 'warning',
          title: 'Browser notifications are blocked',
          // Names the remedy AND who owns it. This application cannot re-ask
          // for a permission the user has denied, so telling them to "try
          // again here" would be a lie.
          //
          // PER-PLATFORM, because "allow it in your browser settings" is a
          // remedy nobody can follow: the control is in a different place in
          // every browser and is nowhere near anything labelled "settings" in
          // two of the three. Newlines render as a list (see `alert.body`).
          body:
            'Your browser is blocking notifications from this site, so these ' +
            'preferences cannot take effect. Only you can undo this:\n' +
            '• Chrome or Edge: click the icon at the left of the address bar → Notifications → Allow\n' +
            '• Firefox: click the padlock in the address bar → Clear the blocked notifications permission\n' +
            '• Safari: Settings → Websites → Notifications → allow this site',
        },
      };

    case 'default':
    default:
      return {
        disabled: false,
        note: 'Permission not granted yet',
        alert: {
          severity: 'info',
          title: 'Browser notifications need your permission',
          body:
            'Your browser has not been asked for permission yet, so these ' +
            'notifications will not appear until you allow them. Your choices ' +
            'here are saved and take effect as soon as permission is granted.',
        },
      };
  }
}

/**
 * How the push column must behave.
 *
 * `pushEnabled` is `GET /api/notifications/config`'s `pushEnabled` — `true`
 * once an administrator has generated and enabled VAPID keys (#355).
 *
 *   * `pushEnabled === false` — disabled, "not available". Phrased as a
 *                     deployment setting, never as a browser refusal: the
 *                     user cannot fix it, and blaming their browser would
 *                     send them looking for a setting that does not exist.
 *   * `pushEnabled === true`  — never disabled: the preference is per ACCOUNT
 *                     and applies on every device. When THIS device has not
 *                     granted permission (`browserCapability` is anything but
 *                     `granted`/`sw-unavailable`), the row says so in a note;
 *                     the remedy lives in the browser banner and the app-wide
 *                     banner, so there is no second alert here.
 */
export function pushChannelState(
  pushEnabled: boolean,
  browserCapability?: NotificationCapability,
): ChannelState {
  if (pushEnabled) {
    const deviceReady =
      browserCapability === undefined ||
      browserCapability === 'granted' ||
      browserCapability === 'sw-unavailable';
    return {
      disabled: false,
      note: deviceReady ? null : 'Not enabled on this device',
      alert: null,
    };
  }
  return {
    disabled: true,
    note: 'Not available yet',
    alert: {
      severity: 'info',
      title: 'Push notifications are not available yet',
      body:
        'Push notifications have not been turned on for this server. ' +
        'Email and browser notifications are unaffected.',
    },
  };
}

// =============================================================================
// Component
// =============================================================================

export interface NotificationSettingsProps {
  /**
   * The registry, in server order. Rendered as given and NEVER sorted — the
   * order is meaningful and is the API's to decide.
   */
  events: NotificationEventDef[];
  /**
   * The raw stored namespace. `undefined` when the user has never saved a
   * preference, which is the normal case and is NOT a loading state — every
   * control resolves to its registry default.
   */
  preferences: NotificationPreferences | undefined;
  /**
   * One toggle happened. `value` is the boolean to store, or `null` to DELETE
   * the key and restore the registry default (see `preferenceWriteFor`).
   *
   * The caller turns this into `{ notifications: { [channel]: { [key]: value } } }`
   * — one channel, one key, nothing else on the wire.
   */
  onToggle: (channel: NotificationChannel, event: NotificationEventDef, value: boolean | null) => void;
  /**
   * A save is in flight. EVERY control is disabled, not just the one that was
   * clicked, and that is on purpose: `useUserSettings` sends `If-Match` with
   * the settings version it currently holds, so two toggles racing produce two
   * PATCHes with the same expected version and the second 409s. Serialising
   * them costs a few hundred milliseconds and removes the conflict entirely.
   */
  isSaving?: boolean;
  /**
   * What this device can actually do about browser notifications, from
   * `useNotificationCapability` (#221).
   *
   * WIDER THAN `Notification.permission`, and named for that: it folds in the
   * administrator kill switch, the secure-context requirement, the iOS
   * install-first rule and the service worker's registration, because each of
   * those has a remedy the raw permission cannot express. `browserChannelState`
   * above turns it into the copy.
   */
  browserCapability: NotificationCapability;
  /**
   * Whether this deployment offers Web Push, from
   * `GET /api/notifications/config`'s `pushEnabled` (passed by
   * `UserNotificationsPage` since #365). Optional, defaulting to `false` —
   * the safe reading while the config is unknown.
   */
  pushEnabled?: boolean;
  /**
   * Ask the browser for notification permission (#127).
   *
   * FILLS THE SEAM #126 LEFT in the `default`-state banner below. The component
   * does NOT call `Notification.requestPermission()` itself — it raises this
   * callback from a click, and the page owns the call plus the `refresh()` that
   * follows it. That split is what keeps the prompt out of this component's
   * render path entirely: there is no code here that COULD fire it on mount,
   * because the API call is not in this file.
   *
   * Optional, and the button is only rendered when it is supplied. A promptless
   * host renders the same honest banner #126 shipped.
   */
  onRequestPermission?: () => void;
  /**
   * The permission prompt is open. Disables the button so a second click cannot
   * stack a second request behind the browser's modal.
   */
  isRequestingPermission?: boolean;
}

export function NotificationSettings({
  events,
  preferences,
  onToggle,
  isSaving = false,
  browserCapability,
  onRequestPermission,
  isRequestingPermission = false,
  pushEnabled = false,
}: NotificationSettingsProps) {
  // `useId` rather than interpolating `event.key`: two instances of this
  // component (or a future second matrix on the page) would otherwise emit
  // duplicate ids, and a duplicated id silently points every `aria-describedby`
  // at the first match.
  const idPrefix = useId();

  const browser = browserChannelState(browserCapability);
  const push = pushChannelState(pushEnabled, browserCapability);

  // ONE LOOKUP, BUILT ONCE PER RENDER, REPLACING A GROWING `isBrowser` /
  // `isPush` TERNARY CHAIN. With one gated channel the explicit-branch style
  // the rest of this file favours (see the file header's "READ THIS BEFORE
  // CHANGING ANYTHING" rules, all written as explicit named checks) still
  // read fine; with two — and #229/#230 plausibly landing a third kind of
  // gating later, once real push delivery exists — the ternary chain grows
  // one branch per channel while this map grows one KEY per channel, in the
  // same shape every time. `email` is deliberately absent: it is never
  // gated, so it has no entry, and the per-channel lookups below (`?? false`,
  // `?? null`) fall through to "nothing to disable, nothing to say" for it
  // and for any channel a newer server declares that this build has no
  // `ChannelState` for at all.
  const channelStates: Partial<Record<NotificationChannel, ChannelState>> = {
    browser,
    push,
  };

  // Only relevant if some event actually declares the channel. Today only
  // `security.role_changed` declares `browser`, and an event list that
  // declares none must not show a banner about a column that is not on
  // screen.
  const showsBrowserChannel = events.some((event) => event.channels.includes('browser'));
  // Same shape as `showsBrowserChannel`: the push banner appears only when
  // some registry event declares `push`.
  const showsPushChannel = events.some((event) => event.channels.includes('push'));

  if (events.length === 0) {
    // A REAL ANSWER, not a loading state — the caller renders a spinner while
    // the registry is unknown. An empty matrix with no explanation reads as a
    // page that failed to load.
    return (
      <Alert severity="info">
        This application does not send any notifications yet.
      </Alert>
    );
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Notifications
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Choose what reaches you, and how. Changes are saved as you make them.
        </Typography>

        {/*
          `ios-needs-install` GETS THE ILLUSTRATED PANEL, NOT THE GENERIC ALERT
          BELOW — #231. `browserChannelState` still carries a short `alert` for
          this capability (its `note` and `disabled` are still used by every
          switch row below), but its `body` was deliberately written as a
          one-line placeholder for exactly this panel; rendering both here
          would say the same thing twice in two shapes. Every other capability
          continues straight to the generic `browser.alert` banner beneath.
        */}
        {showsBrowserChannel && browserCapability === 'ios-needs-install' && (
          <Box sx={{ mb: 2 }}>
            <AddToHomeScreenPanel />
          </Box>
        )}

        {showsBrowserChannel && browserCapability !== 'ios-needs-install' && browser.alert && (
          <Alert severity={browser.alert.severity} sx={{ mb: 2 }}>
            <AlertTitle>{browser.alert.title}</AlertTitle>
            {/*
              `pre-line`, so the newlines `browserChannelState` writes into a
              body render as the short list they are. Text-node interpolation
              is kept (no `dangerouslySetInnerHTML`, no markdown parser) —
              this is copy, and CSS is the whole mechanism it needs.
            */}
            <Box component="span" sx={{ whiteSpace: 'pre-line' }}>
              {browser.alert.body}
            </Box>
            {/*
              ===================================================================
              THE PERMISSION PROMPT (#127) — FILLING THE SEAM #126 MARKED HERE
              ===================================================================
              Rendered ONLY in the `default` state: `granted` has nothing to ask
              for, and in `denied` / `unsupported` a button would be a lie —
              neither is recoverable from inside this application, which is why
              `browserChannelState` gives those two an explanatory alert and no
              action.

              THIS COMPONENT NEVER PROMPTS ON ITS OWN; it raises
              `onRequestPermission` from a click. Since #365 the shell also
              auto-prompts once per load when push is enabled
              (`usePushSubscriptionSync`), but this button still matters:
              Firefox requires a user gesture, Safari may throw, and Chrome can
              demote a gestureless prompt to a quiet UI. A denial is
              effectively permanent — only the user can undo it in site
              settings — so the button appears in `default` and nowhere else.

              The state afterwards is re-read through
              `useNotificationCapability().refresh()` in
              `UserNotificationsPage` (which delegates to the permission hook
              underneath it and re-probes the service worker), so this banner
              becomes the `granted` or
              `denied` treatment without a reload — including the case where the
              user dismisses the prompt without choosing, which leaves the
              permission at `default` and correctly leaves this button in place.
            */}
            {/*
              STILL EXACTLY ONE STATE, now that there are eight (#221). Every
              other arm is a state in which asking would be wrong: `granted`
              and `sw-unavailable` have already been granted, so there is
              nothing left to ask for; `denied`, `unsupported`,
              `insecure-context` and `admin-disabled` cannot be recovered from
              inside this application; and `ios-needs-install` has no permission
              to grant until the app is installed. Each of those gets an
              explanatory alert and no action.

              NOTE WHAT THIS MEANS FOR A MISSING SERVICE WORKER: it does NOT
              suppress this button, because `sw-unavailable` is only ever
              reported for an already-granted device. A model that let a missing
              worker preempt `default` would strand the user — the prompt lives
              here and nowhere else, so they could never grant permission, and
              #222's page-level `new Notification()` fallback (which exists for
              exactly the no-registration case) would be unreachable on any
              profile that had not already granted.
            */}
            {browserCapability === 'default' && onRequestPermission && (
              <Box sx={{ mt: 1.5 }}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={onRequestPermission}
                  disabled={isRequestingPermission}
                  startIcon={
                    isRequestingPermission ? <CircularProgress size={16} /> : undefined
                  }
                >
                  {/* The label names the ACTION and its consequence. "Enable" or
                      "Turn on" would over-promise: this button opens the
                      browser's own prompt, and the browser — not this app —
                      decides what happens next. */}
                  {isRequestingPermission ? 'Waiting for your browser…' : 'Allow notifications'}
                </Button>
              </Box>
            )}
          </Alert>
        )}

        {showsPushChannel && push.alert && (
          <Alert severity={push.alert.severity} sx={{ mb: 2 }}>
            <AlertTitle>{push.alert.title}</AlertTitle>
            {push.alert.body}
            {/*
              NO ACTION BUTTON HERE. This alert only renders while the
              deployment has push off, which no user action can change. The
              permission a push subscription needs is requested by the browser
              banner above and by the app-wide banner (#365).
            */}
          </Alert>
        )}

        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {events.map((event, index) => {
            const descriptionId = `${idPrefix}-${event.key}-description`;

            return (
              <Box component="li" key={event.key}>
                {index > 0 && <Divider />}

                {/*
                  ONE WRAPPING FLEX ROW — see the header. The label block has a
                  flex BASIS rather than a width so it takes the leftover space
                  on a desktop and drops the switches onto their own line on a
                  phone, with no breakpoint gate deciding which.
                */}
                <Box
                  sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    py: 2,
                  }}
                >
                  <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <Typography variant="subtitle1" component="h3">
                        {event.label}
                      </Typography>
                      {event.mandatory && (
                        // VISIBLY LOCKED, WITH THE REASON. The alternative —
                        // hiding the row, or leaving a switch that silently
                        // refuses — is what epic #109's success criterion 5
                        // rules out: a user who cannot find the security alert
                        // in their preferences assumes it is not being sent,
                        // and a control that does nothing when clicked reads as
                        // a bug rather than as a policy.
                        <Chip
                          size="small"
                          icon={<LockIcon fontSize="small" />}
                          label="Always on"
                        />
                      )}
                    </Box>
                    <Typography id={descriptionId} variant="body2" color="text.secondary">
                      {event.description}
                      {event.mandatory && (
                        <>
                          {' '}
                          <Box component="span" sx={{ fontStyle: 'italic' }}>
                            This is a security notification and cannot be turned off.
                          </Box>
                        </>
                      )}
                    </Typography>
                  </Box>

                  <Box
                    sx={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'flex-start',
                      columnGap: 2,
                      rowGap: 0.5,
                    }}
                  >
                    {/*
                      ONLY THE CHANNELS THIS EVENT DECLARES. Rendering the full
                      channel set for every row would offer, for instance, a
                      browser toggle for `allowlist.invitation` — whose
                      recipient has no session and no open tab by definition.
                    */}
                    {event.channels.map((channel) => {
                      const checked = isEventChannelEnabled(event, channel, preferences);
                      // See `channelStates` above: `email` (and any channel a
                      // newer server declares that this build has no
                      // `ChannelState` for) has no entry, so both fallbacks
                      // below apply — nothing disabled, nothing to note.
                      const channelState = channelStates[channel];
                      const channelDisabled = channelState?.disabled ?? false;
                      const note = channelState?.note ?? null;
                      const noteId = note ? `${idPrefix}-${event.key}-${channel}-note` : undefined;

                      return (
                        <Box
                          key={channel}
                          sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}
                        >
                          <FormControlLabel
                            // `mandatory` disables EVERY channel, not "all but
                            // one": the API resolves a mandatory event as
                            // all-or-nothing, so a per-channel opt-out here
                            // would render a choice the server ignores.
                            disabled={isSaving || event.mandatory || channelDisabled}
                            label={channelLabel(channel)}
                            control={
                              <Switch
                                checked={checked}
                                onChange={(_e, next) =>
                                  onToggle(channel, event, preferenceWriteFor(event, next))
                                }
                                // `slotProps.input`, never `<Switch aria-label>`:
                                // MUI forwards unknown props to the ROOT span,
                                // leaving the element that actually carries
                                // `role="switch"` nameless. Same rule as
                                // `admin/featureFlagColumns.tsx`.
                                //
                                // The name is per ROW as well as per channel —
                                // "Email" alone repeats on every row and gives a
                                // screen-reader user three identically-named
                                // switches with no way to tell them apart.
                                slotProps={{
                                  input: {
                                    'aria-label': `${channelLabel(channel)} notifications for ${event.label}`,
                                    'aria-describedby': [descriptionId, noteId]
                                      .filter(Boolean)
                                      .join(' '),
                                  },
                                }}
                              />
                            }
                            sx={{ mr: 0 }}
                          />
                          {note && (
                            // The per-control half of "disabled WITH an
                            // explanation". Terse here because the banner above
                            // carries the full remedy; between them the control
                            // is never silently inert.
                            <Typography
                              id={noteId}
                              variant="caption"
                              color="text.secondary"
                              sx={{ ml: 6, mt: -0.5 }}
                            >
                              {note}
                            </Typography>
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              </Box>
            );
          })}
        </Box>
      </CardContent>
    </Card>
  );
}

export default NotificationSettings;
