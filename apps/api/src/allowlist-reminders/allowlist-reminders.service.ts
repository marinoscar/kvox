import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AUDIT_SINK, type AuditSink } from '@marinoscar/platform-api/core';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

/** Rows of orphan clean-up per read: bounded so the sweep never holds a long lock. */
const ORPHAN_SWEEP_LIMIT = 500;

/** The audit action, KVox-owned (the platform's allowlist writes its own). */
export const ALLOWLIST_REMINDER_SENT_ACTION = 'allowlist.reminder_sent';

export interface AllowlistReminderState {
  reminderCount: number;
  lastReminderAt: Date | null;
}

export interface AllowlistReminderRow extends AllowlistReminderState {
  allowedEmailId: string;
}

/**
 * Invitation reminders for unclaimed allowlist entries (issue #301, moved to a
 * side table by #465).
 *
 * The platform's allowlist (`/api/allowlist`) has no seam for "remind the
 * invitee", and its `AllowedEmail` model is not extensible, so the counter lives
 * in `kvox_allowlist_reminders`, keyed by the allowlist row id with NO foreign
 * key. `allowed_emails` is only ever READ here (`PrismaService.allowedEmail`).
 *
 * A MANUAL ACTION. There is no cron and no job behind it, on purpose (#301): a
 * reminder is a judgement about one person that nothing in the application can
 * make on an administrator's behalf, and a scheduled reminder to a stranger is
 * the shape of mail spam filters exist to catch. It therefore does one indexed
 * read, one write and a detached `notifyAddress`, all inside the request, and
 * root rule 1 ("every long-running activity is a queue job") is not engaged.
 */
