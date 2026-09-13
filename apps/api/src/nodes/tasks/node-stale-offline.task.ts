// =============================================================================
// The ten-minute fleet-sweep scheduler (issue #270, converted by #353)
// =============================================================================
//
// ⚠ THIS TASK TRANSITIONS NOTHING. It enqueues a job, and
// `nodes/handlers/node-fleet-sweep.handler.ts` does the work on a worker slot —
// the shape `jobs/tasks/job-history-purge.task.ts` established and that #353
// (epic #345) made true of every maintenance cron in this application. The
// handler's header carries the whole argument for the sweep itself: why a
// crashed node is the case that matters, why the threshold is a multiple of the
// stale window rather than a duration of its own, and why `disabled` is never
// auto-transitioned.
//
// -----------------------------------------------------------------------------
// THE KILL SWITCH STAYS HERE, WITH THE SCHEDULING DECISION
// -----------------------------------------------------------------------------
//
// `NODE_STALE_OFFLINE_ENABLED` says whether THIS PROCESS maintains fleet
// liveness. That is a question about scheduling, so it is asked before the
// enqueue and never again inside the handler: a sweep row that reached a worker
// was queued by a process that had already decided to sweep, and re-asking in
// the handler would let a job queued by one replica be silently dropped by
// another that happens to have the switch off.
//
// ⚠ THE HONEST CAVEAT, THE SAME ONE `DatabaseBackupScheduleTask` CARRIES: with
// `JOBS_WORKER_MODE=off` this tick queues sweeps that nothing will execute.
// `nodes.fleet.sweep` is server-only by derivation, so `system` mode runs it and
// only `off` does not — and a deployment that executes no jobs at all has
// already accepted that its housekeeping is somebody else's problem. See
// docs/specs/job-queue.md.
//
// Runs every TEN MINUTES: the shortest interval at which it can still be true
// that the sweep adds only a fraction of the threshold it enforces (the shipped
// policy is 90s x 4 = 6 minutes) to how long a dead node looks alive.
//
// Registered in `NodesModule`'s providers; `ScheduleModule.forRoot()` in
// `app.module.ts` is what makes `@Cron` fire.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NODE_FLEET_SWEEP_TYPE } from '../handlers/node-fleet-sweep.handler';

@Injectable()
export class NodeStaleOfflineTask {
  private readonly logger = new Logger(NodeStaleOfflineTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCron(): Promise<void> {
    if (!this.enabled()) {
      this.logger.debug(
        'The stale-node sweep is disabled (NODE_STALE_OFFLINE_ENABLED); skipping'
      );

      return;
    }

    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: NODE_FLEET_SWEEP_TYPE,
      what: 'fleet sweep',
    });
  }

  /**
   * Whether this process schedules sweeps at all.
   *
   * DEFAULTS TO ON, and only the literal `false` turns it off (see
   * `configuration.ts`) — the same fail-open direction `JOBS_REAPER_ENABLED`
   * takes, for the same reason: a fleet whose liveness tracking silently stopped
   * because of a typo in an env file looks exactly like a fleet that is
   * perfectly healthy, which is the worst possible failure to diagnose.
   *
   * It exists for the one legitimate case: several API replicas sharing one
   * database where an operator wants exactly one of them scheduling. Running it
   * everywhere is safe anyway — the active-dedup index collapses the duplicate
   * enqueues onto one row — the switch just saves the duplicated queries.
   */
  private enabled(): boolean {
    return this.config.get<boolean>('nodes.staleOfflineEnabled') !== false;
  }
}
