// =============================================================================
// Typed backup failures (issue #281, epic #254)
// =============================================================================
//
// Five ways a backup can be refused or can fail, each of which some caller has
// to be able to tell apart from the others WITHOUT parsing a message string:
//
//   - `DatabaseBackupAlreadyRunningError`  → #283's `POST /backups` returns 409
//     and names the run that is already in flight, so the administrator who
//     just clicked sees "this one" rather than "try again".
//   - `DatabaseBackupStorageProviderError` → a 400 on `PUT` config, and a
//     refusal here, when `databaseBackup.storageProvider` names a provider this
//     deployment does not have.
//   - `DatabaseBackupClientVersionError`   → the `pg_dump` in this image cannot
//     dump this server. The message is a runbook pointer, not an exit code.
//   - `DatabaseBackupVerificationError`    → the bytes reached storage but what
//     came back is not a readable archive.
//   - `DatabaseBackupCancelledError`       → an operator stopped this run. It is
//     an ORDINARY failure, deliberately: cancellation kills the child and
//     destroys the metering stream, and the run then travels the same
//     delete-then-mark-failed path as any other broken dump. See
//     `DatabaseBackupRunnerService.cancel`.
//
// The shape follows `jobs/rate-limit.error.ts`: a plain `Error` subclass, a
// `name`, the discriminating data as readonly fields, and — the part that is
// NOT ceremonial — an explicit `Object.setPrototypeOf`. Extending a built-in
// breaks `instanceof` when the class is downlevelled: the emitted constructor
// calls `Error.call(this)`, which returns a fresh `Error` and leaves `this`'s
// prototype chain pointing at `Error.prototype`. The symptom is the worst
// possible one for this file — `err instanceof DatabaseBackupAlreadyRunningError`
// quietly returns `false`, the 409 becomes a 500, and a perfectly ordinary
// "one is already running" reads to an operator as a broken server.
// =============================================================================

/**
 * The single-active-run index refused this insert: some other run holds
 * `pending`/`running`.
 *
 * ⚠ RAISED FROM A `P2002`, NOT FROM A PRE-CHECK. The database is the arbiter
 * (see `database_backup_runs_active_uniq_idx`), so this error is evidence that
 * a concurrent run genuinely exists at the instant of the insert — which a
 * `findFirst` could never promise.
 */
export class DatabaseBackupAlreadyRunningError extends Error {
  constructor(
    /**
     * The run that won the race.
     *
     * `null` is legitimate and rare: the winning run can SETTLE between the
     * failed insert and the re-read that looks it up, at which point it has
     * dropped out of the partial index's predicate and there is no active run
     * left to name. The caller still gets a truthful "not now"; it simply
     * cannot link to a row. See the retry loops in `claimRun` and
     * `queueBackup`, both of which prefer to re-insert rather than report
     * this.
     *
     * ⚠ #351 ADDED A SECOND, DIFFERENT REASON FOR `null`, and it is not a
     * race: a backup job can legitimately be in flight with no run row to
     * point at, because an administrator deleted the row or `job.history
     * .purge` released the `job_id` link. "A backup is already queued, and
     * here is no id" is still true and useful; a 500 because an audit link was
     * missing would not be.
     */
    readonly activeRunId: string | null
  ) {
    super(
      activeRunId === null
        ? 'A database backup is already running.'
        : `A database backup is already running (run ${activeRunId}).`
    );
    this.name = 'DatabaseBackupAlreadyRunningError';
    Object.setPrototypeOf(this, DatabaseBackupAlreadyRunningError.prototype);
  }
}

/**
 * `databaseBackup.storageProvider` names something other than the provider
 * this deployment actually has bound to `STORAGE_PROVIDER`.
 *
 * A 400 on the config write and a refusal at backup time, deliberately BOTH:
 * validating only on write would let a value that predates the check (a seed,
 * a restored settings blob, a provider swap) sit there until the night the
 * backup silently went somewhere nobody expected.
 */
export class DatabaseBackupStorageProviderError extends Error {
  constructor(
    readonly configured: string,
    readonly active: string
  ) {
    super(
      `databaseBackup.storageProvider is "${configured}", but this deployment's ` +
        `active storage provider is "${active}". This template binds exactly one ` +
        'provider at a time, so the setting must be empty (meaning "whatever is ' +
        `active") or exactly "${active}".`
    );
    this.name = 'DatabaseBackupStorageProviderError';
    Object.setPrototypeOf(this, DatabaseBackupStorageProviderError.prototype);
  }
}

/**
 * The client/server version pair is `blocked` — `pg_dump` refuses to dump a
 * server newer than itself, so no backup can succeed until the image is
 * rebuilt.
 *
 * Carries `checkPgClientVersion`'s own message verbatim, because that message
 * already names both majors and points at the runbook. Re-wording it here
 * would make the run's `lastError` and the log line disagree.
 */
