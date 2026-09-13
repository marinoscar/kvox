// =============================================================================
// Notification event registry (issue #121, epic #109)
// =============================================================================
//
// ONE declaration, three consumers — the same argument
// `apps/web/src/config/adminSections.tsx` and `apps/web/src/config/
// destinations.ts` each make on their own axis, applied to notifications.
//
// Epic #109's premise is that adding a notification later costs ONE registry
// entry, exactly as adding a settings page now costs one card (epic #90).
// That promise only holds while there is a single answer to "what events
// exist, which channels can carry them, and what happens when the user has
// said nothing". The consumers are:
//
//   1. the dispatcher (#125)            — what to send, over what, to whom
//   2. the preferences page (#126)      — the event x channel matrix
//   3. the docs / admin surfaces        — what this app can even tell you
//
// Without one list, the preferences page has its own and the dispatcher has
// its own, and they drift: a toggle for an event nothing dispatches, or an
// event that dispatches with no toggle. That is precisely the failure
// `destinations.ts` describes ("three gates, three answers") one axis over.
//
// -----------------------------------------------------------------------------
// WHERE THIS LIVES, AND WHY IT IS HERE RATHER THAN SHARED OR DUPLICATED
// -----------------------------------------------------------------------------
//
// The API dispatches and the web renders, so both need this. Three options
// were on the table; this file is option 1.
//
// 1. **CHOSEN — the API owns it; the web reads it over an endpoint.**
//    There is exactly one declaration in the repository, so there is nothing
//    to drift. The web does not get a copy to keep in sync; it gets the
//    server's answer. That matters more here than for `adminSections.tsx`,
//    which mirrors permission strings by convention (see CLAUDE.md's Settings
//    UI Pattern, rule 3) and accepts the mirroring cost: `mandatory` below is
//    a SECURITY gate, not a label, and a second copy of a security gate is a
//    second place for it to be wrong. The endpoint itself is deliberately NOT
//    in this issue — #125/#126 add it when they have a consumer for it, and
//    #121 ships the declaration those read.
//
// 2. **REJECTED — duplicate in `apps/web`, with a test asserting the two
//    agree.** A test converts silent drift into loud drift, which is better
//    than nothing, but it is detection rather than prevention: the copies can
//    still disagree in a working tree, in a branch, and in any build where the
//    test is not run. It also breaks the epic's headline promise directly —
//    adding a notification would cost TWO registry entries and a green test,
//    not one entry.
//
// 3. **REJECTED — a shared package both apps import.** The honest structural
//    answer, and the wrong trade today. This repo has no `packages/` workspace
//    (`package.json` declares `workspaces: ["apps/*"]`) and no cross-app import
//    anywhere. The two apps do not agree on module resolution — the API is
//    `NodeNext` compiled by Nest out of `src/`, the web is `bundler` under
//    Vite — so a shared location means a new workspace, a path alias in both
//    tsconfigs, a Vite alias, and a Nest `rootDir` change that moves `dist/`
//    and therefore edits `apps/api/Dockerfile`. That is a real and reviewable
//    architectural change, and it should be made when there is a body of
//    shared contract to justify it, not smuggled in under one 100-line file.
//    If that package ever lands, this file moves into it unchanged: nothing
//    below imports from Nest, Prisma, or anything Node-only, precisely so
//    that move stays a `git mv`.
//
//    UPDATE (epic #161): that package now exists — `packages/shared`,
//    published to the workspace as `@app/shared` — and it landed exactly as
//    the paragraph above asks: as its own filed, reviewed change rather than
//    as a side effect of a feature. Two things it says are now out of date:
//    `workspaces` reads `["apps/*", "packages/*"]`, and there IS a cross-app
//    import. The rest still holds, and **this registry deliberately did not
//    move**. `@app/shared` carries rebrandable CONSTANTS — today a single
//    display-name string that all three apps render — and it is plain
//    CommonJS with a hand-written `.d.ts` and no build step, which is what
//    lets it satisfy Nest's `rootDir`, ts-jest's transform rules and Vite at
//    once. A 100-line registry of security-relevant contract is a different
//    kind of thing on both counts, and option 1 above still beats a shared
//    copy for it: the web gets the server's answer, not a second declaration
//    that a build could skew. Moving it remains available, and remains a
//    call for whoever has a reason to make it.
//
// This file is intentionally NOT a Nest provider. It is pure data and pure
// functions, so tests, the future endpoint, and a shared package later can all
// consume it without standing up DI for a constant.
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

