import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { KgMigrateEnqueuer } from './kg-migrate.enqueuer.js';

/**
 * The hourly timer (minute 17, not 0: an hourly sweep has no reason to pile onto the top of
 * the hour with every other scheduler). A cron only enqueues; see {@link KgMigrateEnqueuer}.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class KgMigrateSchedulerTask extends KgMigrateEnqueuer {
  /** Fires at minute 17 of every hour and enqueues. */
  @Cron('17 * * * *')
  async handleCron(): Promise<void> {
    await this.enqueue();
  }
}
