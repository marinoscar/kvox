// =============================================================================
// The `kg.migrate` scheduler (#384; docs/specs/ontology.md §11, §17.4)
// =============================================================================
//
// ⚠ THIS TASK RESHAPES NOTHING. Hourly, at minute 17, it asks which owners
// still have graph rows a declared migration would touch, and enqueues one
// `kg.migrate` per owner through `subjectHousekeeping.enqueue`
// (`../housekeeping-subject.enqueue.ts`, the per-subject form of the platform's
// `enqueueHousekeepingJob`) — the shape CLAUDE.md's "Every long-running
// activity is a queue job" rule requires (the platform `cron-enqueue-only`
// conformance suite, run from `test/conformance.spec.ts`, enforces it on this body).
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

import {
  DEFAULT_KG_MIGRATE_DEFINITION,
  KG_MIGRATE_DEFINITION,
  KG_MIGRATE_TABLES,
  candidatePredicate,
  kgMigrateEnqueueFields,
  migrationsUpTo,
  type KgMigrateDefinition,
  type KgMigrateTable,
} from './kg-migrate.plan.js';
import { KgMigrateRepository } from './kg-migrate.repository.js';
import { subjectHousekeeping } from '../housekeeping-subject.enqueue.js';
import { KVOX_PRISMA, KVOX_JOBS, type KvoxJobsPort, type KvoxSql } from '../../ports/index.js';
import { GRAPH_MODULE_OPTIONS, type ResolvedGraphOptions } from '../graph.options.js';
import type { KvoxGraphDb } from '../data/graph-db.js';

/** Owners enqueued per tick at most. */
export const KG_MIGRATE_OWNERS_PER_TICK = 200;

/**
 * KgMigrateEnqueuer: wiring the slice registers itself; a host configures it through `GraphModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class KgMigrateEnqueuer {
  private readonly logger = new Logger(KgMigrateEnqueuer.name);

  private readonly definition: KgMigrateDefinition;

  constructor(
    @Inject(GRAPH_MODULE_OPTIONS) private readonly options: ResolvedGraphOptions,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    private readonly repository: KgMigrateRepository,
    @Optional() @Inject(KG_MIGRATE_DEFINITION) definition?: KgMigrateDefinition,
  ) {
    this.definition = definition ?? DEFAULT_KG_MIGRATE_DEFINITION;
  }

  /** Queues one migration job per owner that needs one. Never throws. */
  async enqueue(): Promise<void> {
    if (!this.scheduleEnabled()) {
      this.logger.debug('kg.migrate scheduling is disabled by the host; skipping');
      return;
    }
    if (this.definition.migrations.length === 0) return;

    try {
      const { targetVersion } = this.definition;
      const owners = await this.ownersToMigrate();
      for (const ownerId of owners) {
        const fields = kgMigrateEnqueueFields(ownerId, targetVersion);
        await subjectHousekeeping.enqueue({
          jobs: this.jobs,
          logger: this.logger,
          type: fields.type,
          what: `knowledge graph migration for owner ${ownerId}`,
          subjectType: fields.subjectType,
          subjectId: fields.subjectId,
          payload: fields.payload,
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
    const predicates: Partial<Record<KgMigrateTable, KvoxSql>> = {};
    for (const table of KG_MIGRATE_TABLES) {
      const predicate = candidatePredicate(table, migrations, this.definition.registry);
      if (predicate !== null) predicates[table] = predicate;
    }
    return this.repository.ownersNeedingMigration(predicates, this.definition.targetVersion, KG_MIGRATE_OWNERS_PER_TICK);
  }

  private scheduleEnabled(): boolean {
    return this.options.migrateScheduleEnabled();
  }
}
