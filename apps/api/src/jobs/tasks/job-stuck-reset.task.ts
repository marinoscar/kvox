import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { JobStuckService } from '../job-stuck.service';

// =============================================================================
// The lease reaper (issue #263, epic #254)
// =============================================================================
//
// The timer half of `JobStuckService`: every ten minutes, ask which `running`
// jobs have been abandoned and put them back (or fail the ones that have
// spent their budget). All of the thinking lives in the service — see its
// header for the three recovery signals and for why the give-up phase is only
// implementable because `attempts` is charged at claim time.
//
// TEN MINUTES, not one and not an hour. The reaper's cost is one indexed
// query against `[status, leaseExpiresAt]` on a table that is mostly not
// `running`, so a tighter interval would be affordable — but it would also be
// pointless: the threshold it enforces is measured in tens of minutes
// (`jobs.stuckThresholdMinutes` defaults to 30), so ticking every minute
// would find nothing new nine times out of ten. An hour, at the other end,
// means a node that died two minutes after a tick holds its dedup key for
// nearly an hour before anything can re-run that work. Ten minutes bounds the
// extra delay a dead executor adds to a fraction of the threshold itself.
//
// -----------------------------------------------------------------------------
// IT HONOURS `JOBS_REAPER_ENABLED` AND NEVER `JOBS_WORKER_MODE`
// -----------------------------------------------------------------------------
//
// THE SINGLE MOST IMPORTANT LINE IN THIS FILE IS THE ONE THAT IS NOT HERE:
// there is no `if (mode === 'off') return`. Reaping is a CONTROL-PLANE duty,
// not a worker duty, and the two are not the same thing:
//
//   - `JOBS_WORKER_MODE=off` says "this process executes no jobs". It does not
//     say "this deployment has no jobs" — that process still enqueues work,
//     still serves the queue API, and in the node-fleet deployment it is the
//     only component with a database connection at all.
//   - A dead lease belongs to whoever CLAIMED the row, which in that
//     deployment is always some other machine. Gating the reaper on this
//     process's willingness to run jobs would mean the fleet's dead leases
//     are reaped by nobody: the API will not (mode off) and the nodes cannot
//     (no database). That deployment — a laptop or a spot instance closing its
//     lid mid-job — is where dead leases are the NORMAL case rather than the
//     exception, so it is precisely the wrong place to switch the reaper off.
//
// So the only switch is `JOBS_REAPER_ENABLED`, defaulting to on. It exists for
// the one legitimate case: a deployment running several API replicas that
// wants exactly one of them sweeping. Running it on all of them is safe
// anyway — every phase is an `updateMany` whose `where` re-asserts the row is
// still stuck, so two reapers racing produce one winner and one no-op — the
// switch just saves the duplicated queries.
//
// Registered in `JobsModule`'s providers exactly like `TokenCleanupTask` in
// `AuthModule` and `StorageCleanupTask` in `StorageModule`;
// `ScheduleModule.forRoot()` in `app.module.ts` is what makes `@Cron` fire.
// =============================================================================

@Injectable()
export class JobStuckResetTask {
  private readonly logger = new Logger(JobStuckResetTask.name);

  constructor(
    private readonly stuck: JobStuckService,
    private readonly config: ConfigService
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCron(): Promise<void> {
    if (!this.enabled()) {
      this.logger.debug('Lease reaper is disabled (JOBS_REAPER_ENABLED); skipping sweep');

      return;
    }

    try {
      const { reset, failed } = await this.stuck.resetStuck();

      // Only say something when something happened. A healthy queue produces
      // this tick 144 times a day, and 144 lines of "0 jobs reset" is how a
      // log stops being read.
      if (reset > 0 || failed > 0) {
        this.logger.log(
          `Lease reaper finished: ${reset} job(s) requeued, ${failed} failed permanently`
        );
      } else {
        this.logger.debug('Lease reaper finished: no abandoned jobs');
      }
    } catch (error) {
      // SWALLOWED, like every other scheduled task here. A throw out of a
      // `@Cron` handler is an unhandled rejection, and the next tick would
      // have run anyway — a database blip must not be able to take the
      // process down, and it must not stop the reaper permanently either.
      this.logger.error(
        `Lease reaper failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Whether this process should reap at all.
   *
   * DEFAULTS TO ON, and only the literal `false` turns it off (see
   * `configuration.ts`). A queue that silently stopped reclaiming dead leases
   * because of a typo in an env file would look exactly like a queue that is
   * merely busy, which is the worst possible failure to diagnose — the same
   * fail-open reasoning `JobWorker.mode()` applies to an unrecognised worker
   * mode.
   */
  private enabled(): boolean {
    return this.config.get<boolean>('jobs.reaperEnabled') !== false;
  }
}