@Injectable()
export class AllowlistRemindersService {
  private readonly logger = new Logger(AllowlistRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  /**
   * Re-email an unclaimed invitee and record that a reminder was requested.
   *
   * 404 for a missing entry. 409 (`details.reason: 'already_claimed'`) for a
   * claimed one: the invitee did the thing the message would ask, there is
   * nobody left to remind, and the request is not malformed, it conflicts with
   * the state of the resource.
   *
   * ORDER, and what it does and does not promise. The counter is written FIRST
   * and what it records is weaker than "delivered": `notifyAddress` is detached
   * (it schedules the dispatch and returns before anything is rendered), never
   * rejects, and a provider failure becomes a `notification_deliveries` row. No
   * ordering of the two statements could make the counter mean "arrived". It
   * means: a reminder was requested by an administrator and handed to the
   * dispatcher at this time.
   *
   * The notification runs AFTER the write has committed and outside any
   * `$transaction` (root invariant), and a failure in it, or in the audit write,
   * never fails the request.
   */
  async sendReminder(id: string, adminUserId: string): Promise<AllowlistReminderState> {
    const entry = await this.prisma.allowedEmail.findUnique({
      where: { id },
      include: { addedBy: { select: { id: true, email: true } } },
    });

    if (!entry) {
      throw new NotFoundException(`Allowlist entry with ID ${id} not found`);
    }

    if (entry.claimedById) {
      throw new ConflictException({
        message: `Email ${entry.email} has already been claimed — there is nobody left to remind`,
        details: { reason: 'already_claimed' },
      });
    }

    const reminder = await this.increment(id, new Date());

    await this.auditReminder(adminUserId, entry.id, entry.email, reminder.reminderCount);

    this.logger.log(
      `Invitation reminder for ${entry.email} requested by admin ${adminUserId} ` +
        `(reminder ${reminder.reminderCount})`,
    );

    const signInUrl = this.signInUrl();

    // `entry.notes` IS DELIBERATELY NOT IN THE PAYLOAD: it is an administrator's
    // private annotation about this person, and omitting it at the call site
    // means no future edit to the copy can surface it.
    await this.notifications.notifyAddress('allowlist.invitation_reminder', entry.email, {
      recipientEmail: entry.email,
      // The point of a reminder: "a while ago" is why it is being sent.
      invitedAt: entry.addedAt,
      ...(entry.addedBy?.email ? { invitedBy: entry.addedBy.email } : {}),
      ...(signInUrl ? { signInUrl } : {}),
    });

    return reminder;
  }

  /**
   * Reminder state for the given entries.
   *
   * First deletes orphans (rows whose allowlist entry was removed; there is no
   * foreign key to cascade), with ONE bounded statement, then reads through a
   * JOIN to `allowed_emails`: a row is never trusted without its entry.
   * Entries never reminded have no row and are absent from the result.
   */
  async list(ids: readonly string[]): Promise<AllowlistReminderRow[]> {
    await this.sweepOrphans();

    if (ids.length === 0) return [];

    const rows = await this.prisma.$queryRaw<
      Array<{ allowed_email_id: string; reminder_count: number; last_reminder_at: Date | null }>
    >(Prisma.sql`
      SELECT r.allowed_email_id::text AS allowed_email_id, r.reminder_count, r.last_reminder_at
      FROM kvox_allowlist_reminders r
      JOIN allowed_emails a ON a.id = r.allowed_email_id
      WHERE r.allowed_email_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    `);

    return rows.map((row) => ({
      allowedEmailId: row.allowed_email_id,
      reminderCount: row.reminder_count,
      lastReminderAt: row.last_reminder_at,
    }));
  }

  /**
   * Atomic increment: an `INSERT ... ON CONFLICT DO UPDATE` whose update arm is
   * `reminder_count = reminder_count + 1`, so two concurrent reminders cannot
   * lose a count, and never a read-modify-write in the application.
   */
  private async increment(id: string, at: Date): Promise<AllowlistReminderState> {
    const rows = await this.prisma.$queryRaw<
      Array<{ reminder_count: number; last_reminder_at: Date | null }>
    >`
      INSERT INTO kvox_allowlist_reminders (allowed_email_id, reminder_count, last_reminder_at, updated_at)
      VALUES (${id}::uuid, 1, ${at}, ${at})
      ON CONFLICT (allowed_email_id) DO UPDATE
        SET reminder_count = kvox_allowlist_reminders.reminder_count + 1,
            last_reminder_at = EXCLUDED.last_reminder_at,
            updated_at = EXCLUDED.updated_at
      RETURNING reminder_count, last_reminder_at
    `;

    const row = rows[0];
    if (!row) throw new Error(`Allowlist reminder for ${id} was not recorded`);

    return { reminderCount: row.reminder_count, lastReminderAt: row.last_reminder_at };
  }

  /** One bounded statement; best effort, never fails the read. */
  private async sweepOrphans(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        DELETE FROM kvox_allowlist_reminders
        WHERE allowed_email_id IN (
          SELECT r.allowed_email_id
          FROM kvox_allowlist_reminders r
          WHERE NOT EXISTS (SELECT 1 FROM allowed_emails a WHERE a.id = r.allowed_email_id)
          LIMIT ${ORPHAN_SWEEP_LIMIT}
        )
      `;
    } catch (error) {
      this.logger.warn(
        `Could not sweep orphaned allowlist reminders: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async auditReminder(
    adminUserId: string,
    entryId: string,
    email: string,
    reminderCount: number,
  ): Promise<void> {
    try {
      await this.audit.record({
        action: ALLOWLIST_REMINDER_SENT_ACTION,
        actorUserId: adminUserId,
        targetType: 'allowed_email',
        targetId: entryId,
        meta: { email, reminderCount },
      });
    } catch (error) {
      // The reminder was already counted and is about to be sent; losing the
      // audit row is logged loudly rather than failing the administrator's click.
      this.logger.error(
        `Could not audit reminder for allowlist entry ${entryId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Absolute URL of the sign-in page for the reminder's CTA. `undefined` when
   * `APP_URL` is unset: the layout then omits the button.
   */
  private signInUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? `${appUrl.replace(/\/+$/, '')}/login` : undefined;
  }
}
