import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationEventDef,
} from './notification-events';
import {
  DEFAULT_NOTIFICATION_POLICY,
  policyChannels,
  type NotificationPolicy,
} from './notification-policy';

// =============================================================================
// Preference resolution (issue #125, epic #109)
// =============================================================================
//
// "Should this user get this event on this channel?" — answered in ONE place,
// so the dispatcher, and later the preferences page (#126), cannot hold two
// different opinions.
//
// PURE DATA AND PURE FUNCTIONS. No Nest, no Prisma, no I/O — same discipline
// as notification-events.ts next door, for the same reason: the resolution
// rules below are the subtle part of this issue and a test should be able to
// exercise every branch by calling a function, not by standing up DI and
// seeding a database row.
//
// -----------------------------------------------------------------------------
// THE STORED SHAPE, AND WHY IT IS CHANNEL-OUTER
// -----------------------------------------------------------------------------
//
//     user_settings.value = {
//       theme: ..., profile: ...,
//       notifications: {
//         email:   { 'user.welcome': false },
//         browser: { ... }
//       }
//     }
//
// Channel first, event second. The outer key set is CLOSED — it is exactly
// `NOTIFICATION_CHANNELS` — so the outer level of a user-writable blob is
// validated against a known enum rather than being an open string map. The
// inner level has to be an open map either way, because event keys are
// registry data that changes without a migration (see
// `NotificationEventDef.key`). Event-outer would have made BOTH levels open.
//
// It also matches the three-level fallback the issue spells out — absent
// namespace, absent channel, absent event — as three literal lookups rather
// than two lookups and a synthesized middle.
//
// -----------------------------------------------------------------------------
// THE SPARSE ABSENT-KEY CONTRACT — THE RULE THIS WHOLE FILE EXISTS FOR
// -----------------------------------------------------------------------------
//
// Only a DELIBERATE user choice is ever stored. Absent — at any of the three
// levels — means "fall back to the event's `defaultEnabled`". Three things
// depend on that, and each of them breaks loudly if this is got wrong:
//
//   1. NO MIGRATION AND NO BACKFILL. The feature ships by reading a key that
//      is not there yet for anybody. Materialising a preference row per user
//      would need a migration, a backfill, and another backfill for every
//      event added afterwards.
//
//   2. NOBODY IS MUTED ON ARRIVAL. Every existing account has no
//      `notifications` namespace at all. If absent meant "off", the framework
//      would ship silent for the entire user base and the only symptom would
//      be mail nobody receives — a failure with no error anywhere.
//
//   3. AN EVENT ADDED LATER IS OPT-OUT, NOT SILENTLY OPT-IN-ONLY. A user who
//      saved a preference in 2026 has a stored `email` map that says nothing
//      about an event declared in 2027. Absent-means-default gives them that
//      event's intended default. A stored blob written whole — the rejected
//      alternative in #125 — would give them "not in my map, therefore off".
//
// The corollary belongs to #126 and is restated here because this file is
// where the reader will look for it: RE-ENABLING WRITES A NULL DELETE, NOT
// `true`. Pinning `true` re-materialises the key and re-creates exactly the
// staleness the sparse contract avoids.
// =============================================================================

/**
 * The `user_settings.value` key these preferences live under.
 *
 * Exported so #126's write path and any test fixture address the same
 * namespace by the same constant rather than by a repeated string literal —
 * a typo in one of two literals is a preference that silently never resolves.
 */
export const NOTIFICATION_PREFERENCES_NAMESPACE = 'notifications';

/**
 * Event key -> the user's explicit choice, for one channel.
 *
 * SPARSE: a key is present only where the user deliberately chose. An absent
 * key is not `false`, and must never be normalised into one.
 */
export type ChannelPreferences = Record<string, boolean>;

/**
 * The `notifications` namespace, as stored.
 *
 * Every level optional, all the way down. This type is the sparse contract
 * expressed in the type system: there is no shape of this value that asserts
 * "the user has an opinion about every event".
 */
export type NotificationPreferences = Partial<
  Record<NotificationChannel, ChannelPreferences>
>;

/** `NOTIFICATION_CHANNELS` as a set, for O(1) membership during parsing. */
const KNOWN_CHANNELS: ReadonlySet<string> = new Set(NOTIFICATION_CHANNELS);

