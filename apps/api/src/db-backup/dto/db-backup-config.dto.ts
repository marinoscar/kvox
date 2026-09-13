// =============================================================================
// The backup policy, read and written (issue #283, epic #254)
// =============================================================================
//
// One settings namespace (`databaseBackup`) seen from two directions: what an
// administrator sends to change it, and what they get back to look at.
//
// -----------------------------------------------------------------------------
// THE REQUEST SCHEMA IS `systemDatabaseBackupPatchSchema`, IMPORTED AND NOT
// RE-DECLARED
// -----------------------------------------------------------------------------
//
// Every bound in it — `compressionLevel` 0-9, `retentionCount` 1-365,
// `timeOfDay` matching `BACKUP_TIME_OF_DAY_PATTERN`, `dayOfMonth` stopping at
// 28 so that "monthly" never skips February — is already stated once in
// `common/schemas/settings.schema.ts`, and `PUT /api/system-settings` already
// enforces exactly that schema over exactly this namespace. A second copy here
// would be two schemas over one column, and the copy that drifts is always the
// one nobody is looking at: the settings page would accept a value this route
// refuses, or worse, this route would accept one the settings page refuses and
// write it to the same JSONB.
//
// This is the same argument `db-backup-storage.ts` makes for having ONE
// storage-provider rule shared by the write path and the run path.
//
// EVERY FIELD IS OPTIONAL, which is what makes the route a partial update in
// the sense the issue asks for: `{ "enabled": true }` is a legal body. An
// administrator changing the hour must not have to echo back twelve fields they
// did not touch — a form that re-sends everything is a form that silently
// reverts whatever another admin changed while it was open.
//
// -----------------------------------------------------------------------------
// THE RESPONSE IS THE POLICY PLUS TWO COMPUTED FIELDS
// -----------------------------------------------------------------------------
//
// `nextRunAt` and `activeRunId` are not stored anywhere and are not settings.
// They are here because the question an administrator actually has on this
// screen is not "what did I save" but "is this going to do what I meant, and is
// something happening right now" — and both were previously unanswerable
// without waiting a day to find out.
//
// See `DatabaseBackupAdminService.getConfig` for why `nextRunAt` is computed
// rather than stored, and why it is `null` in two quite different situations.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  systemDatabaseBackupPatchSchema,
  systemDatabaseBackupSchema,
} from '../../common/schemas/settings.schema';

/**
 * The `PUT config` body: the settings namespace's own patch schema, unchanged.
 *
 * Not `.strict()`. The global `ZodValidationPipe` strips unknown keys, which is
 * the behaviour every other settings write in this API already has: a client
 * that sends a field a newer build understands and this one does not gets its
 * known fields applied rather than a 400 it cannot act on.
 */
export const updateDatabaseBackupConfigSchema = systemDatabaseBackupPatchSchema;

export class UpdateDatabaseBackupConfigDto extends createZodDto(
  updateDatabaseBackupConfigSchema
) {}

/** The parsed shape `DatabaseBackupAdminService.updateConfig` consumes. */
export type UpdateDatabaseBackupConfig = z.output<typeof updateDatabaseBackupConfigSchema>;

export const databaseBackupConfigSchema = systemDatabaseBackupSchema.extend({
  /**
   * When the schedule will next fire, in UTC.
   *
   * COMPUTED ON EVERY READ from the settings above, never stored. The cron in
   * `tasks/db-backup-schedule.task.ts` is the only thing that fires a scheduled
   * backup; this field is a projection of the same rules and writes nothing, so
   * reading this endpoint can never cause, delay or skip a backup.
   *
   * `null` means "no next run", and there are two ways to get one — a client
   * rendering this field should say "not scheduled" rather than guessing which:
   *
   *   1. `enabled` is false. Nothing is scheduled, which is the answer.
   *   2. The schedule cannot be projected — a `timezone` this runtime does not
   *      know. `PUT config` refuses such a value, so this can only be a row
   *      that predates the check (a seed, a restored settings blob, a
   *      hand-edited JSONB), and the response stays a 200 precisely so the
   *      screen that can FIX it still loads. See
   *      `DatabaseBackupAdminService.getConfig`.
   */
  nextRunAt: z.iso.datetime().nullable(),

  /**
   * The run currently holding the single-active-run slot, or `null`.
   *
   * ⚠ A DISPLAY VALUE, AND NOT A PRE-FLIGHT CHECK. Nothing may read this and
   * conclude that a `POST runs` will succeed: between this read and that write
   * the scheduler on another replica can claim the slot. The arbiter is the
   * partial unique index and it always will be — see §2 of
   * `docs/specs/database-backup.md` for why a `findFirst` before the insert is
   * racy exactly when it matters.
   */
  activeRunId: z.uuid().nullable(),
});

export class DatabaseBackupConfigDto extends createZodDto(databaseBackupConfigSchema) {}

/** The exact object shape `getConfig` produces, and therefore the wire shape. */
export type DatabaseBackupConfigResponse = z.infer<typeof databaseBackupConfigSchema>;
