import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { JOB_TEMP_PREFIX, jobTempDir } from '../job-temp';
import { parseWorkerMode } from '../job.worker';

// =============================================================================
// The temp-file janitor (issue #263, epic #254)
// =============================================================================
//
// The third thing that goes wrong on its own. A handler that writes a scratch
// file deletes it when it is done; a handler whose process is SIGKILLed does
// not, because no `finally` block, no `process.on('exit')` handler and no
// shutdown hook runs when the kernel removes a process. The file survives the
// worker, and the next kill leaves another one next to it.
//
// Nothing in the queue can notice this. The lease reaper reclaims the ROW, and
// the row is all it knows about; the bytes on the dead worker's disk are
// invisible to every query. Only a sweep of the filesystem itself can find
// them, which is what this is.
//
// See `job-temp.ts` for the naming half — why every temp file carries a
// prefix derived from `APP_NAME`, and why an empty prefix would be dangerous.
//
// -----------------------------------------------------------------------------
// SIX HOURS, AND WHY IT IS NOT SHORTER
// -----------------------------------------------------------------------------
//
// The age test is what separates "abandoned" from "in use", and there is no
// other signal available: an open file handle on a file this process is
// writing looks identical, on disk, to a file a dead process left behind.
// `JOBS_JOB_TIMEOUT_MS` defaults to ten minutes and can legitimately be raised
// to hours for a big export or a video transcode, so six hours leaves an order
// of magnitude of headroom over the longest plausible job while still bounding
// wasted disk to a fraction of a day. Deleting a file out from under a running
// handler is a corrupted output and a mysterious failure; keeping a stale one
// for six hours costs disk space that gets reclaimed on the next tick.
//
// mtime, not ctime or atime: a handler that is still writing keeps mtime
// moving, so a long download is continuously proving it is alive. atime is
// unreliable (`relatime`, `noatime`) and ctime moves for metadata changes that
// say nothing about progress.
//
// -----------------------------------------------------------------------------
// ON MODULE INIT *AND* HOURLY
// -----------------------------------------------------------------------------
//
// The hourly tick is the steady state. The startup sweep is the one that
// matters most: the commonest way to leave orphaned temp files is a process
// that was killed, and the commonest thing to happen after a process is killed
// is that it is restarted. Waiting up to an hour to clean up what the previous
// life of this very container leaked would be a strange choice — especially in
// a crash loop, which is exactly when files accumulate fastest.
//
// -----------------------------------------------------------------------------
// SKIPPED ONLY WHEN THE WORKER MODE IS `off`
// -----------------------------------------------------------------------------
//
// Note how this differs from the lease reaper next door, which deliberately
// ignores the worker mode: the two are gated differently because they are
// cleaning up different things. A dead LEASE is a shared row in a shared
// database, so any control plane can reap it. A stale temp FILE is on one
// machine's local disk, and only the process that ran a handler could have
// created it. A `JOBS_WORKER_MODE=off` process has never executed a job, so
// there is nothing of ours in its `/tmp` — and sweeping anyway would mean a
// pure control plane deleting prefixed files belonging to whichever OTHER
// process on that host actually does the work.
//
// The mode goes through `parseWorkerMode`, the helper `JobWorker.mode()` uses,
// so there is ONE parse of `JOBS_WORKER_MODE` in the process. The WORKER
// ITSELF is deliberately not injected here: this task needs a configuration
// answer, not the pool, and a task holding the pool could stop it. An
// unrecognised value falls open to sweeping, matching the worker's own
// fail-open direction — a typo must not silently turn cleanup off.
// =============================================================================

/** How old a prefixed temp file must be before it is presumed abandoned. */
const MAX_TEMP_FILE_AGE_MS = 6 * 60 * 60 * 1000;

/** What one sweep did. Returned for the logs and for the tests. */
export interface TempSweepResult {
  removed: number;
  kept: number;
}

@Injectable()
export class TempFileJanitorTask implements OnModuleInit {
  private readonly logger = new Logger(TempFileJanitorTask.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * The startup sweep.
   *
   * AWAITED rather than fired and forgotten, which is affordable because the
   * work is one `readdir` plus an `lstat` for each PREFIXED entry only — a
   * `/tmp` full of other people's files costs a single directory listing. The
   * sweep never throws (see `sweep`), so bootstrap cannot be blocked by a
   * filesystem problem either.
   */
  async onModuleInit(): Promise<void> {
    await this.sweep();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron(): Promise<void> {
    await this.sweep();
  }

  /**
   * Removes prefixed temp files older than the age limit.
   *
   * NEVER THROWS. Every error is swallowed at the level it happens at:
   *
   *   - PER FILE, so one entry that cannot be read or removed (a permission
   *     error, a file another process deleted between the listing and the
   *     `lstat`, a mount that went away) does not stop the sweep of the
   *     hundreds behind it. A file that fails today is retried in an hour.
   *   - PER SWEEP, so an unreadable temp directory produces one warning
   *     rather than an unhandled rejection out of a `@Cron` handler or a
   *     failed application bootstrap.
   *
   * Nothing here is load-bearing enough to be worth failing over: the worst
   * case of a sweep that did nothing is disk that is reclaimed later.
   */
  async sweep(): Promise<TempSweepResult> {
    if (this.workerMode() === 'off') {
      this.logger.debug(
        'Worker mode is "off": this process runs no handlers, so it has no temp files to sweep'
      );

      return { removed: 0, kept: 0 };
    }

    const dir = jobTempDir();
    let entries: string[];

    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      this.logger.warn(`Could not list the temp directory ${dir}: ${describe(error)}`);

      return { removed: 0, kept: 0 };
    }

    const cutoff = Date.now() - MAX_TEMP_FILE_AGE_MS;
    let removed = 0;
    let kept = 0;

    for (const entry of entries) {
      // THE PREFIX TEST COMES FIRST AND IS THE ONLY THING THAT MAKES THIS
      // SAFE. Everything else in `/tmp` belongs to somebody else.
      if (!entry.startsWith(JOB_TEMP_PREFIX)) {
        continue;
      }

      const path = join(dir, entry);

      try {
        // `lstat`, not `stat`: a symlink is inspected as itself rather than
        // followed, so a prefixed symlink pointing at something important
        // cannot make the janitor read (or report on) the target.
        const stats = await fs.lstat(path);

        if (stats.mtimeMs > cutoff) {
          kept += 1;
          continue;
        }

        // `recursive` because a handler may have made a scratch DIRECTORY;
        // `force` so a file that disappeared since the listing is not an
        // error worth logging.
        await fs.rm(path, { recursive: true, force: true });

        removed += 1;
        this.logger.debug(`Removed abandoned temp file ${path}`);
      } catch (error) {
        this.logger.warn(`Could not remove temp file ${path}: ${describe(error)}`);
      }
    }

    if (removed > 0) {
      this.logger.log(
        `Temp-file janitor removed ${removed} abandoned file(s) from ${dir} ` +
          `(${kept} still in use or too recent)`
      );
    }

    return { removed, kept };
  }

  /**
   * This process's worker mode, falling open to "it runs jobs" when the
   * configured value is not one of the three.
   *
   * Same direction as `JobWorker.mode()`: a typo must not silently stop
   * cleanup, and sweeping our own prefix on a machine that turned out not to
   * run jobs costs nothing.
   */
  private workerMode(): string {
    return parseWorkerMode(this.config.get('jobs.workerMode')) ?? 'all';
  }
}

/** Whatever was thrown, rendered for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