/**
 * Is `value` a plain object we can safely enumerate?
 *
 * Arrays and `null` both report as `'object'`, and the value being tested came
 * out of a JSONB column that a user writes through `PATCH /api/user-settings`,
 * so neither is hypothetical.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

/**
 * Read an OWN property only.
 *
 * `JSON.parse` — and therefore Prisma's JSONB deserialisation — creates a real
 * own property for a key literally named `__proto__`, and a plain
 * `obj[key]` lookup for an event key such as `constructor` or `toString`
 * would otherwise walk up to `Object.prototype` and return a FUNCTION. The
 * `typeof === 'boolean'` checks below would reject it, so this is belt and
 * braces — but the input here is user-controlled JSON, which is exactly the
 * place to wear both.
 */
function ownProperty(
  source: Record<string, unknown>,
  key: string,
): unknown {
  return Object.prototype.hasOwnProperty.call(source, key)
    ? source[key]
    : undefined;
}

/**
 * Extract the `notifications` namespace from a raw `user_settings.value`.
 *
 * TOTAL AND NEVER THROWING, by construction: every input that is not a
 * recognisable preference — no row at all, no namespace, a namespace that is a
 * string, a channel that is an array, an event whose value is `"yes"` — yields
 * an empty (or partial) result, which resolves to the registry defaults.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS NOT ONE `schema.safeParse()`
 * -----------------------------------------------------------------------------
 *
 * A single all-or-nothing parse is the reflex, and it is wrong HERE
 * specifically. This value is user-writable JSONB. One malformed entry — a
 * hand-edited row, a bad client, a crafted PATCH — would fail the whole parse,
 * and the fallback for a failed parse is "no preferences", which means EVERY
 * DELIBERATE MUTE THE USER SET IS SILENTLY UNDONE and they start receiving
 * mail they explicitly turned off. Discarding one bad key is a repair;
 * discarding the whole namespace because of it is a regression the user
 * experiences as spam.
 *
 * So this reads entry by entry and keeps what it understands. Unknown
 * channels are dropped (a preference for a channel the registry no longer
 * declares can never be delivered anyway); unknown event keys are KEPT,
 * because a key this build does not recognise may simply belong to an event
 * added in a newer deployment during a rolling upgrade, and dropping it here
 * would be a lossy read that #126's read-modify-write would then persist.
 *
 * @param settingsValue the raw `user_settings.value` JSONB, or `null`/
 *                      `undefined` when the user has no settings row at all —
 *                      the single most common case, and the one the sparse
 *                      contract is built around.
 */
export function readNotificationPreferences(
  settingsValue: unknown,
): NotificationPreferences {
  if (!isPlainObject(settingsValue)) return {};

  const namespace = ownProperty(
    settingsValue,
    NOTIFICATION_PREFERENCES_NAMESPACE,
  );
  if (!isPlainObject(namespace)) return {};

  const prefs: NotificationPreferences = {};

  for (const [channel, stored] of Object.entries(namespace)) {
    if (!KNOWN_CHANNELS.has(channel)) continue;
    if (!isPlainObject(stored)) continue;

    const events: ChannelPreferences = {};

    for (const [eventKey, choice] of Object.entries(stored)) {
      // The only value that means anything. Anything else — a string, a
      // number, `null`, a nested object — is not a choice this system ever
      // wrote, so it is not a choice this system will honour.
      if (typeof choice !== 'boolean') continue;
      events[eventKey] = choice;
    }

    // An empty map is NOT stored. `{ email: {} }` and `{}` must resolve
    // identically — both mean "no opinion expressed for email" — and keeping
    // the empty object would give two representations of one state for #126
    // and for tests to disagree about.
    if (Object.keys(events).length > 0) {
      prefs[channel as NotificationChannel] = events;
    }
  }

  return prefs;
}

/**
 * Should `event` be delivered to this user over `channel`?
 *
 * THE ORDER OF THESE CHECKS IS THE SECURITY BOUNDARY. `mandatory` is tested
 * BEFORE the stored preference is read, so there is no arrangement of stored
 * data — however it was written, including by a crafted PATCH that never went
 * near the UI — that can reach the opt-out branch for a mandatory event.
 *
 * ALL-OR-NOTHING FOR MANDATORY, exactly as `NotificationEventDef.mandatory`
 * defines it: not "at least one channel stays on", but EVERY declared channel
 * stays on. A user who dropped email and kept browser on a security alert is
 * unreachable the moment no tab is open — the alert is lost precisely when it
 * matters — so per-channel opt-out reopens the hole the flag closes.
 *
 * Note this does NOT check that `channel` is one the event declares; that is
 * {@link resolveChannels}' job, and callers should use that. Asking this
 * function about an undeclared channel answers the question it was asked
 * ("would preferences permit it?") rather than a different one.
 */
