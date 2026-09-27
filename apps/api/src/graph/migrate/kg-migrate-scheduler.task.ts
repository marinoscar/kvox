// =============================================================================
// The `kg.migrate` scheduler (#384; docs/specs/ontology.md §11, §17.4)
// =============================================================================
//
// ⚠ THIS TASK RESHAPES NOTHING. Hourly, at minute 17, it asks which owners
// still have graph rows a declared migration would touch, and enqueues one
// `kg.migrate` per owner through `enqueueHousekeepingJob` — the shape
// `jobs/tasks/job-history-purge.task.ts` established and CLAUDE.md's "Every
// long-running activity is a queue job" rule requires
// (`test/jobs/cron-enqueue-only.spec.ts` enforces it on this body).
//
//   - `ONTOLOGY_MIGRATIONS` empty (every 1.x build so far) → return at once,
//     without a query: nothing can be pending.
//   - Otherwise up to 200 distinct owners per tick, selected with the same
//     candidate predicate the handler uses (`kg-migrate.plan.ts`), so an owner
//     whose rows no step touches is never enqueued. A backlog larger than 200
//     drains over successive ticks; each job itself is per owner.
//   - Ordinary dedup per owner (subject `user`/ownerId): a job already pending
//     or running for that owner is not queued twice.
//   - Priority `HOUSEKEEPING_PRIORITY` — user-facing work always goes first.
//
// GATED ON `KG_MIGRATE_SCHEDULE_ENABLED` — only the literal `false` disables
// it, the `DB_BACKUP_SCHEDULE_ENABLED` convention. Disabling the tick never
// disables the job: an administrator can still re-run one owner's migration
// with Retry in /admin/settings/jobs (docs/runbooks/ontology-migration.md).
//
// Minute 17, not 0: an hourly sweep has no reason to pile onto the top of the
// hour with every other scheduler.
// =============================================================================

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_KG_MIGRATE_DEFINITION,
  KG_MIGRATE_DEFINITION,
  KG_MIGRATE_TABLES,
  candidatePredicate,
  kgMigrateEnqueueFields,
  migrationsUpTo,
  type KgMigrateDefinition,
  type KgMigrateTable,
} from './kg-migrate.plan';
import { KgMigrateRepository } from './kg-migrate.repository';

/** Owners enqueued per tick at most. */
export const KG_MIGRATE_OWNERS_PER_TICK = 200;

@Injectable()
export class KgMigrateSchedulerTask {
  private readonly logger = new Logger(KgMigrateSchedulerTask.name);

  private readonly definition: KgMigrateDefinition;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly repository: KgMigrateRepository,
    @Optional() @Inject(KG_MIGRATE_DEFINITION) definition?: KgMigrateDefinition,
  ) {
    this.definition = definition ?? DEFAULT_KG_MIGRATE_DEFINITION;
  }

  @Cron('17 * * * *')
  async handleCron(): Promise<void> {
    if (!this.scheduleEnabled()) {
      this.logger.debug('kg.migrate scheduling is disabled (KG_MIGRATE_SCHEDULE_ENABLED); skipping');
      return;
    }
    if (this.definition.migrations.length === 0) return;

    try {
      const { targetVersion } = this.definition;
      const owners = await this.ownersToMigrate();
      for (const ownerId of owners) {
        const fields = kgMigrateEnqueueFields(ownerId, targetVersion);
        await enqueueHousekeepingJob({
          jobs: this.jobs,
          prisma: this.prisma,
          logger: this.logger,
          type: fields.type,
          what: `knowledge graph migration for owner ${ownerId}`,
          subjectType: fields.subjectType,
          subjectId: fields.subjectId,
          payload: fields.payload as Prisma.InputJsonValue,
        });
      }
    } catch (error) {
      // SWALLOWED: a throw out of a @Cron is an unhandled rejection, and the
      // next tick would have run anyway.
      this.logger.error(
        `Could not schedule kg.migrate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Read-only: the owners with at least one row a declared migration touches. */
  async ownersToMigrate(): Promise<string[]> {
    const migrations = migrationsUpTo(this.definition.targetVersion, this.definition);
    const predicates: Partial<Record<KgMigrateTable, Prisma.Sql>> = {};
    for (const table of KG_MIGRATE_TABLES) {
      const predicate = candidatePredicate(table, migrations, this.definition.registry);
      if (predicate !== null) predicates[table] = predicate;
    }
    return this.repository.ownersNeedingMigration(predicates, this.definition.targetVersion, KG_MIGRATE_OWNERS_PER_TICK);
  }

  private scheduleEnabled(): boolean {
    return this.config.get<boolean>('kgMigrate.scheduleEnabled') !== false;
  }
}
