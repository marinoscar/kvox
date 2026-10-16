// =============================================================================
// What the three action routes answer with (issue #283, epic #254)
// =============================================================================
//
// Delete, cancel and download. Each returns a body rather than a bare `204`,
// and in each case the reason is the same: THE HONEST ANSWER HAS MORE THAN ONE
// SHAPE, and a status code cannot carry the difference.
//
// -----------------------------------------------------------------------------
// DELETE RETURNS `objectDeleted`, SO A MISSING OBJECT CANNOT STRAND A ROW
// -----------------------------------------------------------------------------
//
// The archive is deleted first and the row second — the reverse order would
// leave a multi-gigabyte object in the bucket that nothing points at, billed
// forever, because the row is the only index of what exists there. The same
// ordering, for the same reason, is in `db-backup-retention.service.ts`.
//
// But the object delete is BEST-EFFORT, and that is what this field reports. An
// object that is already gone — pruned by a bucket lifecycle rule, removed by
// hand, deleted by a previous attempt that failed after the object and before
// the row — must not make the row undeletable. Failing the request would leave
// an administrator staring at a row they cannot remove for a reason that is not
// their fault and that no retry will change. So the row goes, and
// `objectDeleted: false` says plainly that there was nothing in storage to
// remove (or that removing it did not work), which is exactly the fact an
// operator needs if they are reconciling a bucket against this table.
//
// -----------------------------------------------------------------------------
// CANCEL RETURNS AN OUTCOME, BECAUSE CANCELLATION IS PROCESS-LOCAL
// -----------------------------------------------------------------------------
//
// A dump is stopped by signalling a CHILD PROCESS, and only the API replica
// that spawned it holds that handle. A run started on another replica genuinely
// cannot be stopped from here. `DatabaseBackupRunnerService.cancel` already
// says so — it returns a discriminated result rather than a `boolean` — and
// this DTO's whole job is to carry that distinction to the client instead of
// flattening it into a 200 that means "cancelled" when it does not.
//
// See `DatabaseBackupAdminService.cancelRun` for why `not_running_here` is a
// 200 with an honest body rather than a 409 or a 500.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// DELETE runs/:id
// ---------------------------------------------------------------------------

export const deleteBackupResultSchema = z.object({
  /** The run that was removed. Echoed so a client need not remember what it asked. */
  id: z.uuid(),

  /**
   * Whether the archive was removed from object storage.
   *
   * `false` is NOT an error and NOT a partial failure the caller should retry:
   * the row is gone either way. It means storage had nothing to remove, or
   * refused — see this file's header. An operator reconciling a bucket against
   * this table is the reader this field exists for.
   */
  objectDeleted: z.boolean(),
});

export class DeleteBackupResultDto extends createZodDto(deleteBackupResultSchema) {}

export type DeleteBackupResult = z.infer<typeof deleteBackupResultSchema>;

// ---------------------------------------------------------------------------
// POST runs/:id/cancel
// ---------------------------------------------------------------------------

/**
 * The two outcomes {@link CancelBackupResultDto} can report.
 *
 * Mirrors `CancelBackupResult` in `db-backup-runner.service.ts` one-for-one and
 * on purpose: this is that type on the wire, not a summary of it.
 */
export const CANCEL_OUTCOMES = ['signalled', 'not_running_here'] as const;

export const cancelBackupResultSchema = z.object({
  /** The run the cancel was aimed at. */
  runId: z.uuid(),

  /**
   * What actually happened.
   *
   *  - `signalled` — the dump process was killed and its upload torn down. The
   *    run travels the ORDINARY failure path from there (partial object
   *    deleted, row marked `failed`), so poll the run to watch it settle;
   *    cancellation is deliberately not a second teardown mechanism.
   *  - `not_running_here` — this replica holds no handle for that run. Either
   *    another replica is executing it, or it settled between the read and the
   *    cancel. Nothing was stopped, and the response says so.
   */
  outcome: z.enum(CANCEL_OUTCOMES),

  /**
   * One sentence an operator can act on, matched to `outcome`.
   *
   * Present so a UI can render the `not_running_here` case without hard-coding
   * an explanation of process-local cancellation — the explanation belongs with
   * the code that knows why, not in every client.
   */
  detail: z.string(),
});

export class CancelBackupResultDto extends createZodDto(cancelBackupResultSchema) {}

export type CancelBackupResult = z.infer<typeof cancelBackupResultSchema>;

// ---------------------------------------------------------------------------
// GET runs/:id/download
// ---------------------------------------------------------------------------

export const backupDownloadUrlSchema = z.object({
  /**
   * A pre-signed URL that downloads the archive DIRECTLY FROM OBJECT STORAGE.
   *
   * Treat it as a credential: anyone holding it can fetch a complete copy of
   * this deployment's database until it expires, with no bearer token of any
   * kind. That is why `expiresIn` below is short — see
   * `BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS` in `db-backup-admin.service.ts`.
   */
  url: z.url(),

  /** Seconds the URL stays valid, counted from when it was issued. */
  expiresIn: z.number().int().positive(),
});

export class BackupDownloadUrlDto extends createZodDto(backupDownloadUrlSchema) {}

export type BackupDownloadUrl = z.infer<typeof backupDownloadUrlSchema>;
