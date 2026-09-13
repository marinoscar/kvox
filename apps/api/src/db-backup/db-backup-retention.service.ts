import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/providers/storage-provider.interface';
import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';

// =============================================================================
// Backup retention: two clocks, deliberately (issue #282, epic #254)
// =============================================================================
//
// Something has to delete old archives, or the feature whose whole point is
// "there is always a recent backup" becomes the feature that filled the
// bucket. This service is that something, and the only surprising thing about
// it is that it prunes by TWO DIFFERENT RULES depending on why a run exists.
//
// -----------------------------------------------------------------------------
// RULE 1 — ORDINARY RUNS ARE PRUNED BY COUNT
// -----------------------------------------------------------------------------
//
// Keep the newest `databaseBackup.retentionCount` `completed` runs; delete the
// rest. A count is what an operator actually reasons about ("I want a week of
// nightlies"), and it is the only rule that survives a schedule change: switch
// `frequency` from daily to weekly under an age rule and the same number of
// days now keeps one backup instead of seven.
//
// -----------------------------------------------------------------------------
// RULE 2 — `pre_restore` RUNS ARE PRUNED BY AGE, AND ARE INVISIBLE TO RULE 1
// -----------------------------------------------------------------------------
//
// ⚠ THIS IS THE PART THAT IS NOT DECORATION. #285 takes a `pre_restore` backup
// immediately before it swaps a restored database into place, and under
// `restoreRollbackMode: 'drop_database'` — where the displaced database is NOT
// kept — THAT DUMP IS THE ONLY WAY BACK from a restore that has just happened.
// A count rule knows nothing about that. With `retentionCount: 7` on a
// deployment that took seven nightly backups after a restore, the count rule
// would evict the rollback for the restore, silently, on an ordinary Tuesday
// — and the operator would find out at the exact moment they needed it.
//
// So `pre_restore` runs are excluded from the count rule in BOTH directions:
// they are not deleted by it, and they do not consume one of its N slots
// either. A retention count of 7 means seven *nightly* backups, not six plus
// whatever a restore happened to leave behind.
//
// Their own bound is AGE, derived from `databaseBackup.oldDatabaseRetentionHours`.
//
// ⚠ REUSING THAT SETTING IS A DELIBERATE CHOICE, NOT LAZINESS. It is already
// the setting that answers "how long does the way back from a restore stay
// available": under `retain_database` it is how long the displaced database
// survives before it is dropped. The `pre_restore` dump is the same promise
// expressed in the other rollback mode, so the two must expire together — an
// operator who sets "keep the rollback for 48 hours" means 48 hours whichever
// mode they are in, and a second field would let the two answers drift apart.
//
// REJECTED: adding a `preRestoreRetentionHours` settings field. It is one
// number, and it would cost a change to `systemDatabaseBackupSchema`, the
// defaults in `settings.types.ts`, the PATCH schema, the response DTO, the
// admin UI and the settings-parity spec — six surfaces to express a duration
// this deployment has already expressed once, with a real risk that the two
// end up meaning different things on the same page.
//
// -----------------------------------------------------------------------------
// WHAT IS NEVER PRUNED HERE, AND WHY THAT IS NOT AN OVERSIGHT
// -----------------------------------------------------------------------------
//
// `failed` and `stale` rows. Both rules select `completed` only.
//
//   - THEY COST NO STORAGE. A failed run's partial object was already deleted
//     by the runner before its row was marked (see property 5 in
//     `db-backup-runner.service.ts`), and a stale run's object is deleted by
//     the schedule task's sweep. There is no billable object left to reclaim.
//   - THEY ARE THE EVIDENCE. A `failed` row is the only record that a backup
//     did NOT happen that night. Deleting it under a rule whose job is
//     "keep N good backups" would erase precisely what an operator needs to
//     notice that the good backups stopped.
//
// If a fork later wants to age out failure history, that is a HISTORY
// retention rule (the shape `jobs.history.retentionDays` already has) and it
// belongs beside this one rather than inside it.
//
// -----------------------------------------------------------------------------
// DELETION IS OBJECT FIRST, THEN ROW. ALWAYS.
// -----------------------------------------------------------------------------
//
// The same ordering the runner's failure path uses, for the same reason, and
// it is worth stating in full because the opposite order looks equally
// reasonable until you name its failure:
//
//   - ROW FIRST, THEN OBJECT: a crash (or a bucket that refuses the delete)
//     between the two leaves a multi-gigabyte object in storage with NOTHING
//     ANYWHERE POINTING AT IT. Nothing will ever try again, because the only
//     index of what exists in the bucket is the table this just deleted from.
//     It is billed forever, and it is invisible.
//   - OBJECT FIRST, THEN ROW: the same crash leaves a ROW whose object is
//     already gone. It is visible in the admin list, it costs nothing, and the
//     NEXT prune deletes it — deleting a key that no longer exists is a no-op
//     on every provider this interface targets.
//
// One failure is permanent and silent, the other is transient and loud. So a
// failed object delete KEEPS THE ROW: giving up on the row would convert the
// second failure into the first.
//
// -----------------------------------------------------------------------------
// IT NEVER THROWS
// -----------------------------------------------------------------------------
//
// `prune()` swallows everything and reports what it managed. Its only caller
// today is the runner's success path — a backup that has been uploaded AND
// verified — and at that point the valuable thing has already happened. A
// missed prune costs storage until the next backup; a thrown error would turn
// a successful backup into a failed one and delete the archive that had just
// been proven good. That trade is not close.
// =============================================================================

