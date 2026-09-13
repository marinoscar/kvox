import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { WebPushError } from 'web-push';


import { PrismaService } from '../../prisma/prisma.service';
import { describeThrown } from '../describe-thrown';
import { PushConfigService } from '../push-config.service';
import type { NotificationChannel } from '../notification-events';
import type {
  BrowserNotificationContent,
  BrowserNotificationTemplate,
} from './browser-notification.channel';
import {
  EVENT_BROWSER_TEMPLATES,
  sanitizeLink,
} from './browser-notification.channel';
import type {
  ChannelDeliveryResult,
  NotificationChannelSender,
  NotificationDispatchContext,
  NotificationRecipient,
} from '../notification.types';

// =============================================================================
// PushNotificationChannel (issue #230, epic #215)
// =============================================================================
//
// The third `NotificationChannelSender`, and the first one that leaves this
// process entirely: `BrowserNotificationChannel` writes a row and nudges a
// socket THIS SERVER holds open; this one hands an encrypted payload to a
// push service (FCM, Mozilla's autopush, ...) that is under no obligation to
// deliver it promptly, or at all, or to a tab that is even open. That is also
// the whole point of it existing — it is the one channel that can reach a
// user with the app closed, which #226's "browser toast" plainly cannot.
//
// -----------------------------------------------------------------------------
// WHAT ID DOES A PUSH DELIVERY REFERENCE? PUSH WRITES ITS OWN `Notification` ROW.
// -----------------------------------------------------------------------------
//
// `NotificationDispatchContext` carries no id produced by a sibling channel —
// by the interface's own design (`notification.types.ts`), nothing threads
// state from one channel's `deliver()` call into the next. Channels are
// dispatched sequentially in `NotificationsService.dispatch()`'s `for` loop,
// but the same `context` object is simply reused across them; it never
// mutates and it never accumulates a "the browser channel already wrote row
// X" fact for this channel to read.
//
// Depending on the browser channel having run first — and successfully —
// within the same dispatch would therefore be an undocumented, fragile
// coupling between two channels that are supposed to be independently
// pluggable (add one, remove one, reorder the array in
// `notifications.module.ts`, and nothing else should care). Today that
// coupling would not even have a payoff: no `NOTIFICATION_EVENTS` entry
// declares `push` in its `channels` array yet (this channel ships
// correctly-unreachable until a future event opts in, exactly as `browser`
// did in #122 before #127/#128 gave it real registrations), so there is no
// event today where browser and push would BOTH fire for the same
// notification — the id-collision case a shared id would exist to prevent
// does not exist yet either.
//
// So: `deliver` creates its own `Notification` row via
// `this.prisma.notification.create(...)` — the exact same call shape
// `BrowserNotificationChannel` makes — and uses THAT row's `id` in the push
// payload. This makes push self-sufficient regardless of whether browser is
// also registered for a future event, and it gives a push recipient a
// durable, findable bell entry even if they never had a tab open, which is
// arguably the more correct default for a push-first event.
//
// ACCEPTED TRADEOFF: if a future event declares BOTH `browser` and `push`,
// this produces TWO separate `Notification` rows for one logical event — one
// written by each channel, both real, neither referencing the other. That is
// deliberate for now. The real fix if that combination is ever wanted is
// threading a shared id down from the dispatcher itself, not channels
// guessing at, or depending on the order of, each other's side effects.
//
// -----------------------------------------------------------------------------
// WHY THIS CHANNEL READS/WRITES `push_subscriptions` DIRECTLY, NOT THROUGH
// `PushSubscriptionService`
// -----------------------------------------------------------------------------
//
// See `notifications.module.ts`: that service stays scoped to the
// subscribe/unsubscribe endpoints, which is the only place a *user* mutates
// their own subscription rows. This channel's relationship to the table is
// different in kind — it reads every subscription for a recipient to fan a
// delivery out, and it prunes or ages rows based on what a push SERVICE says
// about them, never on behalf of a signed-in user's own request. Folding that
// into `PushSubscriptionService` would mix "acting for the current user" with
// "acting for the dispatcher", which is exactly the kind of blurred
// responsibility `NotificationStreamService`/`NotificationStoreService` avoid
// by being separately scoped, single-purpose providers.
// =============================================================================