/**
 * The events this application can raise.
 *
 * Seeded with the three #128 wires end to end, so the framework is exercised
 * by real triggers rather than staying theoretical (epic #109, scope item 8).
 *
 * KEYS ARE NAMESPACED `<area>.<event>` so the list stays readable as it grows
 * and so `security.*` is greppable — the class of event that tends to be
 * mandatory is the class most worth auditing as a group.
 */
export const NOTIFICATION_EVENTS: NotificationEventDef[] = [
  {
    key: 'user.welcome',
    label: 'Welcome',
    description: 'Sent once, the first time you sign in to this application.',
    // Email only. A browser notification here would fire while the user is
    // looking at the very page that welcomes them — it has no reader.
    channels: ['email'],
    defaultEnabled: true,
  },
  {
    key: 'allowlist.invitation',
    label: 'Invitation to join',
    description:
      'Sent when an administrator adds your email address to the allowlist, inviting you to sign in.',
    // Email only, and NOT because #127 has not landed. The recipient has no
    // account, no session and no open tab at the moment this fires — that is
    // what being newly allowlisted means — so no in-app channel can reach
    // them. This entry is the worked example of `channels` carrying real
    // per-event information rather than being copied between rows.
    channels: ['email'],
    defaultEnabled: true,
  },
  {
    key: 'security.role_changed',
    label: 'Your roles changed',
    description:
      'Sent when an administrator changes the roles assigned to your account, which changes what you can access.',
    // Both channels: a privilege change is worth surfacing immediately to an
    // open tab AND leaving a durable record in the user's inbox.
    channels: ['email', 'browser'],
    defaultEnabled: true,
    // A privilege change the user never hears about is the failure mode this
    // whole flag exists for: an account silently gains or loses access and
    // nobody outside the admin console can tell. Not silenceable.
    mandatory: true,
  },

  // ===========================================================================
  // ADMIN BROADCASTS (#321, epic #319) — TWO KEYS, AND WHY NOT ONE
  // ===========================================================================
  //
  // The obvious alternative is a single `admin.broadcast` event whose composer
  // sets an "important" flag per send. It was rejected, and the reason is
  // structural rather than stylistic.
  //
  // `mandatory` is a STATIC REGISTRY PROPERTY, and it is not decoration: both
  // `isChannelEnabled` (notification-preferences.ts) and `policyChannels`
  // (notification-policy.ts) BRANCH ON IT, and each branch is a gate — the
  // first decides whether a stored user preference may mute this event at all,
  // the second whether an operator's deployment-wide kill switch may. Making
  // the flag dynamic would push a PER-SEND value into the gate that decides
  // whether a user may mute an event at all, which is to say: whoever composes
  // a message would be handed the switch that overrides the recipient's
  // preferences. That is the exact coupling `mandatory` exists to keep out of
  // reach of anything but this file.
  //
  // Two keys is also THE ONLY REPRESENTATION UNDER WHICH THE PREFERENCES
  // MATRIX CAN SHOW BOTH: a muteable row the user may switch off, and an
  // unmuteable one rendered disabled with its reason (#126). One key carrying a
  // per-send flag has exactly one row, and that row has to lie in one direction
  // or the other — it either offers a toggle that some sends ignore, or hides a
  // toggle that most sends would honour.
  //
  // The pair is otherwise deliberately identical: same channels, same default.
  // The ONLY difference between them is who is in charge of muting them.
  // ===========================================================================
  {
    key: 'admin.broadcast',
    label: 'Announcements',
    description:
      'Occasional messages an administrator sends to everyone using this application.',
    // All three channels: a broadcast has no shape of its own, so the medium is
    // the admin's choice per send — expressed as a NARROWING of this list (see
    // `NotifyOptions` in notification.types.ts), never as a widening of it.
    channels: ['email', 'browser', 'push'],
    defaultEnabled: true,
  },
  {
    key: 'admin.broadcast_critical',
    label: 'Important announcements',
    description:
      'Messages an administrator has marked as important — service interruptions, security notices and anything else everyone needs to see. These cannot be turned off.',
    channels: ['email', 'browser', 'push'],
    defaultEnabled: true,
    // A service interruption or a security notice nobody receives is the
    // failure this flag exists for, and it is the same argument
    // `security.role_changed` makes: silence is itself the risk.
    //
    // Note what this does NOT constrain: `mandatory` binds the RECIPIENT, not
    // the sender. An admin may still choose to send a critical broadcast over a
    // subset of channels — see `dispatch()` in notifications.service.ts, which
    // permits narrowing a mandatory event on purpose and says why.
    mandatory: true,
  },

  // ===========================================================================
  // OPERATIONAL FAILURES (#288, epic #254) — AND WHY THEIR AUDIENCE IS A
  // PERMISSION RATHER THAN A USER
  // ===========================================================================
  //
  // Every event above this block has ONE natural recipient the trigger already
  // knows: the user who signed in, the address an admin allowlisted, the
  // account whose roles changed. The four below have none. A job that ran out
  // of retries, a worker node that stopped heartbeating, a backup that failed
  // and a restore that completed are facts about the DEPLOYMENT, and the
  // question "who should hear about this?" has no user id in it.
  //
  // The answer this epic settles on is: WHOEVER CAN ACT ON IT — which is a
  // permission, not a person and not a role. `NotificationsService
  // .notifyPermissionHolders` resolves that set, and its header states the
  // full argument (in short: a role is a bundle that a fork renames or splits,
  // while the permission string is the SAME string the controller enforces, so
  // the audience for "your backup failed" is by construction the set of people
  // the API would let look at the backup).
  //
  // ⚠ THREE OF THE FOUR ARE MUTEABLE AND ONE IS NOT, and the split is the same
  // one `security.role_changed` draws. A failure is a thing an operator may
  // reasonably decide to watch elsewhere (a dashboard, an alerting stack) and
  // silence here. A COMPLETED RESTORE is not: the database this application
  // serves has just been replaced with an older copy of itself, and everybody
  // who can act on that must be told, whatever their preferences say.
  //
  // ROLL-UP IS DELIBERATELY NOT BUILT. A fork whose queue carries thousands of
  // a single job type will want digesting — see docs/specs/browser-
  // notifications.md's operational-events section — but nothing in this
  // template can produce that volume, and a roll-up nobody needs is a second
  // scheduler, a second state table and a second way for a failure to be late.
  // ===========================================================================
  {
    key: 'jobs.job_failed',
    label: 'Background job failed',
    description:
      'Sent when a background job exhausts its retry budget and is given up on. Retries and deferrals are silent; only the final give-up raises this.',
    // EMAIL ONLY, and not for want of a browser template. This is the one
    // event of the four with NO ADMIN PAGE THAT ANSWERS IT: a failed job's
    // detail lives behind a filter on the jobs list, and a toast whose click
    // target cannot show the thing it is about is worse than no toast. The
    // email carries the type, the error and the attempt count, which is the
    // whole of what a reader needs before deciding to go and look.
    channels: ['email'],
    defaultEnabled: true,
  },
  {
    key: 'nodes.node_offline',
    label: 'Worker node went offline',
    description:
      'Sent when a worker node stops heartbeating and the fleet sweep marks it offline. Capacity has dropped until it comes back.',
    // Both channels: lost capacity is worth an immediate in-app row for
    // somebody already looking at the application, and a durable mail for
    // somebody who is not.
    channels: ['email', 'browser'],
    defaultEnabled: true,
  },
  {
    key: 'db_backup.backup_failed',
    label: 'Database backup failed',
    description:
      'Sent when a database backup run fails, or stops heartbeating and is given up on. The deployment has one fewer recovery point than it thinks.',
    channels: ['email', 'browser'],
    defaultEnabled: true,
  },
  {
    key: 'db_backup.restore_completed',
    label: 'Database restored',
    description:
      'Sent when a database restore finishes and the restored copy becomes the live database. This cannot be turned off.',
    channels: ['email', 'browser'],
    defaultEnabled: true,
    // THE ONE MANDATORY EVENT OF THE FOUR, for the reason `security
    // .role_changed` is mandatory: silence is itself the risk. A restore
    // replaces the live database with the contents of an archive — every write
    // made after that archive was taken is gone, and the process that did it
    // exits immediately afterwards. An operator who is not told is an operator
    // debugging "where did today's data go?" from first principles.
    mandatory: true,
  },
];

