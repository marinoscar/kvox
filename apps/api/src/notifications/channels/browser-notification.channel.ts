import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { describeThrown } from '../describe-thrown';
import type { NotificationChannel } from '../notification-events';
import { isBrowserToastAllowed } from '../notification-policy';
import { browserTemplateFor } from '../notification-registry';
import { NotificationStreamService } from '../notification-stream.service';
import type {
  ChannelDeliveryResult,
  NotificationChannelSender,
  NotificationDispatchContext,
  NotificationRecipient,
} from '../notification.types';

// =============================================================================
// BrowserNotificationChannel (issue #127, epic #109)
// =============================================================================
//
// The second `NotificationChannelSender`, and the one #125 deliberately
// refused to stub. It does two things, IN THIS ORDER, and the order is the
// design:
//
//   1. WRITE a `notifications` row — the durable, per-user inbox.
//   2. PUBLISH to whatever streams that user currently has open.
//
// Step 1 is the delivery. Step 2 is liveness. If step 2 reaches nobody —
// because no tab is open, because the tab is connected to a different replica,
// because the network dropped a second ago — the notification has still been
// delivered and the bell will show it. Reversing the order, or treating a
// zero-subscriber publish as a failure, would make the browser channel report
// failed deliveries for the ordinary case of a user who is not currently
// looking at the app.
//
// -----------------------------------------------------------------------------
// WHY THE ROW IS THE PRODUCT AND THE OS TOAST IS NOT
// -----------------------------------------------------------------------------
//
// Nothing in this file raises a native `Notification`. It cannot: the Web API
// lives in the page, and whether it fires depends on a permission this server
// has no visibility into and no way to influence. The web half of #127 may
// turn a streamed event into a toast if permission happens to be `granted`,
// and does nothing if it is not.
//
// That is exactly why the row exists. Browser notification permission is
// denied often and, once denied, effectively permanently — the app cannot
// re-prompt. A channel whose only artefact was an OS toast would silently be a
// no-op for those accounts, including for `security.role_changed`, which is
// `mandatory: true` precisely so a privilege change is never silent. The
// server's obligation ends at a durable row the user can find; the toast is a
// decoration on top of it.
//
// #226 IS THAT DISTINCTION MADE ENFORCEABLE. An operator can now switch browser
// notifications off deployment-wide, or suppress one event, from system
// settings — and what that switch reaches is the `toast` flag on the published
// event, NOT the INSERT above it. For an event the policy allows to be dropped
// entirely, the dispatcher never calls this channel at all (`resolveChannels`
// filters it out upstream); for a `mandatory` event the channel still runs, the
// row is still written, the frame is still published, and only `toast` goes
// false. See notification-policy.ts.
// =============================================================================

/**
 * What a browser notification renders to.
 *
 * The browser-channel analogue of #123's `{ subject, html, text }` email
 * contract — three fields, no HTML, because the destinations are a bell row
 * and an OS toast, both of which render plain text and neither of which will
 * ever run markup from this payload.
 */
export interface BrowserNotificationContent {
  /** One short line. The toast headline and the bell row's heading. */
  title: string;

  /** A sentence or two of detail. */
  body: string;

  /**
   * Where clicking it should go, as a ROOT-RELATIVE PATH (`/settings/roles`).
   *
   * Never an absolute URL. See {@link sanitizeLink} — this value ends up in a
   * link the user clicks, so it is a security boundary and it is validated
   * before it is stored, not before it is rendered.
   */
  link?: string;
}

/** Renders one event's payload into what the user actually sees. */
export type BrowserNotificationTemplate = (
  data: never,
) => BrowserNotificationContent;

// The platform's own renderers moved to ./base-browser-templates.ts and a domain's
// to its own folder (issue #460); a renderer is now part of its notification's
// registration (`notifications/notification-registry.ts`) and is looked up with
// `browserTemplateFor`.


/** Length caps applied before the row is written. See {@link truncate}. */
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 2_000;