export class DatabaseBackupClientVersionError extends Error {
  constructor(
    message: string,
    readonly clientMajor: number | null,
    readonly serverMajor: number | null
  ) {
    super(message);
    this.name = 'DatabaseBackupClientVersionError';
    Object.setPrototypeOf(this, DatabaseBackupClientVersionError.prototype);
  }
}

/**
 * The uploaded object was streamed back and `pg_restore --list` read no table
 * of contents from it.
 *
 * This is the failure that catches everything a byte count and an exit code
 * cannot: a truncated upload, a zero-byte object, a dump that ran against the
 * wrong (empty) database. See `DatabaseBackupRunnerService`'s verification
 * step for why the check reads STORAGE rather than the stream we just sent.
 */
export class DatabaseBackupVerificationError extends Error {
  constructor(
    readonly storageKey: string,
    readonly tocEntries: number
  ) {
    super(
      `The uploaded backup at "${storageKey}" is not a readable archive: ` +
        `pg_restore --list found ${tocEntries} table-of-contents entries. ` +
        'The object has been deleted; nothing was kept that could not be restored.'
    );
    this.name = 'DatabaseBackupVerificationError';
    Object.setPrototypeOf(this, DatabaseBackupVerificationError.prototype);
  }
}

/**
 * An operator cancelled this run.
 *
 * ⚠ IT IS THROWN INTO THE ORDINARY FAILURE PATH, not handled separately.
 * `cancel()` destroys the metering stream with this error, which tears the
 * upload down, which fails the `Promise.all`, which reaches the one `catch`
 * that deletes the partial object and marks the row `failed`. A second
 * teardown mechanism for cancellation would be a second chance to leave a
 * half-written object in the bucket — see the runner's own comments on why
 * cancellation is deliberately not special.
 */
export class DatabaseBackupCancelledError extends Error {
  constructor(readonly runId: string) {
    super(`Database backup run ${runId} was cancelled by an operator.`);
    this.name = 'DatabaseBackupCancelledError';
    Object.setPrototypeOf(this, DatabaseBackupCancelledError.prototype);
  }
}

// =============================================================================
// Typed restore failures (issue #285, epic #254)
// =============================================================================
//
// The restore half of this subsystem, added below rather than in a file of its
// own because a caller catching "something in the database backup subsystem
// went wrong" should not have to import from two places to enumerate it.
//
// ⚠ MOST RESTORE FAILURES ARE NOT THROWN TO A CALLER AT ALL. A restore runs
// DETACHED — the HTTP request that started it is long since answered — so a
// failure is RECORDED on the run's `restore_status`/`restore_error` columns and
// polled, exactly as a backup's failure is recorded on `status`/`last_error`.
// The three classes below exist because each is a distinct thing a human has to
// be able to tell apart in a log line or a poll response, not because some
// controller catches them:
//
//   - `DatabaseRestoreArchiveError`      → the downloaded bytes are not the
//     bytes that were backed up, or are not a readable archive. It is raised
//     BEFORE anything is created, which is the property that makes it cheap.
//   - `DatabaseRestoreVerificationError` → the replay exited 0 and produced
//     something this application could not run on. Raised before the swap.
//   - `DatabaseRestoreSwapError`         → the second rename failed. This is the
//     one genuinely dangerous moment in the design, and the error carries the
//     only fact that matters afterwards: whether the original database is back
//     under its own name.
//
// ⚠ THERE IS DELIBERATELY NO `AlreadyRunning` ERROR HERE, unlike the backup
// half. "A restore is already running" is a NORMAL, EXPECTED answer that #286
// turns into a 409 without anything having gone wrong, so it is a variant of
// `StartRestoreResult` rather than an exception — the same call
// `CancelBackupResult` makes. It is also only ever PROCESS-LOCAL: a restore's
// state lives on the row of the BACKUP it replays, so two restores are two
// different rows and no database constraint could arbitrate them. An error class
// would have implied a guarantee this design does not have.
// =============================================================================

/**
 * The archive that came back out of storage is not the archive that was put in,
 * or is not readable at all.
 *
 * ⚠ THE CHECK IS AGAINST THE BYTES AS THEY ARE NOW, and that is the entire
 * point of re-running it. #281 already proved the object was a readable archive
 * whose checksum matched AT UPLOAD TIME; this proves it still is, months later,
 * after a storage lifecycle transition, a bit-rot event, or a download that was
 * silently truncated by a proxy. Trusting the recorded checksum would be
 * trusting a measurement of a file nobody has looked at since.
 *
 * It is raised BEFORE `CREATE DATABASE`, so a corrupt archive costs a download
 * and nothing else — no scratch database, no dropped anything, the live
 * database untouched.
 */
export class DatabaseRestoreArchiveError extends Error {
  constructor(
    readonly storageKey: string,
    readonly reason: string
  ) {
    super(
      `The backup archive at "${storageKey}" did not survive re-verification: ${reason} ` +
        'Nothing was created and the live database was not touched. Choose another backup, ' +
        'or restore this one by hand from a copy you have verified yourself.'
    );
    this.name = 'DatabaseRestoreArchiveError';
    Object.setPrototypeOf(this, DatabaseRestoreArchiveError.prototype);
  }
}

