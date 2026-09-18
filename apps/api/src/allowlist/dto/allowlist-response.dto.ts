import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * One allowlist entry as `AllowlistService` returns it: the `allowed_emails`
 * row plus the two user relations it `include`s, each narrowed to `{ id, email }`.
 *
 * Written to match that query, not the Prisma model — the model has more
 * columns on the relations, and documenting those would describe a payload this
 * endpoint does not send.
 */
const allowlistActorSchema = z.object({
  id: z.uuid(),
  email: z.email(),
});

export const allowlistEntrySchema = z.object({
  id: z.uuid(),
  email: z.email(),
  addedById: z.uuid().nullable(),
  addedAt: z.iso.datetime(),
  /** Set once the invited address completes its first sign-in. */
  claimedById: z.uuid().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  notes: z.string().nullable(),

  /**
   * How many invitation reminders have been REQUESTED for this entry (#301),
   * and when the most recent one was.
   *
   * ⚠ Requested and handed to the notification dispatcher — not confirmed
   * delivered. Dispatch is detached and a failed send is recorded against the
   * notification delivery log, so a non-zero count here is evidence that an
   * administrator pressed the button, not that mail arrived. `lastReminderAt`
   * is `null` exactly when `reminderCount` is 0.
   */
  reminderCount: z.number().int().nonnegative(),
  lastReminderAt: z.iso.datetime().nullable(),
  addedBy: allowlistActorSchema.nullable(),
  claimedBy: allowlistActorSchema.nullable(),
});

export class AllowlistEntryDto extends createZodDto(allowlistEntrySchema) {}