export function isChannelEnabled(
  event: NotificationEventDef,
  channel: NotificationChannel,
  preferences: NotificationPreferences,
): boolean {
  if (event.mandatory === true) return true;

  // The three-level fallback, written out rather than collapsed into a chain
  // of `??`, so each level is visible and each returns the SAME answer. The
  // outermost level — an absent `notifications` namespace — has already
  // collapsed into `preferences` being `{}` by the time it reaches here (see
  // `readNotificationPreferences`), so it falls out of the first check below.
  //
  // NOTE `?? event.defaultEnabled` ON A SINGLE LOOKUP WOULD BE WRONG: `??`
  // passes `false` through, which is correct, but it also cannot distinguish
  // a stored `false` from a stored non-boolean, and it hides which of the
  // three levels was missing from anyone reading this later.
  const channelPrefs = preferences[channel];
  if (channelPrefs === undefined) return event.defaultEnabled;

  if (!Object.prototype.hasOwnProperty.call(channelPrefs, event.key)) {
    return event.defaultEnabled;
  }

  const choice = channelPrefs[event.key];

  // Defensive: `readNotificationPreferences` guarantees booleans, but this
  // function is exported and #126 may hand it a value from elsewhere. An
  // unreadable choice is not a choice — fall back to the default rather than
  // to the coercion JavaScript would pick.
  return typeof choice === 'boolean' ? choice : event.defaultEnabled;
}

/**
 * The channels `event` should actually be delivered over for this user.
 *
 * TWO NARROWINGS, IN THIS ORDER, and the order is not arbitrary:
 *
 *   1. ADMIN POLICY (#226) — `policyChannels`, the deployment-wide gate an
 *      operator sets in system settings. It answers "is this deployment willing
 *      to send this at all?", so it comes first: a user preference about a
 *      channel the operator has switched off is not a question worth asking.
 *   2. THE USER'S PREFERENCES — `isChannelEnabled`, with the sparse absent-key
 *      contract and the `mandatory` override this file exists for.
 *
 * It is deliberately NOT filtered by which transports are implemented — that is
 * the dispatcher's business and depends on runtime wiring, whereas this file is
 * pure.
 *
 * NOR BY A PER-DISPATCH CHANNEL SUBSET (#321), AND THAT IS A DECISION, NOT AN
 * OMISSION. `NotifyOptions.channels` lets one send be restricted to a subset
 * ("this announcement goes by email only"). It is applied by
 * `NotificationsService.dispatch()`, as a set intersection against whatever
 * THIS function returned — never as a parameter here. Two reasons, either
 * sufficient:
 *
 *   * This function is SHARED WITH `GET /api/notifications/events`, which
 *     builds the per-user preferences matrix. That endpoint has no per-dispatch
 *     subset and never will; a parameter for one would be a dispatch-time
 *     concept living in the function the preferences page calls, and the next
 *     caller would eventually pass it from the wrong side.
 *   * Intersecting AFTER resolution is what makes "the subset can only ever
 *     narrow" structurally true. Were it a third filter inside this function,
 *     "it cannot resurrect a channel the policy or the user removed" would
 *     become a property of the order of statements in this body — something to
 *     re-verify on every future edit — rather than something with no code path
 *     to violate.
 *
 * See `NotifyOptions` in notification.types.ts for the full contract.
 *
 * THE POLICY FILTER IS SHARED WITH `GET /api/notifications/events`, which calls
 * `policyChannels` directly. That is the whole point of it living in one
 * function: the dispatcher and the preferences matrix cannot end up with two
 * opinions about which channels an admin has left available. See
 * notification-policy.ts, including why a MANDATORY event's channels survive
 * the policy filter (its `notifications` row is the delivery, and muting a
 * toast must not mute an audit-relevant inbox entry).
 *
 * @param policy the stored admin policy. Defaults to the permissive
 *        {@link DEFAULT_NOTIFICATION_POLICY} — the honest answer for a caller
 *        that has none, since that is also what a deployment that has never
 *        touched the setting has. Failing closed here would let an unread
 *        setting silence notifications with nothing to show for it.
 *
 * Returns a fresh array; nothing here hands out a reference into the registry.
 */
export function resolveChannels(
  event: NotificationEventDef,
  preferences: NotificationPreferences,
  policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY,
): NotificationChannel[] {
  return policyChannels(event, policy).filter((channel) =>
    isChannelEnabled(event, channel, preferences),
  );
}
