import type {
  NotificationChannel,
  NotificationEventDef,
} from './notification-events';

// =============================================================================
// Admin policy resolution (issue #226, epic #215)
// =============================================================================
//
// #225 added the setting; this file is what reads it. `system_settings.value
// .notifications` is a DEPLOYMENT-WIDE gate an operator sets:
//
//     { browserEnabled: boolean, disabledEvents: string[] }
//
// and it answers a different question from `notification-preferences.ts` next
// door. That file answers "what does THIS USER want?"; this one answers "what
// is this DEPLOYMENT willing to send at all?". Both narrow the same set — the
// event's declared channels — and they are kept in separate files because they
// have different owners, different storage and different failure modes, but
// they meet in exactly one function (`resolveChannels`) so the dispatcher can
// only ever act on one answer.
//
// PURE DATA AND PURE FUNCTIONS, same discipline as its two neighbours: no Nest,
// no Prisma, no I/O. The Nest-side reader is
// `notification-policy.service.ts`, which does nothing but fetch the stored
// value and hand it to these functions.
//
// -----------------------------------------------------------------------------
// WHAT THE TOGGLE MAY AND MAY NOT SWITCH OFF — THE INVARIANT OF THIS ISSUE
// -----------------------------------------------------------------------------
//
// The browser "channel" is TWO things, and #227's `toast` flag exists because
// they are not the same product:
//
//   1. a row in `notifications` — the durable, per-user inbox. THE DELIVERY.
//   2. an OS toast raised by the page — decoration on top of it.
//
// `browser-notification.channel.ts` says this at length in its header, and
// `security.role_changed` is `mandatory: true` precisely so a privilege change
// is never silent. So an admin who mutes browser notifications MUST NOT thereby
// mute an audit-relevant inbox entry: enforcement applies to the toast (and,
// from #230, to Web Push), never to the row.
//
// That is why {@link policyChannels} EXEMPTS MANDATORY EVENTS from the channel
// filter, exactly as `isChannelEnabled` already exempts them from the user's
// own preferences. Dropping `browser` from a mandatory event's channel list
// would stop the dispatcher calling the browser channel at all, and the row
// would never be written — which is the one outcome this issue forbids.
//
// The toast is a separate question with a separate function
// ({@link isBrowserToastAllowed}), and it has NO mandatory exemption: a
// mandatory event is guaranteed an inbox row, not an OS notification. So for
// `security.role_changed` with the kill switch off, the row is written, it is
// streamed, and it arrives carrying `toast: false`.
//
// REJECTED — enforcing in the client only. #225's admin page already renders
// the toggle; a client that merely chose not to raise a `Notification` would
// leave the policy unenforced for any other consumer of the stream, and would
// make the operator's control a suggestion. The server computes `toast`, so a
// stale client config cannot re-enable what an admin turned off.
// =============================================================================

/**
 * The deployment-wide browser-notification policy, as this module needs it.
 *
 * STRUCTURALLY COMPATIBLE WITH `SystemNotificationsValue` (see
 * `common/schemas/settings.schema.ts`) but deliberately declared here rather
 * than imported from it: that type is derived from a zod schema in the settings
 * module, and importing it would tie this pure file — and every test of it — to
 * the settings layer for the sake of two fields. The Nest-side reader passes
 * the stored value straight in; the compiler checks the shape at that seam.
 *
 * `disabledEvents` is `readonly` here because nothing in this file may reorder
 * or splice a caller's array.
 */
export interface NotificationPolicy {
  /**
   * The kill switch. `false` means no browser TOAST is offered anywhere in this
   * deployment — it does NOT mean notification rows stop being written for
   * events that must not be silent. See the header.
   */
  browserEnabled: boolean;

  /**
   * Event keys whose browser delivery an operator has suppressed individually.
   *
   * A SUPPRESSION LIST, not an allowlist: absent means "allowed", which is what
   * lets an event added in a later build be delivered without an operator
   * having to opt into it first. Keys that name no registered event are stored
   * and simply never match (#225), which is what keeps a rollback across the
   * addition of an event uneventful.
   */
  disabledEvents: readonly string[];
}

