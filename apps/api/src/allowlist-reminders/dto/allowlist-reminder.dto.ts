import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Reminder state of one allowlist entry (`kvox_allowlist_reminders`).
 *
 * ⚠ REQUESTED, NOT DELIVERED. `reminderCount` counts reminders an administrator
 * asked for and that were handed to the notification dispatcher. Dispatch is
 * detached and a failed send is recorded in the notification delivery log, so a
 * non-zero count is evidence that someone pressed the button, not that mail
 * arrived. `lastReminderAt` is `null` exactly when `reminderCount` is 0.
 */
export const allowlistReminderSchema = z.object({
  reminderCount: z.number().int().nonnegative(),
  lastReminderAt: z.iso.datetime().nullable(),
});

export class AllowlistReminderDto extends createZodDto(allowlistReminderSchema) {}

export const allowlistReminderRowSchema = allowlistReminderSchema.extend({
  allowedEmailId: z.uuid(),
});

export class AllowlistReminderRowDto extends createZodDto(allowlistReminderRowSchema) {}

/** The most ids one `GET /api/allowlist/reminders` call may ask about. */
export const MAX_REMINDER_IDS = 200;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * `?ids=a,b,c`: a comma-separated list of allowlist entry ids. Validated as a
 * string (a transform would not survive OpenAPI generation) and split by the
 * service, which caps the count.
 */
export const allowlistReminderQuerySchema = z.object({
  ids: z
    .string()
    .regex(
      new RegExp(`^${UUID}(,${UUID}){0,${MAX_REMINDER_IDS - 1}}$`),
      `ids must be 1 to ${MAX_REMINDER_IDS} comma-separated UUIDs`,
    ),
});

export class AllowlistReminderQueryDto extends createZodDto(allowlistReminderQuerySchema) {}
