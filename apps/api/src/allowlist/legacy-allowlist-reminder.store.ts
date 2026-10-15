import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export interface LegacyAllowlistReminder {
  reminderCount: number;
  lastReminderAt: Date | null;
}

/**
 * PLATFORM-ADOPTION-SHIM(#465)
 *
 * `allowed_emails.reminder_count` and `last_reminder_at` are a declared
 * deviation from the platform table (migration
 * `20260918120000_add_allowlist_reminder_tracking`), so the composed Prisma
 * client has neither field. This store reads and writes them with raw SQL.
 * #465 replaces it with `kvox_allowlist_reminders` and drops the columns.
 */
@Injectable()
export class LegacyAllowlistReminderStore {
  constructor(private readonly prisma: PrismaService) {}

  /** Reminder state per allowlist entry. An id with no row is absent from the map. */
  async get(ids: readonly string[]): Promise<Map<string, LegacyAllowlistReminder>> {
    const result = new Map<string, LegacyAllowlistReminder>();
    if (ids.length === 0) return result;

    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; reminder_count: number; last_reminder_at: Date | null }>
    >(Prisma.sql`
      SELECT id::text AS id, reminder_count, last_reminder_at
      FROM allowed_emails
      WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    `);

    for (const row of rows) {
      result.set(row.id, {
        reminderCount: row.reminder_count,
        lastReminderAt: row.last_reminder_at,
      });
    }
    return result;
  }

  /**
   * Record one more reminder and return the resulting state. Atomic: the
   * increment happens in the database (`reminder_count + 1`), never as a
   * read-modify-write in the application.
   */
  async increment(id: string, at: Date): Promise<LegacyAllowlistReminder> {
    const rows = await this.prisma.$queryRaw<
      Array<{ reminder_count: number; last_reminder_at: Date | null }>
    >`
      UPDATE allowed_emails
      SET reminder_count = reminder_count + 1, last_reminder_at = ${at}
      WHERE id = ${id}::uuid
      RETURNING reminder_count, last_reminder_at
    `;

    const row = rows[0];
    if (!row) throw new Error(`Allowlist entry ${id} not found`);
    return { reminderCount: row.reminder_count, lastReminderAt: row.last_reminder_at };
  }
}
