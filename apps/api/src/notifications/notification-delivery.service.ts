import { Injectable, Logger } from '@nestjs/common';
import { NotificationDeliveryStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { describeThrown } from './describe-thrown';
import type { NotificationChannel } from './notification-events';

// =============================================================================
// NotificationDeliveryService — the delivery record (issue #125, epic #109)
// =============================================================================
//
// "Did the user actually get it?" is the first question asked when something
// goes wrong, and without this table it is unanswerable: a user reporting a
// missing email cannot be distinguished from a bounce, a mute, a
// misconfiguration, or an event that never fired.
//
// -----------------------------------------------------------------------------
// TWO WRITES PER ATTEMPT: `queued` FIRST, THEN `sent`/`failed`
// -----------------------------------------------------------------------------
//
// The obvious cheaper design is one write after the attempt, carrying the
// final status. It has a hole that the extra write exists to close: the
// dispatch is FIRE-AND-FORGET AND IN-PROCESS (see notifications.service.ts).
// If the process is killed — a deploy, an OOM, a `SIGKILL` — between "we
// decided to send this" and "the provider answered", the one-write design
// leaves NO EVIDENCE AT ALL. The notification is gone and nothing anywhere
// records that it was ever attempted, which is precisely the state this table
// exists to make impossible.
//
// With the `queued` row written first, that crash leaves a row stuck at
// `queued`, and `queued` rows older than a few seconds are a legible signal
// with a query already indexed for it (`@@index([status, createdAt])` — "what
// failed recently?"). The schema's `status` default is `queued` for the same
// reason.
//
// The cost is one extra UPDATE per notification, on a row this process is
// holding the id of. That is cheap, and it is not on the caller's request path
// at all — the dispatch already returned to them.
//
// -----------------------------------------------------------------------------
// NOTHING HERE THROWS
// -----------------------------------------------------------------------------
//
// Every method swallows its own database errors and reports the failure by
// returning (`null`, or nothing) rather than by rejecting. #125's rule is that
// a notification failure never fails the action that triggered it, and
// "recording the send failed" must not become a new way to fail. A dispatcher
// that has to `try`/`catch` its own bookkeeping in three places is a
// dispatcher with three chances to miss one.
//
// The consequence is accepted deliberately: if the database is down, a
// notification can be delivered with no record of it. The alternative —
// refusing to send unless we can write the row — trades a missing audit line
// for a missing security alert, which is the worse of the two.
// =============================================================================

/**
 * Cap on stored error text.
 *
 * Provider errors arrive already redacted and capped at 2000 by
 * `BaseEmailProvider.formatError`, so this is for the errors authored on THIS
 * side — a render failure carrying a stack, a configuration message. Matching
 * that cap keeps one number in the reader's head, and stops a pathological
 * exception message from being written verbatim into a table that grows with
 * every notification sent.
 */
const MAX_ERROR_LENGTH = 2000;

/** Truncate for storage, marking that it happened. */
function capError(raw: string): string {
  return raw.length > MAX_ERROR_LENGTH
    ? `${raw.slice(0, MAX_ERROR_LENGTH)}… (truncated)`
    : raw;
}

/** What identifies a delivery attempt at the moment it is queued. */
export interface QueuedDeliveryInput {
  eventKey: string;

  /** `null` for a recipient with no account — see `NotificationRecipient`. */
  userId: string | null;

  /**
   * The destination ACTUALLY used for this attempt.
   *
   * Captured independently of the user relation, so the record stands on its
   * own with `userId` null and stays historically accurate if the user's
   * email later changes. Never re-derived from the user row at read time.
   */
  recipient: string;

  channel: NotificationChannel;
}

@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open a delivery record, before the attempt.
   *
   * @returns the row id, or `null` when the row could not be written. `null`
   *          is not a reason to abandon the send: the notification still
   *          matters more than its bookkeeping, and the dispatcher carries on
   *          with the id absent (the later `markSent`/`markFailed` become
   *          no-ops). Returning null rather than throwing is what lets the
   *          dispatcher express that in a single `if`.
   */
  async queue(input: QueuedDeliveryInput): Promise<string | null> {
    try {
      const row = await this.prisma.notificationDelivery.create({
        data: {
          eventKey: input.eventKey,
          userId: input.userId,
          recipient: input.recipient,
          channel: input.channel,
          // Explicit, though the column defaults to it. The state machine is
          // this service's own and reads better stated than inherited.
          status: NotificationDeliveryStatus.queued,
        },
        select: { id: true },
      });

      return row.id;
    } catch (err) {
      // `error`, not `warn`: unlike a refused send, a failure to write this
      // row is an infrastructure fault on OUR side, and it means the audit
      // trail has a hole in it.
      //
      // No recipient address and no payload in the message — see the logging
      // note in notifications.service.ts.
      this.logger.error(
        `Could not record a queued ${input.channel} delivery for event ` +
          `${input.eventKey}: ${describeThrown(err)}`,
      );
      return null;
    }
  }

  /**
   * Close a delivery record as delivered.
   *
   * @param deliveryId `null` when {@link queue} could not write a row — the
   *        call is then a no-op, so the dispatcher does not need a null check
   *        at every call site.
   */
  async markSent(
    deliveryId: string | null,
    messageId?: string,
  ): Promise<void> {
    await this.finalise(deliveryId, {
      status: NotificationDeliveryStatus.sent,
      // `?? null`, not omitted: a provider that reports success without an id
      // (a legitimate outcome for some transports) should leave the column
      // explicitly empty rather than carrying over whatever a retry might
      // once have written there.
      providerMessageId: messageId ?? null,
      error: null,
    });
  }

  /**
   * Close a delivery record as failed, with the reason.
   *
   * The reason is the entire value of the row for triage — "it failed" without
   * "because SES rejected the sender identity" answers nothing.
   */
  async markFailed(deliveryId: string | null, error: string): Promise<void> {
    await this.finalise(deliveryId, {
      status: NotificationDeliveryStatus.failed,
      providerMessageId: null,
      error: capError(error),
    });
  }

  /**
   * The single write path for closing a record, so `sent` and `failed` cannot
   * drift in how they treat the columns they do not set.
   */
  private async finalise(
    deliveryId: string | null,
    data: {
      status: NotificationDeliveryStatus;
      providerMessageId: string | null;
      error: string | null;
    },
  ): Promise<void> {
    if (deliveryId === null) return;

    try {
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data,
      });
    } catch (err) {
      // The send itself may well have succeeded; only the bookkeeping failed.
      // Logged so the stuck `queued` row that results has an explanation
      // somewhere, and swallowed so it cannot propagate — see the header.
      this.logger.error(
        `Could not finalise delivery ${deliveryId} as ${data.status}: ` +
          `${describeThrown(err)}`,
      );
    }
  }
}