/**
 * Key -> definition, built once at module load.
 *
 * The list above is the source of truth and stays an array because its ORDER
 * is meaningful — #126 renders the preferences matrix in it. This index exists
 * so the dispatcher's per-delivery lookups are not a linear scan of the
 * registry on every event.
 */
const EVENTS_BY_KEY: ReadonlyMap<string, NotificationEventDef> = new Map(
  NOTIFICATION_EVENTS.map((event) => [event.key, event]),
);

/**
 * The definition for `key`, or `undefined` when nothing is registered under it.
 *
 * RETURNS `undefined` RATHER THAN THROWING because the caller is frequently
 * holding a string that came from persisted data — a preference row or a
 * delivery record written before an event was removed from this list. A
 * decommissioned event must not turn a preferences page render into a 500;
 * the caller decides whether an unknown key is "skip it" or "this is a bug".
 */
export function findEvent(key: string): NotificationEventDef | undefined {
  return EVENTS_BY_KEY.get(key);
}

/**
 * Channels `key` can be delivered over, or an empty array when the key is
 * unknown.
 *
 * Empty-for-unknown is the safe direction and is deliberately not an
 * exception: every caller is about to iterate the result, and "an event that
 * no longer exists is delivered nowhere" is the correct outcome of that loop.
 * Throwing would instead take down whatever action raised the stale event —
 * violating epic #109's rule that a notification failure never fails the
 * action that triggered it.
 *
 * Returns a defensive copy: the arrays in `NOTIFICATION_EVENTS` are the
 * registry's own state, and a caller that sorted or spliced the result in
 * place would silently reconfigure delivery for every later dispatch in the
 * process.
 */
export function channelsFor(key: string): NotificationChannel[] {
  return [...(EVENTS_BY_KEY.get(key)?.channels ?? [])];
}

/**
 * Can `key` be delivered over `channel`?
 *
 * The membership test the dispatcher (#125) needs on every delivery, kept here
 * so the answer is not re-derived — and re-derived subtly differently — at
 * each call site. Unknown key is `false`, consistent with `channelsFor`.
 */
export function supportsChannel(key: string, channel: NotificationChannel): boolean {
  return EVENTS_BY_KEY.get(key)?.channels.includes(channel) ?? false;
}

/**
 * Is `key` an event the user may not opt out of?
 *
 * THE SERVER-SIDE GATE, not a UI hint. #125 calls this during preference
 * resolution, so a stored preference disabling a mandatory event is ignored no
 * matter how it got written — including by a crafted PATCH that never went
 * near the UI.
 *
 * Unknown key is `false`: an event that is not registered cannot be dispatched
 * at all, so nothing is being weakened by the default.
 */
export function isMandatory(key: string): boolean {
  return EVENTS_BY_KEY.get(key)?.mandatory === true;
}