@Injectable()
export class BrowserNotificationChannel implements NotificationChannelSender {
  readonly channel: NotificationChannel = 'browser';

  private readonly logger = new Logger(BrowserNotificationChannel.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: NotificationStreamService,
  ) {}

  /**
   * The "address" for this channel is the ACCOUNT ITSELF.
   *
   * There is no address to resolve: a browser notification is delivered to a
   * row in `notifications`, which is keyed by user id. So the user id is what
   * goes in `notification_deliveries.recipient` — the column that answers
   * "where did this actually go?" — and the answer for this channel is "into
   * user X's inbox".
   *
   * `null` FOR A RECIPIENT WITH NO ACCOUNT (#128's `allowlist.invitation`,
   * whose recipient is an email address that has not signed up yet). That is
   * not a limitation to fix later: `notifications.user_id` is NOT NULL because
   * an inbox with no account has nobody to open it, and the registry already
   * declares that event as email-only for the same reason. Returning `null`
   * means the dispatcher writes no delivery row and makes no attempt, rather
   * than inventing a placeholder recipient.
   */
  resolveTo(recipient: NotificationRecipient): string | null {
    return recipient.userId;
  }

  /**
   * Write the inbox row, then nudge any open tab.
   *
   * NEVER THROWS. Every branch returns a `ChannelDeliveryResult`; the one
   * genuinely failure-prone operation (the INSERT) is wrapped, and the publish
   * that follows it cannot throw by its own contract.
   *
   * @param to the user id from {@link resolveTo}, passed in rather than
   *           re-derived so the delivery row's `recipient` and the row this
   *           writes can never disagree about who was notified.
   */
  async deliver(
    context: NotificationDispatchContext,
    to: string,
  ): Promise<ChannelDeliveryResult> {
    const eventKey = context.event.key;

    const rendered = this.render(context);
    if (!rendered.ok) {
      return { success: false, error: rendered.error };
    }

    // Normalised ONCE, here, and the same values are used for the row and for
    // the stream. Applying the cap and the link check twice would be two
    // chances for a tab to be shown something the database does not hold — and
    // the stream copy is the one a native toast renders, so a divergence is a
    // user seeing text that no audit of the table can explain.
    const title = truncate(rendered.content.title, MAX_TITLE_LENGTH);
    const body = truncate(rendered.content.body, MAX_BODY_LENGTH);
    const link = sanitizeLink(rendered.content.link);

    let notification: { id: string; createdAt: Date };

    try {
      notification = await this.prisma.notification.create({
        data: { userId: to, eventKey, title, body, link },
        select: { id: true, createdAt: true },
      });
    } catch (err) {
      // The database IS the delivery for this channel. A failed INSERT is a
      // genuinely failed notification — unlike a publish that reaches no
      // subscriber — so it is reported as one and lands in
      // `notification_deliveries.error`.
      return {
        success: false,
        error: `Could not write the notification record: ${describeThrown(err)}`,
      };
    }

    // Published AFTER the row is committed, never before. A tab that receives
    // the event immediately renders or refetches from the same store;
    // publishing first opens a window in which the client is told about a
    // notification a refetch cannot find, which reads to the user as a bell
    // that flickers and loses an item.
    //
    // `publish` never throws and returns how many connections it reached. ZERO
    // IS SUCCESS: the user simply has no tab open, which is the normal state
    // of most accounts most of the time. Treating it as a failure would fill
    // `notification_deliveries` with failed rows for notifications that were
    // delivered perfectly well, and would bury the real failures that table
    // exists to surface.
    const delivered = this.stream.publish(to, {
      id: notification.id,
      eventKey,
      title,
      body,
      link,
      createdAt: notification.createdAt.toISOString(),
      // THE ADMIN POLICY, APPLIED TO THE TOAST AND ONLY TO THE TOAST (#226).
      //
      // Note where this sits: AFTER the row was written, and on an event that
      // is published regardless of its value. That is the invariant of #226 in
      // one line of code — an operator who mutes browser notifications mutes
      // the OS bubble, never the durable record. `security.role_changed` is
      // `mandatory: true` precisely so a privilege change is never silent, and
      // a policy that could suppress its inbox row would defeat the flag from
      // the admin page.
      //
      // Read from the dispatch context rather than re-queried, so this flag and
      // the channel decision that produced the row come from one snapshot of
      // the policy. Absent policy resolves to the permissive default; see
      // notification-policy.ts.
      toast: isBrowserToastAllowed(eventKey, context.policy),
      // IS WEB PUSH PART OF THIS SAME DISPATCH? (#451)
      //
      // Read from the dispatcher's final channel list — policy, preferences
      // and any per-dispatch narrowing already applied — so it describes THIS
      // dispatch, mandatory events included. It says the push channel will be
      // attempted, not that it succeeded or that this browser holds a
      // subscription; the client combines it with its own subscription state
      // to avoid a duplicate OS toast. Independent of `toast`.
      pushed: context.channels.includes('push'),
    });

    // Event key and connection count only — no title, no body, no link. The
    // rendered text is what the user was told and can name a role, an
    // administrator or a resource; application logs are shipped, indexed and
    // retained far more widely than the `notifications` table is. The content
    // has exactly one home and this is not it.
    this.logger.log(
      `Recorded '${eventKey}' for user ${to} (live to ${delivered} connection(s)).`,
    );

    // The row id is the message id. It is the one durable handle tying a
    // `notification_deliveries` row to the `notifications` row it produced,
    // which is how "the delivery record says sent — what did they actually
    // see?" gets answered.
    return { success: true, messageId: notification.id };
  }