/**
 * The restored database could not be renamed into place.
 *
 * ⚠ `originalRestored` IS THE ONLY FACT THAT MATTERS WHEN THIS IS READ.
 * Between the two renames of a swap there is NO DATABASE UNDER THE LIVE NAME at
 * all. The inner recovery renames the original back, and:
 *
 *   - `true`  — the recovery worked. The deployment is on the database it
 *     started on, nothing was lost, and the restore simply did not happen.
 *   - `false` — the recovery ALSO failed. There is no database under the live
 *     name, the application cannot boot, and a human must finish or undo the
 *     swap by hand. That is the state `docs/runbooks/database-restore.md` §5.2
 *     exists for, and it is why this flag is on the error rather than only in a
 *     log line.
 */
export class DatabaseRestoreSwapError extends Error {
  constructor(
    readonly liveDatabase: string,
    readonly originalRestored: boolean,
    readonly cause: Error
  ) {
    super(
      originalRestored
        ? `The restored database could not be renamed to "${liveDatabase}" (${cause.message}). ` +
            'The original database was renamed back into place, so this deployment is running ' +
            'on exactly the data it had before the restore was attempted.'
        : `The restored database could not be renamed to "${liveDatabase}" (${cause.message}), ` +
            'AND THE ORIGINAL COULD NOT BE RENAMED BACK. There is currently no database under ' +
            `"${liveDatabase}". Nothing has been deleted - both databases still exist under ` +
            'their other names. Finish or undo the swap by hand: see section 5.2 of ' +
            'docs/runbooks/database-restore.md.'
    );
    this.name = 'DatabaseRestoreSwapError';
    Object.setPrototypeOf(this, DatabaseRestoreSwapError.prototype);
  }
}

/**
 * The scratch database was replayed into, `pg_restore` exited 0, and what came
 * out is not something this application can run on.
 *
 * The counterpart to `DatabaseBackupVerificationError` on the other side of the
 * round trip, and it exists for the same reason: an exit code is not evidence.
 * `pg_restore --exit-on-error` proves no statement failed; it does not prove the
 * archive contained any statements worth running. Raised BEFORE the swap, so a
 * failure here costs a scratch database that is then dropped.
 */
export class DatabaseRestoreVerificationError extends Error {
  constructor(
    readonly scratchDatabase: string,
    readonly reason: string
  ) {
    super(
      `The restored database "${scratchDatabase}" failed verification: ${reason} It was NOT ` +
        'swapped into place and has been dropped; the live database was never touched.'
    );
    this.name = 'DatabaseRestoreVerificationError';
    Object.setPrototypeOf(this, DatabaseRestoreVerificationError.prototype);
  }
}

// -----------------------------------------------------------------------------
// The restore ENDPOINTS' refusals (issue #286)
// -----------------------------------------------------------------------------
//
// Both of the next two are raised by `DatabaseBackupAdminService` BEFORE
// anything is asked of `DatabaseRestoreService`, and both are typed rather than
// thrown as `NotFoundException`/`BadRequestException` for the reason
// `db-backup.controller.ts` states where it maps them: the restore path is
// reached from more than the HTTP layer — the rollback delegation reaches it
// from inside a running restore — and a framework exception raised there would
// be an HTTP object travelling a code path with no request attached to answer.
// Keeping them domain errors keeps every status-code decision in one readable
// block next to the OpenAPI annotations that publish it.

/**
 * There is no `database_backup_runs` row with that id.
 *
 * → `404`. The id goes in `details` and nowhere else, because the exception
 * filter rebuilds the body from `message` and `details` alone.
 */
export class DatabaseRestoreRunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Database backup run ${runId} was not found.`);
    this.name = 'DatabaseRestoreRunNotFoundError';
    Object.setPrototypeOf(this, DatabaseRestoreRunNotFoundError.prototype);
  }
}

/**
 * The row exists but is not something this operation may act on.
 *
 * → `400`, and the two live cases are worth spelling out because neither is a
 * defect in the request's SHAPE:
 *
 *   - RESTORING A RUN THAT IS NOT `completed`. Only a completed run has a whole
 *     archive that was read back and proved readable. A `running` run's object
 *     is half written; a `failed` run's partial object was deleted by the
 *     failure path. Either would download without error and restore nothing —
 *     after hours, into a scratch database, having already taken a safety dump.
 *     This is the same rule `getDownloadUrl` enforces, for the same reason.
 *   - ROLLING BACK A RUN THAT WAS NEVER RESTORED. There is no swap to undo, and
 *     "roll back" against such a row is not a rollback but a first restore
 *     wearing the wrong word.
 *
 * `reason` is a stable machine-readable token; `message` is the sentence.
 */
export class DatabaseRestoreNotAllowedError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'DatabaseRestoreNotAllowedError';
    Object.setPrototypeOf(this, DatabaseRestoreNotAllowedError.prototype);
  }
}
