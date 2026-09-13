// =============================================================================
// The per-job credential sweeper (issue #349, epic #345)
// =============================================================================
//
// The timer half of `NodeSecretBrokerService`: every ten minutes, ask which
// grants belong to a job no node is holding any more, and destroy them. All of
// the thinking lives in the service — see its header for the hold predicate and
// for why it is the exact complement of `assertJobHeldByNode`.
//
// -----------------------------------------------------------------------------
// ⚠ THIS IS NOT BELT-AND-BRACES OVER THE SETTLE LISTENER. READ THIS BEFORE
// DELETING IT.
// -----------------------------------------------------------------------------
//
// `NodeSecretRevoker` catches almost everything and it is the fast path, so the
// natural conclusion is that this cron is defensive duplication. It is not: the
// event path STRUCTURALLY CANNOT cover three cases, and each of them is a case
// where a credential is MORE likely than average to be outstanding.
//
//   1. A JOB SETTLED BY THE REAPER. `JobStuckService` requeues and fails
//      abandoned jobs with `updateMany`, which returns a count and not rows —
//      there is no `Job` to build a `JobSettledEvent` from, so NOTHING IS
//      EMITTED. That is exactly the "the executor died holding the credential"
//      case, which is the case this whole mechanism most needs covered.
//   2. AN API REPLICA THAT DIED BETWEEN SETTLING AND REVOKING. The terminal
//      write committed, the emit ran, and the process was gone before the
//      broker call returned. Nothing retries an in-process listener.
//   3. A `write-failed` TERMINAL OUTCOME. `safeTerminalUpdate` gives up after
//      two attempts, leaves the row for the reaper and returns `null`, so
//      `emitSettled` is never reached at all.
//
// The credential's own `expiresAt` is the backstop under both paths — but an
// expiry BOUNDS DAMAGE, it does not CLEAN UP. Without this sweep a deployment
// accumulates one dead PostgreSQL role per uncovered settle, forever.
//
// -----------------------------------------------------------------------------
// TEN MINUTES, AND `NODE_SECRET_SWEEP_ENABLED` IS THE ONLY SWITCH
// -----------------------------------------------------------------------------
//
// Ten minutes for the same reason the lease reaper uses ten (see
// `jobs/tasks/job-stuck-reset.task.ts`): the thing it is chasing is measured in
// lease lengths, so a tighter interval finds nothing new most laps, and an hour
// leaves a credential from a crashed node live for most of an hour after the
// job is gone.
//
// The switch is gated EXACTLY as `JOBS_REAPER_ENABLED` gates the reaper —
// default on, and only the literal `'false'` turns it off, so a typo fails
// OPEN into "keep sweeping". The failure it protects against is the worst
// possible kind to diagnose: a deployment whose credential cleanup silently
// stopped looks precisely like one where it is working, right up until somebody
// lists the roles on the database.
//
// ⚠ IT IS NOT GATED ON `nodes.jobSecretBrokerEnabled`, and that is deliberate.
// Turning brokering OFF is the exact moment the outstanding grants most need
// destroying: an administrator revoking the fleet's authority expects the
// credentials already handed out to go away, not to survive until their own
// expiry. A sweep gated on the setting would do nothing on the one day it
// matters most.
//
// Registered in `NodesModule`'s providers exactly like `NodeStaleOfflineTask`
// and `NodeOfflinePruneTask`; `ScheduleModule.forRoot()` in `app.module.ts` is
// what makes `@Cron` fire.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { NodeSecretBrokerService } from '../node-secret-broker.service';

@Injectable()
export class NodeSecretSweepTask {
  private readonly logger = new Logger(NodeSecretSweepTask.name);

  constructor(
    private readonly secrets: NodeSecretBrokerService,
    private readonly config: ConfigService
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCron(): Promise<void> {
    if (!this.enabled()) {
      this.logger.debug(
        'Per-job credential sweep is disabled (NODE_SECRET_SWEEP_ENABLED); skipping'
      );

      return;
    }

    try {
      const { examined, revoked, failed } = await this.secrets.sweep();

      // Only say something when something happened. A healthy deployment
      // produces this tick 144 times a day, and 144 lines of "0 revoked" is how
      // a log stops being read.
      if (revoked > 0 || failed > 0) {
        this.logger.log(
          `Credential sweep finished: ${revoked} grant(s) revoked, ${failed} could not be ` +
            `(retried next tick), ${examined} examined`
        );
      } else {
        this.logger.debug(
          `Credential sweep finished: nothing to revoke (${examined} live grant(s))`
        );
      }
    } catch (error) {
      // SWALLOWED, like every other scheduled task here. A throw out of a
      // `@Cron` handler is an unhandled rejection, the next tick would have run
      // anyway, and a database blip must not be able to take the process down
      // or stop the sweep permanently.
      this.logger.error(
        `Credential sweep failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Whether this process should sweep at all.
   *
   * DEFAULTS TO ON, and only the literal `false` turns it off (see
   * `configuration.ts`). It exists for the one legitimate case the reaper's own
   * switch exists for: several API replicas sharing one database, where exactly
   * one should sweep. Running it everywhere is safe anyway — the mark is an
   * `updateMany` guarded on `revokedAt: null`, so two sweepers racing produce
   * one winner and one no-op, and `JobSecretBroker.revoke` is contracted to
   * treat "already revoked" as success.
   */
  private enabled(): boolean {
    return this.config.get<boolean>('nodes.secretSweepEnabled') !== false;
  }
}
