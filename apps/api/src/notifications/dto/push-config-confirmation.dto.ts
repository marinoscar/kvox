import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { vapidSubjectSchema } from '../push-config.schema';

// =============================================================================
// Typed confirmations for the two destructive push-config actions (issue #355)
// =============================================================================
//
// Mirrors `../../db-backup/dto/db-backup-restore.dto.ts`'s typed-literal
// pattern, and for the identical reason: a plain `{ "confirm": true }` is
// reproduced by accident — a replayed POST, a curl line copied out of a
// runbook, a retrying client library, a double-clicked button — while
// `{"confirmation":"ROTATE"}` / `{"confirmation":"REMOVE"}` are not. A request
// carrying the wrong word (or no word) is refused with a 400 having started
// NOTHING.
//
// THE TWO WORDS ARE DELIBERATELY DIFFERENT, mirroring `RESTORE`/`ROLLBACK`:
// a body copied from the rotate route to the remove route (or back) is
// refused rather than silently accepted. Rotating and removing are not
// interchangeable mistakes to allow — one replaces the keys, the other
// deletes the configuration outright.
//
// UPPERCASE, matched exactly: a case-insensitive compare would accept
// `rotate`, a word typed by habit rather than read off a confirmation dialog.
// =============================================================================

/** The word `POST /api/admin/push-config/rotate` requires. */
export const ROTATE_CONFIRMATION = 'ROTATE';

/** The word `DELETE /api/admin/push-config` requires. Deliberately not the same word. */
export const REMOVE_CONFIRMATION = 'REMOVE';

export const rotatePushConfigSchema = z.object({
  /**
   * The literal string `ROTATE`.
   *
   * A missing, empty, misspelt or lower-case value is a `400` and starts
   * nothing — not a key generation, not a credential write. See this file's
   * header for why a boolean was rejected.
   */
  confirmation: z.literal(ROTATE_CONFIRMATION),

  /**
   * Optional new VAPID subject to store alongside the rotated key pair.
   * Omitted keeps whatever subject is currently stored — rotation replaces
   * the KEYS, not necessarily the contact metadata.
   */
  subject: vapidSubjectSchema.nullable().optional(),
});

export type RotatePushConfigInput = z.infer<typeof rotatePushConfigSchema>;

export class RotatePushConfigDto extends createZodDto(
  rotatePushConfigSchema,
) {}

export const removePushConfigSchema = z.object({
  /**
   * The literal string `REMOVE`. A DIFFERENT WORD FROM THE ROTATE ROUTE'S —
   * see this file's header.
   */
  confirmation: z.literal(REMOVE_CONFIRMATION),
});

export type RemovePushConfigInput = z.infer<typeof removePushConfigSchema>;

export class RemovePushConfigDto extends createZodDto(
  removePushConfigSchema,
) {}
