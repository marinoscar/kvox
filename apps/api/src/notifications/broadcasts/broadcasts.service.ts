// =============================================================================
// Broadcasts service — everything /api/admin/broadcasts decides (issue #324)
// =============================================================================
//
// The controller binds, documents and authorizes; every decision about what a
// request MEANS is here, and every decision about how a broadcast is DELIVERED
// is one layer further out, in the two job handlers. This service never sends
// anything to more than one person: it writes a row and enqueues a job, and
// `broadcast-start.handler.ts` takes it from there.
//
// The one exception is `sendTest`, which dispatches directly — to the caller,
// once, storing nothing. That is not a fan-out; it is the composer's preview,
// and it deliberately goes through the REAL channels rather than rendering
// HTML into a response, because the rendering an admin most needs to check is
// the one that actually gets sent.
//
// -----------------------------------------------------------------------------
// THE THREE RULES THIS FILE EXISTS TO KEEP
// -----------------------------------------------------------------------------
//
//   1. THE EVENT KEY IS DERIVED, NEVER ACCEPTED. `critical` is a boolean on
//      the DTO; the key is computed here. A client that could name the key
//      could name `admin.broadcast_critical` (unmuteable by every recipient)
//      or any other event in the registry, borrowing its template.
//   2. THE JOB IS ENQUEUED AFTER THE WRITE HAS COMMITTED AND OUTSIDE ANY
//      `$transaction`. Same rule CLAUDE.md states for `notify()`, and for the
//      same reason: a job enqueued inside a transaction can be claimed by a
//      worker before that transaction commits, and the handler then reads a
//      row that does not exist yet.
//   3. CANCEL IS A CONDITIONAL WRITE, NOT A READ-THEN-WRITE. The status goes
//      in the `WHERE`, so it races the start handler's compare-and-swap in the
//      DATABASE, where exactly one of them can win.
// =============================================================================

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationBroadcast, Prisma } from '@prisma/client';

import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { BroadcastEmailData } from '../../email/templates/broadcast.email';
import { describeThrown } from '../describe-thrown';
import type { NotificationChannel } from '../notification-events';
import { NotificationsService } from '../notifications.service';
import { BROADCAST_SUBJECT_TYPE, audienceWhere } from './broadcast-audience';
import { BROADCAST_START_TYPE } from './handlers/broadcast-start.handler';
import type { BroadcastListQuery } from './dto/broadcast-list-query.dto';
import type { CreateBroadcastInput } from './dto/create-broadcast.dto';

/**
 * The two registry keys a broadcast can be raised under.
 *
 * Constants rather than inline literals because the same strings are used to
 * derive the key on the way in AND to window the delivery breakdown on the way
 * out; two spellings of one of them is a detail view that silently reports
 * zero deliveries.
 */
export const BROADCAST_EVENT_KEY = 'admin.broadcast';
export const BROADCAST_CRITICAL_EVENT_KEY = 'admin.broadcast_critical';

/** `audit_events.target_type` for every row this service writes. */
const AUDIT_TARGET_TYPE = 'notification_broadcast';

/** The statuses a cancel may claim. Anything else is terminal — see `cancel`. */
const CANCELABLE_STATUSES = ['scheduled', 'sending'] as const;

/** What `list` returns: the flat pagination shape every list in this API uses. */
export interface BroadcastListResult {
  items: NotificationBroadcast[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** One `(channel, status)` cell of the approximate delivery breakdown. */
export interface BroadcastDeliveryCount {
  channel: string;
  status: string;
  count: number;
}

export interface BroadcastDetail extends NotificationBroadcast {
  approximateDeliveryAttempts: BroadcastDeliveryCount[];
}

export interface BroadcastCreateResult {
  broadcast: NotificationBroadcast;
  warnings: string[];
}

@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly systemSettings: SystemSettingsService,
    private readonly config: ConfigService
  ) {}

  // ==========================================================================
  // Reads
  // ==========================================================================