/** What one prune managed, split by which rule reached each row. */
export interface BackupPruneResult {
  /** Rows deleted by the count rule (ordinary `completed` runs). */
  prunedByCount: number;

  /** Rows deleted by the age rule (`pre_restore` runs). */
  prunedByAge: number;

  /**
   * Candidates left in place because their object could not be deleted.
   *
   * NOT an error, and not zero-by-design: it is the visible half of the
   * object-then-row ordering above, and the next prune retries them.
   */
  keptAfterFailedDelete: number;
}

/** Anything thrown, as an `Error`. JavaScript lets you throw a string. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

@Injectable()
export class DatabaseBackupRetentionService {
  private readonly logger = new Logger(DatabaseBackupRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    // The ACTIVE provider, exactly as the runner injects it: a backup is not a
    // `storage_objects` row, so there is no `ObjectsService` to route through.
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider
  ) {}

  /**
   * Applies both retention rules.
   *
   * NEVER THROWS — see the header. Returns what it managed, so a caller that
   * wants to log something has something truthful to log.
   *
   * @param now pinned by the caller so both rules judge against one instant,
   * and so a test does not have to move the wall clock.
   */
  async prune(now: Date = new Date()): Promise<BackupPruneResult> {
    const result: BackupPruneResult = {
      prunedByCount: 0,
      prunedByAge: 0,
      keptAfterFailedDelete: 0,
    };

    try {
      const policy = await this.settings.getDatabaseBackupPolicy();

      // Two independent statements rather than one combined query, because
      // they are two different questions about two different populations. A
      // single `OR` would be shorter and would make the count rule's `skip`
      // meaningless — the offset would be counting rows the age rule owns.
      await this.pruneByCount(policy, result);
      await this.pruneByAge(policy, now, result);
    } catch (error) {
      // The catch of last resort. Every per-row failure is already handled
      // inside `deleteRun`, so reaching here means the SETTINGS READ or one of
      // the two candidate queries failed — a database blip, which the next
      // successful backup will prune through anyway.
      this.logger.warn(
        `Database backup retention could not complete (storage was not reclaimed; ` +
          `the next successful backup retries): ${toError(error).message}`
      );
    }

    return result;
  }

  /**
   * Rule 1: keep the newest N ordinary `completed` runs.
   *
   * ⚠ `trigger: { not: 'pre_restore' }` APPEARS HERE AND NOWHERE ELSE, and it
   * is doing two jobs at once: it keeps a rollback dump out of the victim list
   * AND out of the `skip` count. Written as a post-filter instead, a restore
   * taken last night would occupy one of the N slots and evict a nightly
   * backup that the operator's retention number said they were keeping.
   */
  private async pruneByCount(
    policy: SystemDatabaseBackupValue,
    result: BackupPruneResult
  ): Promise<void> {
    const victims = await this.prisma.databaseBackupRun.findMany({
      where: { status: 'completed', trigger: { not: 'pre_restore' } },
      // Newest first, then skip the keepers. This is the `[status, createdAt
      // DESC]` index's query — see the note above the index in `schema.prisma`.
      //
      // `createdAt` rather than `finishedAt`: it is never null, it is what the
      // index is built on, and for a completed run the two differ by the
      // duration of one dump, which cannot reorder anything at a retention
      // granularity of whole backups.
      orderBy: { createdAt: 'desc' },
      skip: policy.retentionCount,
      select: { id: true, storageKey: true, createdAt: true },
    });

    // ⚠ OLDEST FIRST. `findMany` handed them back newest-first (it had to —
    // that is what makes `skip` mean "the keepers"), and deleting in that
    // order is the wrong way round: a failure half way through would have
    // deleted the newest of the doomed runs and left the oldest, so an
    // interrupted prune would eat into the archive from the recent end. Oldest
    // first means an interrupted prune still leaves the newest N-ish intact,
    // which is the property retention exists to provide.
    for (const run of [...victims].reverse()) {
      if (await this.deleteRun(run.id, run.storageKey)) {
        result.prunedByCount += 1;
      } else {
        result.keptAfterFailedDelete += 1;
      }
    }
  }

  /**
   * Rule 2: `pre_restore` runs expire on the rollback clock.
   *
   * The cutoff is `now - oldDatabaseRetentionHours`, the same duration that
   * decides how long a DISPLACED DATABASE survives under
   * `restoreRollbackMode: 'retain_database'`. See the header for why that
   * setting is reused rather than joined by a second one.
   */
  private async pruneByAge(
    policy: SystemDatabaseBackupValue,
    now: Date,
    result: BackupPruneResult
  ): Promise<void> {
    const cutoff = new Date(now.getTime() - policy.oldDatabaseRetentionHours * 3_600_000);

    const victims = await this.prisma.databaseBackupRun.findMany({
      where: {
        status: 'completed',
        trigger: 'pre_restore',
        // A `pre_restore` backup is taken immediately before the swap it
        // protects, so its own creation time IS the moment the rollback
        // window opened. There is no separate "restore finished" instant to
        // measure from that would be more than seconds different.
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, storageKey: true },
    });

    // Already oldest-first from the query — there is no `skip` here to force
    // the other order, so the safe order is simply the natural one.
    for (const run of victims) {
      if (await this.deleteRun(run.id, run.storageKey)) {
        result.prunedByAge += 1;
      } else {
        result.keptAfterFailedDelete += 1;
      }
    }
  }

  /**
   * Removes one archive: THE OBJECT FIRST, THEN THE ROW.
   *
   * @returns `true` when both halves landed. `false` KEEPS THE ROW, on
   * purpose — see the header: a row whose object is gone is visible, free and
   * re-prunable, while an object whose row is gone is invisible and billed
   * forever.
   */
  private async deleteRun(runId: string, storageKey: string): Promise<boolean> {
    try {
      await this.storage.delete(storageKey);
    } catch (error) {
      this.logger.warn(
        `Retention could not delete the backup object "${storageKey}"; keeping run ` +
          `${runId} so the next prune tries again: ${toError(error).message}`
      );

      return false;
    }

    try {
      await this.prisma.databaseBackupRun.delete({ where: { id: runId } });
    } catch (error) {
      // The object is gone and the row is not. Harmless and self-healing: the
      // row shows in the admin list with an object that no longer exists, and
      // the next prune re-deletes a key that is already absent (a no-op on
      // every provider this interface targets) and then removes the row.
      this.logger.warn(
        `Retention deleted the backup object "${storageKey}" but could not delete run ` +
          `${runId}; the next prune settles it: ${toError(error).message}`
      );

      return false;
    }

    this.logger.debug(`Retention removed database backup run ${runId} ("${storageKey}").`);

    return true;
  }
}