/** Length caps applied before a push payload is built. See {@link truncate}. */
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 2_000;

/**
 * How many consecutive delivery failures (429/5xx, or anything else
 * unexpected) an endpoint tolerates before its subscription row is deleted.
 *
 * 5 tolerates a handful of transient failures — a push service having a bad
 * minute — without endlessly accumulating rows for an endpoint that is
 * actually gone for good. A 404/410 is unambiguous ("this endpoint no longer
 * exists") and prunes immediately regardless of this counter; this threshold
 * only governs the ambiguous case where the push service is complaining but
 * has not yet told us the subscription is dead.
 */
const MAX_PUSH_FAILURE_COUNT = 5;

/**
 * The five fields a push payload carries, and NOTHING ELSE.
 *
 * Deliberately the durable row's own columns, echoed back rather than the
 * caller's original event payload: `data` (see
 * `NotificationDispatchContext.data`) can be arbitrary shape and arbitrary
 * size, and a Web Push payload has a hard ~4KB ceiling enforced by the push
 * service, not by this app. Carrying only what is already sitting in a
 * `notifications` row keeps every payload comfortably under that ceiling
 * without this channel having to reason about the size of somebody else's
 * object, and it means the service worker never receives anything it could
 * not also fetch straight out of the notification centre.
 */
interface PushPayload {
  id: string;
  eventKey: string;
  title: string;
  body: string;
  link: string | null;
}

@Injectable()
export class PushNotificationChannel implements NotificationChannelSender {
  readonly channel: NotificationChannel = 'push';

  private readonly logger = new Logger(PushNotificationChannel.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushConfig: PushConfigService,
  ) {}

  /**
   * The "address" for this channel is the ACCOUNT ITSELF, same as
   * `BrowserNotificationChannel.resolveTo` and for the identical reason: a
   * push delivery fans out to every subscription ROW this user has, keyed by
   * `userId`, so there is no single "address" to resolve up front — that
   * happens inside `deliver`, once the subscriptions are actually loaded.
   *
   * `null` for a recipient with no account (`allowlist.invitation`'s
   * recipient), which by construction can never have a `push_subscriptions`
   * row either: subscribing requires a signed-in browser calling the
   * subscribe endpoint, which requires an account.
   */
  resolveTo(recipient: NotificationRecipient): string | null {
    return recipient.userId;
  }

  /**
   * Render, write the inbox row, then fan the encrypted payload out to every
   * subscription this user has registered.
   *
   * NEVER THROWS — see the interface's own note on this being a guarantee
   * that must survive a future implementer, not a promise this
   * implementation happens to keep today. Every branch below returns a
   * `ChannelDeliveryResult`.
   *
   * @param to the user id from {@link resolveTo}.
   */
  async deliver(
    context: NotificationDispatchContext,
    to: string,
  ): Promise<ChannelDeliveryResult> {
    try {
      return await this.deliverInner(context, to);
    } catch (err) {
      // A catch-all around the whole method, matching the discipline every
      // other channel applies: `NotificationsService` does not trust
      // `deliver` not to throw either, but #125's guarantee — `notify` never
      // throws to ITS caller — must hold even if a future edit here adds a
      // code path this file's own author forgot to wrap.
      return {
        success: false,
        error: `Push delivery failed unexpectedly: ${describeThrown(err)}`,
      };
    }
  }