  /**
   * How many users a broadcast created right now would target.
   *
   * COUNTED WITH `audienceWhere()` — the same exported predicate the start
   * handler counts with and the chunk handler pages with. That is the whole
   * reason this is one line: a second hand-written `where` here would let the
   * composer promise "1,284 people" and the send report a different number,
   * which is exactly the class of bug `broadcast-audience.ts` exists to
   * prevent.
   *
   * `new Date()` as the cutoff, so this is "as of now". The real audience is
   * frozen when the fan-out starts, so for a SCHEDULED broadcast this is an
   * estimate — an honest one, and the only one available at compose time.
   */
  async audience(): Promise<{ activeUsers: number }> {
    const activeUsers = await this.prisma.user.count({
      where: audienceWhere(new Date()),
    });

    return { activeUsers };
  }

  /** Newest first, paginated, optionally filtered by status. */
  async list(query: BroadcastListQuery): Promise<BroadcastListResult> {
    const { page, pageSize, status } = query;
    const where: Prisma.NotificationBroadcastWhereInput = status ? { status } : {};

    const [items, total] = await Promise.all([
      this.prisma.notificationBroadcast.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notificationBroadcast.count({ where }),
    ]);

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  /** One broadcast, plus the approximate delivery breakdown. */
  async get(id: string): Promise<BroadcastDetail> {
    const broadcast = await this.requireBroadcast(id);

    return {
      ...broadcast,
      approximateDeliveryAttempts: await this.approximateDeliveryAttempts(broadcast),
    };
  }

  // ==========================================================================
  // Writes
  // ==========================================================================

  /**
   * Records a broadcast and queues its fan-out.
   *
   * TWO STATEMENTS, IN THIS ORDER, WITH NO TRANSACTION AROUND THEM — and the
   * order is the point. The row is written first and committed; only then is
   * the start job enqueued. A job enqueued inside a `$transaction` can be
   * claimed by a worker in another process before that transaction commits,
   * and the handler then finds no broadcast and treats it as a deleted one:
   * a silently unsent announcement, with a `succeeded` job row saying
   * otherwise.
   *
   * The failure this ordering ADMITS is the harmless one: if the process dies
   * between the two statements, the result is a `scheduled` broadcast with no
   * job. It is visible in the admin list, nothing was sent to anybody, and it
   * can be deleted and recomposed. The other ordering's failure is invisible.
   */
  async create(dto: CreateBroadcastInput, adminUserId: string): Promise<BroadcastCreateResult> {
    // DERIVED, NEVER ACCEPTED FROM THE CLIENT. See the file header, rule 1.
    const eventKey = dto.critical ? BROADCAST_CRITICAL_EVENT_KEY : BROADCAST_EVENT_KEY;

    const broadcast = await this.prisma.notificationBroadcast.create({
      data: {
        title: dto.title,
        body: dto.body,
        link: dto.link ?? null,
        ctaLabel: dto.ctaLabel ?? null,
        eventKey,
        channels: dto.channels,
        status: 'scheduled',
        scheduledFor: dto.scheduledFor ?? null,
        createdById: adminUserId,
      },
    });

    const job = await this.jobs.enqueue({
      type: BROADCAST_START_TYPE,
      // `backfill`, reused rather than extended, exactly as the start handler
      // does when it enqueues the first chunk: `JobReason` is a Prisma enum,
      // so a `broadcast` member would be a migration plus web-side churn for a
      // display string. The friendly label in `job-type-labels.ts` is what
      // carries the meaning to a human reading the dashboard.
      reason: 'backfill',
      subjectType: BROADCAST_SUBJECT_TYPE,
      subjectId: broadcast.id,
      // `undefined`, not `null`: the queue reads `undefined` as "let the column
      // default apply", which for `scheduled_for` means eligible immediately.
      // An absent schedule and a NULL one are the same request.
      scheduledFor: dto.scheduledFor ?? undefined,
      // Dedup is left ON here (the queue's default). While a start job for
      // this broadcast is pending or running, a second enqueue for the same
      // subject returns the row already in flight — so a double-clicked "Send
      // now" cannot produce two fan-outs at the job layer at all. The start
      // handler's compare-and-swap is what makes the remaining cases safe.
    });

    await this.createAuditEvent(adminUserId, 'notification_broadcast.created', broadcast.id, {
      eventKey,
      channels: dto.channels,
      scheduledFor: dto.scheduledFor?.toISOString() ?? null,
      recipientsTargeted: broadcast.recipientsTargeted,
    });

    this.logger.log(
      `Broadcast ${broadcast.id} (${eventKey}) created by ${adminUserId} over ` +
        `[${dto.channels.join(', ')}]; start job ${job.id} queued for ` +
        `${dto.scheduledFor?.toISOString() ?? 'immediate send'}`
    );

    return { broadcast, warnings: await this.warningsFor(dto) };
  }

  /**
   * Stops a scheduled or in-flight broadcast.
   *
   * A CONDITIONAL WRITE. The status is in the `WHERE`, not in an `if` above
   * the write, so this statement and the start handler's claim
   * (`updateMany({ where: { id, status: 'scheduled' } })`) race inside the
   * database where exactly one of them can win. A read-then-write here would
   * have a real window in which a cancel is issued, the start handler claims
   * the broadcast, and the cancel then writes `canceled` over a `sending` row
   * whose chunks are already walking the audience.
   *
   * `count === 0` IS AMBIGUOUS BY ITSELF — no such row, or a row in a status
   * that cannot be cancelled — so the two are distinguished with a follow-up
   * read: 404 for the first, 409 for the second. Answering 409 for a missing
   * row would tell an operator the broadcast exists and is merely in the wrong
   * state.
   *
   * PENDING JOB ROWS ARE DELIBERATELY LEFT ALONE. Deleting the queued start or
   * chunk job would race with a worker claiming it; the handlers' own status
   * guards are the durable gate (both re-read the broadcast and no-op when it
   * is not in the status they require), and the `jobs` rows are audit history
   * of what the fan-out actually did.
   */
  async cancel(id: string, adminUserId: string): Promise<NotificationBroadcast> {
    const canceled = await this.prisma.notificationBroadcast.updateMany({
      where: { id, status: { in: [...CANCELABLE_STATUSES] } },
      data: { status: 'canceled', canceledAt: new Date() },
    });

    if (canceled.count === 0) {
      const existing = await this.requireBroadcast(id);

      throw new ConflictException(
        `Broadcast ${id} is '${existing.status}' and can no longer be cancelled ` +
          `(only ${CANCELABLE_STATUSES.join(' or ')} broadcasts can)`
      );
    }

    const broadcast = await this.requireBroadcast(id);

    await this.createAuditEvent(adminUserId, 'notification_broadcast.canceled', id, {
      eventKey: broadcast.eventKey,
      channels: broadcast.channels,
      scheduledFor: broadcast.scheduledFor?.toISOString() ?? null,
      recipientsTargeted: broadcast.recipientsTargeted,
    });

    this.logger.log(
      `Broadcast ${id} cancelled by ${adminUserId} after ` +
        `${broadcast.recipientsDispatched} dispatch(es)`
    );

    return broadcast;
  }

  /**
   * Removes a broadcast's record.
   *
   * REFUSED WHILE `sending`, and that is the only refusal. Deleting a row
   * mid-fan-out would not stop the chunk chain — the running chunk would
   * finish, its cursor update would fail against a row that no longer exists,
   * and the fan-out would either die with an error nobody can attribute or
   * keep enqueuing successors for a broadcast that has no record. Cancel
   * first; the handlers stop at the next status check.
   *
   * A `canceled` row is deletable, and a `sent` one is too. A pulled or
   * completed announcement is exactly what an operator may want to look up
   * later, which is why cancel does NOT delete — but keeping it is their
   * decision to reverse, not ours to enforce.
   */
  async remove(id: string, adminUserId: string): Promise<void> {
    const broadcast = await this.requireBroadcast(id);

    if (broadcast.status === 'sending') {
      throw new ConflictException(
        `Broadcast ${id} is currently sending and cannot be deleted; cancel it first`
      );
    }

    await this.prisma.notificationBroadcast.delete({ where: { id } });

    await this.createAuditEvent(adminUserId, 'notification_broadcast.deleted', id, {
      eventKey: broadcast.eventKey,
      channels: broadcast.channels,
      scheduledFor: broadcast.scheduledFor?.toISOString() ?? null,
      recipientsTargeted: broadcast.recipientsTargeted,
    });

    this.logger.log(`Broadcast ${id} deleted by ${adminUserId} (was '${broadcast.status}')`);
  }

  /**
   * Sends the composition to the CALLER, once. No row, no job, no fan-out.
   *
   * THE RECIPIENT IS NOT A PARAMETER. It is the authenticated caller, always.
   * An endpoint that took an address would be an authenticated spam relay:
   * arbitrary admin-composed content, delivered over real channels, to anyone.
   * "Send it to me so I can check it" is the entire requirement, and it needs
   * no address.
   *
   * `notifyNow` rather than `notify` so the request does not return before the
   * dispatch has been attempted — an admin pressing "send test" and seeing a
   * 200 while the render is still pending would learn nothing. Note that
   * `notifyNow` still never rejects: a channel failure is a
   * `notification_deliveries` row, so a 200 here means "dispatched", not
   * "delivered". The delivery log is where the outcome lives.
   *
   * The payload is built with `buildPayload`, the same function `create`'s
   * eventual fan-out would use, because a test send that composed its payload
   * differently would be testing a composition that never ships.
   */
  async sendTest(
    dto: CreateBroadcastInput,
    adminUserId: string
  ): Promise<{ eventKey: string; channels: NotificationChannel[]; sentToUserId: string }> {
    const eventKey = dto.critical ? BROADCAST_CRITICAL_EVENT_KEY : BROADCAST_EVENT_KEY;
    const channels = [...dto.channels];

    await this.notifications.notifyNow(eventKey, adminUserId, this.buildPayload(dto, eventKey), {
      channels,
    });

    await this.createAuditEvent(adminUserId, 'notification_broadcast.test_sent', adminUserId, {
      eventKey,
      channels,
      // A test send has no schedule and no audience. Both keys are present and
      // null rather than absent, so every row this service writes has the same
      // `meta` shape and a query over the audit log does not have to branch.
      scheduledFor: null,
      recipientsTargeted: null,
    });

    this.logger.log(
      `Test broadcast (${eventKey}) dispatched to ${adminUserId} over [${channels.join(', ')}]`
    );

    return { eventKey, channels, sentToUserId: adminUserId };
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /** The row, or a 404. One place, so no route invents its own message. */
  private async requireBroadcast(id: string): Promise<NotificationBroadcast> {
    const broadcast = await this.prisma.notificationBroadcast.findUnique({ where: { id } });

    if (!broadcast) {
      throw new NotFoundException(`Broadcast ${id} not found`);
    }

    return broadcast;
  }

  /**
   * The delivery breakdown for the detail view — APPROXIMATE, by construction.
   *
   * `notification_deliveries` carries no broadcast id and #319 decided it will
   * not gain one (a migration on the fastest-growing table in the schema, plus
   * threading an id through a dispatcher that is deliberately ignorant of its
   * callers, to make one screen's number exact). So attribution is by EVENT
   * KEY AND TIME WINDOW: rows for this broadcast's `eventKey` created between
   * `startedAt` and `finishedAt ?? now`.
   *
   * WHAT THAT OVER-COUNTS: a second broadcast raised under the same key while
   * this one was still sending. Nothing here can separate them, which is why
   * the field is called `approximateDeliveryAttempts` and why the UI labels it
   * "delivery attempts during this broadcast" rather than "deliveries".
   *
   * EMPTY BEFORE THE FAN-OUT STARTS: with no `startedAt` there is no window,
   * and an unbounded query over this table is the one thing this method must
   * never issue.
   */
  private async approximateDeliveryAttempts(
    broadcast: NotificationBroadcast
  ): Promise<BroadcastDeliveryCount[]> {
    if (!broadcast.startedAt) {
      return [];
    }

    const grouped = await this.prisma.notificationDelivery.groupBy({
      by: ['channel', 'status'],
      where: {
        eventKey: broadcast.eventKey,
        createdAt: { gte: broadcast.startedAt, lte: broadcast.finishedAt ?? new Date() },
      },
      _count: { _all: true },
    });

    return grouped.map((row) => ({
      channel: row.channel,
      status: row.status,
      count: row._count._all,
    }));
  }

  /**
   * Non-fatal problems worth telling the admin about.
   *
   * A WARNING, NOT A 400, and the direction matters. The deployment-wide
   * browser kill switch is an operational setting that anybody with
   * `system_settings:write` can flip at any moment, including between compose
   * and send. Refusing a create because it is currently off would block the
   * legitimate workflow of scheduling an announcement for after it is flipped
   * back — and would make a broadcast's validity depend on a value that can
   * change while the request is in flight.
   *
   * Note precisely what the switch does (#226): it mutes the OS TOAST. The
   * durable `notifications` row is still written for events that must not be
   * silent. So the warning says "no toast", not "no delivery".
   *
   * NEVER THROWS. A create that already committed its row must not fail
   * because a settings read did; a policy that cannot be read yields no
   * warning and a log line.
   */
  private async warningsFor(dto: CreateBroadcastInput): Promise<string[]> {
    if (!dto.channels.includes('browser')) {
      return [];
    }

    try {
      const policy = await this.systemSettings.getNotificationsPolicy();

      if (!policy.browserEnabled) {
        return [
          'Browser notifications are currently disabled deployment-wide, so recipients will ' +
            'not see an OS notification for this broadcast. The in-app notification is still ' +
            'delivered, and the setting can be re-enabled before this broadcast is sent.',
        ];
      }
    } catch (err) {
      this.logger.warn(
        `Could not read the notification policy while composing a broadcast; ` +
          `no browser warning was raised: ${describeThrown(err)}`
      );
    }

    return [];
  }

  /**
   * The payload every channel renders a broadcast from.
   *
   * ANNOTATED WITH THE TEMPLATE'S OWN TYPE, exactly as
   * `broadcast-chunk.handler.ts` annotates its copy and for the same reason:
   * `notifyNow` takes `data: unknown`, so the call site is the only place the
   * shape is checked at all. Without the annotation, a renamed field in
   * `broadcast.email.ts` becomes a runtime render failure with nothing red in
   * a build.
   *
   * It is a SECOND builder rather than a shared one on purpose: this one takes
   * the DTO an admin just typed, that one takes a stored row, and the two
   * inputs have different types and different nullability. What must not drift
   * is the OUTPUT type, and `BroadcastEmailData` is what holds both of them to
   * it.
   */
  private buildPayload(dto: CreateBroadcastInput, eventKey: string): BroadcastEmailData {
    const ctaUrl = this.ctaUrl(dto.link);

    return {
      title: dto.title,
      body: dto.body,
      // Spread-if-present rather than `?? undefined`: these are optional
      // fields, and an absent key is what a test asserting on the payload
      // expects to see.
      ...(dto.link ? { link: dto.link } : {}),
      ...(dto.ctaLabel ? { ctaLabel: dto.ctaLabel } : {}),
      ...(ctaUrl ? { ctaUrl } : {}),
      critical: eventKey === BROADCAST_CRITICAL_EVENT_KEY,
    };
  }

  /**
   * The absolute CTA URL, or `undefined` when there is nothing to link to.
   *
   * ABSOLUTE because the email layout's `safeUrl` rejects anything else — a
   * mail client has no origin to resolve `/status` against. Built here rather
   * than in the template, which is a pure function of its input and reads no
   * configuration. Trailing slashes are stripped so a configured
   * `http://localhost:3535/` and a stored `/status` cannot produce a doubled
   * slash. Identical to the chunk handler's `ctaUrl`, deliberately.
   */
  private ctaUrl(link: string | undefined): string | undefined {
    if (!link) {
      return undefined;
    }

    const appUrl = this.config.get<string>('appUrl');

    return appUrl ? `${appUrl.replace(/\/+$/, '')}${link}` : undefined;
  }

  /**
   * One `audit_events` row per mutation.
   *
   * Copied from `allowlist.service.ts`'s private helper rather than shared:
   * both are four lines over `prisma.auditEvent.create`, and the thing worth
   * keeping consistent is the SHAPE of what goes in, which a shared function
   * would not enforce any better than this signature does.
   *
   * ⚠ `meta` CARRIES IDENTIFIERS AND SHAPE, NEVER THE BODY. The composed title
   * and body live in exactly one place — the `notification_broadcasts` row —
   * and `audit_events.meta` is not it. Copying them here would put admin-typed
   * content in a table that is retained differently, is read by different
   * screens, has no schema for its JSON, and survives the deletion of the
   * broadcast it describes. The audit log's question is "who did what to
   * which broadcast, when"; `targetId` answers "which".
   */
  private async createAuditEvent(
    actorUserId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: AUDIT_TARGET_TYPE,
        targetId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}