  /**
   * Render an event's untyped payload into what the user sees.
   *
   * -----------------------------------------------------------------------------
   * ON A TEMPLATE MISS THIS FALLS BACK TO THE REGISTRY. THE EMAIL CHANNEL FAILS.
   * THE ASYMMETRY IS DELIBERATE.
   * -----------------------------------------------------------------------------
   *
   * `EmailNotificationChannel` records a failed delivery when no template is
   * registered, because a substituted email is an irreversible message sent to
   * an address outside this system: wrong copy arrives in someone's mailbox and
   * cannot be recalled, so refusing is strictly safer than improvising.
   *
   * Here the destination is a row in the user's own inbox, inside the app,
   * correctable by an edit and a redeploy. And there is already user-facing
   * copy for every event: `label` and `description` are written for the
   * preferences page (#126), reviewed as product copy, and answer "what is this
   * and why did I get it?" — generically, but truthfully.
   *
   * So the choice on a miss is between a bell that shows a slightly generic
   * line and a bell that shows NOTHING for an event the registry says the user
   * should be told about — including `security.role_changed`, which is
   * `mandatory: true` exactly so it can never be silent. Generic wins.
   *
   * It is NOT silent about it: the fallback logs a `warn` naming the event, so
   * "#128 forgot a template" is visible in the same place an operator already
   * looks, rather than hiding behind plausible-looking output.
   */
  private render(
    context: NotificationDispatchContext,
  ):
    | { ok: true; content: BrowserNotificationContent }
    | { ok: false; error: string } {
    const { event, data } = context;
    const template = browserTemplateFor(event.key);

    if (!template) {
      this.logger.warn(
        `No browser template registered for '${event.key}'; ` +
          `falling back to the registry's label and description.`,
      );
      return {
        ok: true,
        content: { title: event.label, body: event.description },
      };
    }

    try {
      // The cast is the boundary, for the reason spelled out at length on
      // `EmailNotificationChannel.render`: `notify` takes `data: unknown` by
      // design, so this is the one call site in the system where a payload's
      // shape is checked by nothing. A template reading `data.actor.email` on
      // a caller's typo throws a `TypeError` at runtime, and letting that
      // propagate would violate #125's containment rule — a bad payload would
      // take down the role change that triggered it.
      return { ok: true, content: template(data as never) };
    } catch (err) {
      return {
        ok: false,
        // The message only, never the payload: `data` is the caller's object
        // and may hold anything, and this string is persisted.
        error: `Rendering the browser notification for '${event.key}' failed: ${describeThrown(err)}`,
      };
    }
  }
}