  private async deliverInner(
    context: NotificationDispatchContext,
    to: string,
  ): Promise<ChannelDeliveryResult> {
    const eventKey = context.event.key;

    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId: to },
    });

    if (subscriptions.length === 0) {
      // Not an error in the sense of something going wrong — this is simply a
      // user who has never granted push permission, or has revoked it on
      // every device. Reported as a failed delivery anyway (rather than
      // `resolveTo` returning `null` and skipping the row entirely) because,
      // unlike the no-account case, this IS a user this event applies to; an
      // operator triaging "why did this user never get pushed?" should find
      // an explanatory row, not silence.
      return {
        success: false,
        error: 'No push subscriptions for this user',
      };
    }

    const rendered = this.render(context);
    if (!rendered.ok) {
      return { success: false, error: rendered.error };
    }

    // Normalised once, exactly as `BrowserNotificationChannel.deliver` does,
    // and for the same reason: the row and the wire payload must be built
    // from identical values or an audit of the table cannot explain what a
    // device actually showed.
    const title = truncate(rendered.content.title, MAX_TITLE_LENGTH);
    const body = truncate(rendered.content.body, MAX_BODY_LENGTH);
    const link = sanitizeLink(rendered.content.link);

    let notification: { id: string };

    try {
      notification = await this.prisma.notification.create({
        data: { userId: to, eventKey, title, body, link },
        select: { id: true },
      });
    } catch (err) {
      return {
        success: false,
        error: `Could not write the notification record: ${describeThrown(err)}`,
      };
    }

    const payload: PushPayload = {
      id: notification.id,
      eventKey,
      title,
      body,
      link,
    };
    const serializedPayload = JSON.stringify(payload);

    // ONE call, ONE source of truth for "what VAPID key pair is active right
    // now" — see `PushConfigService.resolveActiveVapidConfig`'s own header
    // for the full env/DB precedence (#355). This channel used to read three
    // `ConfigService` keys directly, which only ever reflected the deploy-time
    // env vars; now the same call also picks up an admin-configured, runtime
    // key pair with no restart.
    //
    // Registration (see notifications.module.ts) means this channel is always
    // reachable now, regardless of configuration — so `null` here is the
    // ORDINARY "this deployment has not turned Web Push on" case, not a
    // programming error, and it is reported as an honest, admin-actionable
    // failed delivery rather than a `sendNotification` call throwing a
    // TypeError three lines further down for a reason nobody logged.
    const active = await this.pushConfig.resolveActiveVapidConfig();

    if (!active) {
      return {
        success: false,
        error: 'Web Push is not configured or is disabled on this deployment',
      };
    }

    const vapidDetails = {
      subject: active.subject,
      publicKey: active.publicKey,
      privateKey: active.privateKey,
    };

    // `Promise.allSettled`, NEVER `Promise.all` — one dead endpoint among
    // several must not stop the others from being tried, and must not turn
    // "3 of 4 devices got this" into a thrown exception this channel is
    // supposed to have already contained.
    const results = await Promise.allSettled(
      subscriptions.map((subscription) =>
        webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          serializedPayload,
          { vapidDetails },
        ),
      ),
    );

    let successCount = 0;
    let prunedCount = 0;
    let failedCount = 0;

    await Promise.all(
      results.map(async (result, index) => {
        const subscription = subscriptions[index];

        if (result.status === 'fulfilled') {
          successCount++;
          await this.prisma.pushSubscription
            .update({
              where: { id: subscription.id },
              data: { lastSuccessAt: new Date(), failureCount: 0 },
            })
            // A subscription that was deleted by a CONCURRENT delivery (or by
            // the user unsubscribing) between the `findMany` above and this
            // update is not a bug to surface — the send already succeeded,
            // there is simply no row left to credit it to.
            .catch((err) => {
              this.logger.warn(
                `Could not record a successful push to subscription ${subscription.id}: ${describeThrown(err)}`,
              );
            });
          return;
        }

        const err = result.reason;

        // 404/410: the push service is telling us, unambiguously, that this
        // endpoint no longer exists (browser uninstalled, profile wiped,
        // permission revoked at the OS level). Nothing short of the user
        // re-subscribing can ever make this endpoint valid again, so the row
        // is deleted outright rather than run through the failure counter.
        if (
          err instanceof WebPushError &&
          (err.statusCode === 404 || err.statusCode === 410)
        ) {
          prunedCount++;
          await this.prisma.pushSubscription
            .delete({ where: { id: subscription.id } })
            .catch((deleteErr) => {
              this.logger.warn(
                `Could not prune dead push subscription ${subscription.id}: ${describeThrown(deleteErr)}`,
              );
            });
          return;
        }

        // Everything else — a `WebPushError` with a 429/5xx status, and any
        // other rejection this library or the network can produce (a socket
        // timeout, DNS failure, ...) — is treated as the SAME "the endpoint
        // might still be good, but this attempt did not land" case. Failing
        // open here (counting toward the threshold rather than deleting
        // immediately, or than silently doing nothing) is the safer default:
        // a push service having a bad minute must not cost a user their
        // subscription, but a genuinely dead endpoint that never happens to
        // return 404/410 must not accumulate forever either.
        failedCount++;
        const updated = await this.prisma.pushSubscription
          .update({
            where: { id: subscription.id },
            data: { failureCount: { increment: 1 } },
            select: { failureCount: true },
          })
          .catch((updateErr) => {
            this.logger.warn(
              `Could not record a push failure for subscription ${subscription.id}: ${describeThrown(updateErr)}`,
            );
            return null;
          });

        if (updated && updated.failureCount >= MAX_PUSH_FAILURE_COUNT) {
          prunedCount++;
          await this.prisma.pushSubscription
            .delete({ where: { id: subscription.id } })
            .catch((deleteErr) => {
              this.logger.warn(
                `Could not prune exhausted push subscription ${subscription.id}: ${describeThrown(deleteErr)}`,
              );
            });
        }
      }),
    );

    this.logger.log(
      `Push '${eventKey}' for user ${to}: ${successCount} sent, ` +
        `${failedCount} failed, ${prunedCount} subscription(s) pruned ` +
        `(of ${subscriptions.length}).`,
    );

    // Success = AT LEAST ONE endpoint accepted the push. A user with three
    // devices, two of which are offline, still received the notification —
    // failing the whole delivery because one endpoint bounced would record a
    // false negative for a delivery that genuinely reached them.
    if (successCount > 0) {
      return { success: true, messageId: notification.id };
    }

    // No secrets, no payload text — only counts, matching
    // `ChannelDeliveryResult.error`'s contract.
    return {
      success: false,
      error: `Push failed for all ${subscriptions.length} subscription(s) (${prunedCount} pruned).`,
    };
  }

  /**
   * Render an event's untyped payload into what the device shows.
   *
   * A DELIBERATE DUPLICATE of `BrowserNotificationChannel.render`, not an
   * extraction into a shared helper — see that file's `formatRoles` comment,
   * which rejects sharing formatting logic across channel surfaces for the
   * same reason this method is copied rather than imported: the two channels
   * are independently pluggable, and a "shared render" would be the first
   * thread tying their behaviour together, the same coupling this file's own
   * header comment argues against for the *id* they each mint. What genuinely
   * IS shared — `EVENT_BROWSER_TEMPLATES` itself, and `sanitizeLink` — is
   * imported, because a divergence there would be a security or content bug,
   * not a legitimate per-channel choice.
   *
   * Falls back to the registry's `label`/`description` on a template miss,
   * identical to the browser channel's own fallback rule: there is already
   * user-facing copy for every event, and a push notification with no body at
   * all is a worse outcome than one with slightly generic copy.
   */
  private render(
    context: NotificationDispatchContext,
  ):
    | { ok: true; content: BrowserNotificationContent }
    | { ok: false; error: string } {
    const { event, data } = context;
    const template: BrowserNotificationTemplate | undefined =
      EVENT_BROWSER_TEMPLATES[event.key];

    if (!template) {
      this.logger.warn(
        `No browser template registered for '${event.key}'; ` +
          `falling back to the registry's label and description for push.`,
      );
      return {
        ok: true,
        content: { title: event.label, body: event.description },
      };
    }

    try {
      return { ok: true, content: template(data as never) };
    } catch (err) {
      return {
        ok: false,
        error: `Rendering the push notification for '${event.key}' failed: ${describeThrown(err)}`,
      };
    }
  }
}

/**
 * Hard cap on stored/sent text, cutting at a character boundary and marking
 * it. A second, smaller copy of `browser-notification.channel.ts`'s helper of
 * the same name and behaviour — not exported from there, so redeclared here
 * rather than reached across a module boundary for a five-line pure function.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
