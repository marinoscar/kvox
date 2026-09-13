// =============================================================================
// The daily fleet-prune scheduler (issue #270, converted by #353)
// =============================================================================
//
// ⚠ THIS TASK DELETES NOTHING. It enqueues a job, and
// `nodes/handlers/node-fleet-prune.handler.ts` does the work on a worker slot.
// The handler's header carries the whole argument for the prune: why it is dead
// code without the sweep that precedes it, and why a node still holding a
// `running` job is skipped rather than deleted.
//
// The kill switch stays here with the scheduling decision, and the
// `JOBS_WORKER_MODE=off` caveat applies exactly as it does to the sweep — see
// `NodeStaleOfflineTask`'s header for both.
//
// DAILY, because retention is measured in DAYS (30 by default), so a daily tick
// adds at most a day to a thirty-day promise. Ten minutes would ask the same
// question 144 times to get the same answer.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NODE_FLEET_PRUNE_TYPE } from '../handlers/node-fleet-prune.handler';

@Injectable()
export class NodeOfflinePruneTask {
  private readonly logger = new Logger(NodeOfflinePruneTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron(): Promise<void> {
    if (!this.enabled()) {
      this.logger.debug(
        'The offline-node prune is disabled (NODE_OFFLINE_PRUNE_ENABLED); skipping'
      );

      return;
    }

    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: NODE_FLEET_PRUNE_TYPE,
      what: 'fleet prune',
    });
  }

  /**
   * Whether this process schedules prunes at all.
   *
   * DEFAULTS TO ON, and only the literal `false` turns it off — the same
   * fail-open direction as every other sweep switch in this repository. Note
   * that failing open here means "forget offline nodes after the configured
   * retention", which is the documented default behaviour, not a surprise: the
   * shipped `offlineRetentionDays` is 30, and the rows it removes are
   * registrations for machines that have not been heard from in a month.
   */
  private enabled(): boolean {
    return this.config.get<boolean>('nodes.offlinePruneEnabled') !== false;
  }
}
