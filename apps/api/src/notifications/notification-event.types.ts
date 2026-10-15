// =============================================================================
// Notification event types (issue #121, split out by issue #460)
// =============================================================================
//
// `NotificationEventDef`, the channel list and its type, moved here verbatim
// from `notification-events.ts` so the registry (`notification-registry.ts`)
// and the base events (`notification-events.ts`) can both import them without
// importing each other. `notification-events.ts` re-exports all three, so every
// existing `from './notification-events'` keeps working.
// =============================================================================

/**
 * Every channel the framework knows about, as a value.
 *
 * The type is DERIVED from this array rather than declared alongside it, so
 * the two cannot disagree — widening this array widens the type in the same
 * edit, and every `switch` over a channel that lacks the new arm fails
 * typecheck instead of silently dropping deliveries. `'browser'` arrived this
 * way in #127; `'push'` arrives the same way in #228 (epic #215) — epic #109
 * reserved the name in this comment long before #228 filed the sweep that
 * actually widens the array, and this is that sweep. Adding the string here is
 * ONLY a capability declaration: no `NOTIFICATION_EVENTS` entry declares
 * `'push'` yet (no event has anything to send over it), no sender implements
 * `NotificationChannelSender` for it, and `notification-policy.ts` explains
 * deliberately, in its own comment, why `policyChannels` gives it no
 * deployment-wide gate yet either — that gate is #230's job. Every
 * non-exhaustive `switch`/if-chain over `NotificationChannel` in this tree was
 * swept in the same change that added `'push'` here, per #228.
 *
 * CHANNEL IS AN ENUM FROM THE START, even though #122 delivers only email.
 * Preferences are persisted per event AND per channel from day one. Storing a
 * bare boolean now and growing a channel axis later is a data migration over
 * live user preferences, which is the one shape of change this registry
 * exists to avoid.
 */
export const NOTIFICATION_CHANNELS = ['email', 'browser', 'push'] as const;

/** A delivery channel. See {@link NOTIFICATION_CHANNELS}. */
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * One notification event, fully described for every surface that dispatches,
 * renders, or documents it.
 */
export interface NotificationEventDef {
  /**
   * Stable key, persisted in user preferences and in delivery records.
   *
   * RENAMING ONE IS A MIGRATION, not a refactor: a stored preference keyed by
   * the old string becomes unreachable, and — under the epic's sparse
   * absent-key contract, where absent means enabled — a user who deliberately
   * muted an event would silently start receiving it again under its new name.
   * Add a new key and migrate the rows; never edit a key in place.
   */
  key: string;

  /** Short human label, shown as the row heading on the preferences page. */
  label: string;

  /**
   * One sentence on what actually triggers this, in the user's terms. This is
   * the only place the answer to "why did I get this?" is written down.
   */
  description: string;

  /**
   * Channels this event CAN be delivered over — a capability of the event,
   * not a statement about which transports are implemented yet.
   *
   * Deliberately per-event and meaningful: `allowlist.invitation` lists email
   * only because its recipient has no account and no open tab by definition,
   * so a browser notification is not merely unimplemented, it is impossible.
   * The dispatcher intersects this with the user's preferences and with the
   * transports actually registered, so declaring a channel before its
   * implementation lands is safe — it simply has nowhere to go until then.
   *
   * ---------------------------------------------------------------------------
   * WHAT `channels` MEANS ON THE WIRE IS NOW CAPABILITY ∩ POLICY (#226)
   * ---------------------------------------------------------------------------
   *
   * The array declared BELOW is still pure capability, and this is still the
   * only place it is stated. But `GET /api/notifications/events` no longer
   * serves it verbatim: since #226 both that endpoint and the dispatcher run it
   * through `policyChannels` (notification-policy.ts), which drops `browser`
   * when an operator has switched browser notifications off deployment-wide or
   * suppressed this event specifically in system settings.
   *
   * So an event that declares `browser` here and shows no `browser` over the
   * API is CONFIGURATION, not a bug in this registry — check
   * `system_settings.value.notifications` before concluding otherwise. The one
   * exception is a `mandatory` event, whose channels survive the policy filter
   * because its `notifications` row is the delivery and muting a toast must not
   * mute an audit-relevant inbox entry; for those the policy shows up as
   * `toast: false` on the stream instead. notification-policy.ts carries the
   * full argument.
   *
   * Must be non-empty: an event with no channels can never be delivered, which
   * is a declaration bug rather than a configuration.
   */
  channels: NotificationChannel[];

  /**
   * Default when a user has expressed no preference.
   *
   * Reads together with the epic's sparse absent-key contract: no preference
   * row is materialised until a user deliberately changes something, so this
   * is what an untouched account gets.
   */
  defaultEnabled: boolean;

  /**
   * The user may NOT opt out — on ANY channel this event declares.
   *
   * For security-relevant events where silence is itself the risk: a role
   * change, a new sign-in from an unknown device. #125 enforces this
   * SERVER-SIDE, in preference resolution, and not only in the preferences UI
   * — otherwise a crafted PATCH silences the exact alert the UI refuses to
   * hide, which is the whole attack this flag exists to close.
   *
   * ALL-OR-NOTHING, BY DESIGN: mandatory is not "at least one channel must
   * stay on". Per-channel opt-out on a mandatory event reopens the hole it
   * closes — a user who drops email and keeps browser is unreachable the
   * moment no tab is open, and the alert is lost exactly when it matters. So
   * the resolver ignores stored preferences for a mandatory event entirely and
   * every declared channel stays enabled. The UI (#126) renders the controls
   * as disabled WITH the reason rather than hiding them, per epic #109's
   * success criterion 5 — a dead toggle teaches nothing.
   *
   * Absent is the normal case and means "the user is in charge".
   *
   * Invariant: a mandatory event must also be `defaultEnabled: true`.
   * `mandatory` with `defaultEnabled: false` is self-contradictory — it
   * asserts the user cannot turn off something that is off.
   */
  mandatory?: boolean;
}