/**
 * What applies when no policy could be read.
 *
 * PERMISSIVE, AND THAT DIRECTION IS DELIBERATE. The reader
 * (`notification-policy.service.ts`) never throws; a database blip or a missing
 * `system_settings` row therefore resolves to this. Failing CLOSED would mean a
 * transient fault silences notifications — including the toast for a mandatory
 * security event — with no error visible to anybody, which is the failure mode
 * `mandatory` exists to prevent. Failing open costs at most a toast an operator
 * had asked to suppress, for as long as the fault lasts.
 *
 * Identical to `DEFAULT_SYSTEM_SETTINGS.notifications`, and identical for the
 * same reason stated there: an operator opts OUT of browser notifications,
 * never into them.
 */
export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  browserEnabled: true,
  disabledEvents: [],
};

/**
 * May this deployment raise an OS toast for `eventKey`?
 *
 * THE `toast` FLAG ON THE STREAM, IN ONE EXPRESSION, and the only place the
 * two halves of the policy are combined. `browser-notification.channel.ts`
 * calls it when publishing, so the value a tab receives is computed
 * server-side from the operator's current setting rather than from whatever
 * config the client last cached.
 *
 * NO `mandatory` EXEMPTION, unlike {@link policyChannels}. `mandatory`
 * guarantees the user is TOLD — which the durable row does, unconditionally —
 * not that their operating system pops a bubble. Exempting mandatory events
 * here would make the kill switch a lie for the one event most likely to be the
 * reason an operator reached for it.
 */
export function isBrowserToastAllowed(
  eventKey: string,
  policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY,
): boolean {
  return policy.browserEnabled && !policy.disabledEvents.includes(eventKey);
}

/**
 * An event's declared channels, narrowed by admin policy.
 *
 * -----------------------------------------------------------------------------
 * THE INTERSECTION. IT EXISTS ONCE, AND BOTH CONSUMERS CALL THIS.
 * -----------------------------------------------------------------------------
 *
 * The two consumers are the dispatcher (through `resolveChannels`, which
 * filters this further by the user's preferences) and
 * `GET /api/notifications/events` (which serves it as `channels`). They must
 * not be able to disagree: a matrix that offers a browser toggle the dispatcher
 * will never honour is a control that teaches the user something false, and the
 * reverse — a delivery over a channel the matrix never offered — is worse. One
 * function, called from both, is what makes disagreement impossible rather than
 * merely unlikely.
 *
 * A pleasant consequence: an admin-disabled browser channel simply stops being
 * offered, so #126's preferences matrix loses that column with no UI change at
 * all.
 *
 * MANDATORY EVENTS ARE EXEMPT — see this file's header. Their row IS the
 * delivery, and removing the channel would stop it being written.
 *
 * Only `browser` is subject to policy today. `email` has no deployment-wide
 * gate (#225 declared none), and `push` — widened into `NOTIFICATION_CHANNELS`
 * by #228 — gets NONE EITHER, DELIBERATELY, for now: #228 is a structural
 * widening only (the type grows; no `NOTIFICATION_EVENTS` entry declares
 * `push` in its `channels` yet, so nothing dispatches over it), and a
 * deployment-wide policy gate for it is explicitly #230's job, not this one's.
 * This mirrors how `email` shipped in #122 with no gate of its own — a channel
 * may exist here, structurally, for a while before it earns an admin-facing
 * kill switch. So the `: true` fallback below is unchanged and intentional: it
 * does not mean "every channel but browser is safe to assume ungated
 * forever", it means "no channel but browser has EARNED a gate yet". Filtering
 * by a per-channel rule rather than a hardcoded `!== 'browser'` is what keeps
 * #230's eventual addition a change to one predicate rather than a rewrite of
 * this function.
 *
 * Returns a fresh array; nothing here hands out a reference into the registry.
 */
export function policyChannels(
  event: NotificationEventDef,
  policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY,
): NotificationChannel[] {
  // A mandatory event keeps every channel it declares, whatever the policy
  // says. The toast is still suppressed for it — that is `isBrowserToastAllowed`
  // above, which has no such exemption.
  if (event.mandatory === true) return [...event.channels];

  return event.channels.filter((channel) =>
    channel === 'browser' ? isBrowserToastAllowed(event.key, policy) : true,
  );
}