/**
 * Characters that must never appear in a stored link.
 *
 * C0 controls, DEL, and the space. Browsers STRIP tab, newline and carriage
 * return from a URL before parsing it, so `java<TAB>script:alert(1)` is a live
 * payload that would otherwise sail past every structural test below by not
 * literally starting with `javascript:`.
 */
const FORBIDDEN_LINK_CHARS = /[\u0000-\u0020\u007F]/;

/**
 * Accept a link only if it is unambiguously internal; otherwise drop it.
 *
 * -----------------------------------------------------------------------------
 * A SECURITY CONTROL, ENFORCED ON THE WAY IN
 * -----------------------------------------------------------------------------
 *
 * The web client will put this value in an `href` or hand it to the router.
 * That makes an unchecked link two vulnerabilities at once:
 *
 *   * `https://evil.example/login` — an open redirect wearing this
 *     application's chrome and its user's trust. Phishing that arrives *inside*
 *     the product is considerably more convincing than phishing that arrives by
 *     email.
 *   * `javascript:...` (and `data:text/html,...`) — script execution in this
 *     application's own origin, with the user's session, from a string that
 *     travelled through a notification template.
 *
 * VALIDATED AT WRITE TIME, NOT AT RENDER TIME. Storing whatever a template
 * produced and sanitising on the way out means every current and future
 * consumer — the bell, the toast, an export, a mobile client — has to remember
 * to sanitise, and the first one that forgets is the vulnerability. Validating
 * here means the column only ever holds values that are already safe, so a
 * consumer that forgets is merely unlucky rather than exploitable.
 *
 * ALLOWLIST, NOT DENYLIST: a single leading `/`, no second one, no control
 * characters. Everything else is rejected, so a scheme nobody has thought of
 * yet is rejected by default rather than by having been enumerated.
 *
 *   accepted:  "/settings", "/admin/users?tab=roles", "/x#frag"
 *   rejected:  "//evil.example/x"  protocol-relative — a full URL as far as a
 *                                  browser is concerned, and the classic
 *                                  bypass of a naive "starts with /" check
 *              "https://evil/x", "javascript:alert(1)", "data:..."
 *              "settings"          relative to wherever the user happens to
 *                                  be, so it resolves differently per page
 *              "/\\evil.example"   a backslash after the slash: several
 *                                  browsers normalise `\` to `/`, which makes
 *                                  this protocol-relative in practice
 *
 * A REJECTED LINK IS DROPPED, NOT AN ERROR. The notification itself is still
 * worth delivering without its link — refusing the whole thing would let a
 * malformed link silence a mandatory security alert, trading a small usability
 * bug for the exact failure mode `mandatory` exists to prevent.
 */
export function sanitizeLink(link: string | undefined): string | null {
  if (!link) return null;

  const trimmed = link.trim();

  if (FORBIDDEN_LINK_CHARS.test(trimmed)) return null;
  if (!trimmed.startsWith('/')) return null;
  if (trimmed.startsWith('//')) return null;
  if (trimmed.startsWith('/\\')) return null;

  return trimmed;
}

/**
 * Hard cap on stored text, cutting at a character boundary and marking it.
 *
 * The column is `text` so a legitimately long message is never truncated by
 * the database, which makes an explicit cap the only remaining guard against
 * an unbounded one — a body that is a megabyte of accidentally-interpolated
 * JSON is a bell that never renders and a list page that never returns.
 *
 * The ellipsis matters: a silently truncated sentence reads as a bug in the
 * message, while a marked one reads as a message that was too long.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
