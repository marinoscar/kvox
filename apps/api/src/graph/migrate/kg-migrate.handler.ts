// =============================================================================
// `kg.migrate` (#384, epic #349; docs/specs/ontology.md §11, §17.4, §18.3)
// =============================================================================
//
// Reshapes ONE user's existing graph rows after an ontology bump that renames
// or retags something, by applying the declarative `ONTOLOGY_MIGRATIONS`
// steps (`@app/shared/ontology`) row by row. §17.4: reshaping is a job, never
// a Prisma migration — `props` is JSONB, the tables never change shape, and
// the work is per user and observable in the admin job list like any other.
//
// Per table, in order `kg_entities` → `kg_relations` → `kg_items`:
//
//   1. select the next keyset page (500) of the owner's CANDIDATE rows — rows
//      below some migration's `to` that one of its steps actually touches
//      (`kg-migrate.plan.ts`);
//   2. apply `migrationsBetween(row.ontology_version, target)` with the pure
//      `applyMigrationSteps`;
//   3. validate the result with `validateProps` against the effective schema
//      computed with ALL domains (a disabled domain's rows still validate) and
//      the owner's own attribute defs;
//   4. write every changed, valid row — `ontology_version` set to the last
//      applied migration's `to` — in ONE `UPDATE … FROM (VALUES …)` per batch,
//      in a transaction. A row failing validation is left untouched and counted
//      `needsAttention` (its id logged, never its props). A row no step changes
//      is not touched at all: its version is provenance (§17.4). (A row the
//      predicate DID select but whose steps turned out to be no-ops — a coerce
//      of a value already in the target shape — is re-versioned, props
//      untouched, so it stops being a candidate.)
//
// Then any `draft` proposal older than the newest MAJOR migration gets
// `stale_ontology` on each item (a #363 `PROPOSAL_ITEM_FLAGS` value; commit
// still validates against the current schema, #366).
//
// IDEMPOTENT AND RESUMABLE. A re-run — the queue's retry, a later cron tick,
// an admin pressing Retry — selects only rows still below a migration target,
// and every op is a no-op on its own output. A crash between batches loses
// nothing: each committed batch has already moved its rows past the target.
// The lease is renewed by the worker between batches like any long job.
//
// -----------------------------------------------------------------------------
// ⚠ SERVER-ONLY — NO `nodeResultSchema`, NO `persistNodeResult`
// -----------------------------------------------------------------------------
//
// CLAUDE.md rule 2's "writes as it goes, reads several tables mid-computation"
// exception: every batch is a read-then-write over the owner's `kg_*` rows,
// and the authority to rewrite a user's graph rows is the same authority
// `kg.purge` needs — there is no PostgreSQL grant narrow enough ("may update
// exactly this user's graph rows") for a `nodeSecretBroker` to mint (rule 3).
// No AI call is made and no key is spent.
//
// `profile: { maxRuntimeMs: 60m, maxAttempts: 3 }` — unlike `kg.purge`,
// retrying is honest here: a retry re-selects only what is still pending and
// cannot double-apply a step, so a transient database error should retry.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  DOMAIN_KEYS,
  applyMigrationSteps,
  computeEffectiveSchema,
  migrationsBetween,
  validateProps,
  type EffectiveSchema,
  type KgItemKind,
  type MigratableRow,
} from '@app/shared/ontology';
import type { Job } from '@prisma/client';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { KG_MIGRATE_JOB_TYPE } from '../job-types';
import {
  DEFAULT_KG_MIGRATE_DEFINITION,
  KG_MIGRATE_DEFINITION,
  KG_MIGRATE_TABLES,
  candidatePredicate,
  effectiveTarget,
  itemTypeKey,
  migrationsUpTo,
  readKgMigratePayload,
  staleDraftCutoff,
  type KgMigrateDefinition,
  type KgMigrateTable,
} from './kg-migrate.plan';
import { KgMigrateRepository, type KgMigrateRow, type KgMigrateUpdate } from './kg-migrate.repository';

export const KG_MIGRATE_PROFILE: JobExecutionProfile = {
  maxRuntimeMs: 60 * 60_000,
  maxAttempts: 3,
};

/** Rows per keyset page and per `UPDATE … FROM (VALUES …)`. */
export const KG_MIGRATE_BATCH_SIZE = 500;

/** At most this many `needsAttention` ids are logged per table (the count is always exact). */
const MAX_LOGGED_IDS = 50;

export interface KgMigrateResult {
  ownerId: string;
  targetVersion: string;
  scanned: number;
  changed: number;
  needsAttention: number;
  droppedValues: number;
  staleDraftItems: number;
  ms: number;
}

@Injectable()
export class KgMigrateHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(KgMigrateHandler.name);

  readonly type = KG_MIGRATE_JOB_TYPE;

  readonly profile: JobExecutionProfile = KG_MIGRATE_PROFILE;

  private readonly definition: KgMigrateDefinition;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly repository: KgMigrateRepository,
    @Optional() @Inject(KG_MIGRATE_DEFINITION) definition?: KgMigrateDefinition,
  ) {
    this.definition = definition ?? DEFAULT_KG_MIGRATE_DEFINITION;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = readKgMigratePayload(job.payload, this.definition.targetVersion);
    if (!payload) {
      // No retry can make an unreadable payload readable.
      this.logger.warn(`kg.migrate job ${job.id} carries no readable payload; nothing to do`);
      return;
    }
    const result = await this.migrate(payload.ownerId, payload.targetVersion);
    this.logger.log(`kg.migrate job ${job.id}: ${JSON.stringify(result)}`);
  }

  /** The whole run for one owner. Public so the db spec can drive it without a queue. */
  async migrate(ownerId: string, requestedTarget: string): Promise<KgMigrateResult> {
    const started = Date.now();
    const targetVersion = effectiveTarget(requestedTarget, this.definition);
    const result: KgMigrateResult = {
      ownerId,
      targetVersion,
      scanned: 0,
      changed: 0,
      needsAttention: 0,
      droppedValues: 0,
      staleDraftItems: 0,
      ms: 0,
    };

    const migrations = migrationsUpTo(targetVersion, this.definition);
    if (migrations.length === 0) {
      result.ms = Date.now() - started;
      return result;
    }

    // ALL domains: a row written while `personal` was on must still validate
    // after the user switched it off — disabling a domain never strands rows.
    const schema = computeEffectiveSchema({
      registry: this.definition.registry,
      enabledDomains: [...DOMAIN_KEYS],
      userAttributes: await this.repository.attributeDefsFor(ownerId),
    });

    for (const table of KG_MIGRATE_TABLES) {
      const predicate = candidatePredicate(table, migrations, this.definition.registry);
      if (predicate === null) continue;
      await this.migrateTable(table, ownerId, targetVersion, predicate, schema, result);
    }

    const cutoff = staleDraftCutoff(migrations, this.definition);
    if (cutoff !== null) result.staleDraftItems = await this.repository.flagStaleDrafts(ownerId, cutoff);

    result.ms = Date.now() - started;
    return result;
  }

  private async migrateTable(
    table: KgMigrateTable,
    ownerId: string,
    targetVersion: string,
    predicate: Parameters<KgMigrateRepository['selectBatch']>[3],
    schema: EffectiveSchema,
    result: KgMigrateResult,
  ): Promise<void> {
    const attentionIds: string[] = [];
    let afterId: string | null = null;

    for (;;) {
      const rows = await this.repository.selectBatch(table, ownerId, targetVersion, predicate, afterId, KG_MIGRATE_BATCH_SIZE);
      if (rows.length === 0) break;
      afterId = rows[rows.length - 1].id;
      result.scanned += rows.length;

      const updates: KgMigrateUpdate[] = [];
      const droppedById = new Map<string, number>();
      for (const row of rows) {
        const outcome = this.reshape(table, row, targetVersion, schema);
        if (outcome === 'unchanged') continue;
        if (outcome === 'invalid') {
          result.needsAttention += 1;
          if (attentionIds.length < MAX_LOGGED_IDS) attentionIds.push(row.id);
          continue;
        }
        updates.push(outcome.update);
        droppedById.set(row.id, outcome.dropped);
      }

      if (updates.length > 0) {
        // A row the optimistic guard skipped (edited since the SELECT) is
        // neither changed nor dropped anything; the next run re-reads it.
        const written = await this.repository.writeBatch(table, ownerId, updates);
        result.changed += written.length;
        for (const id of written) result.droppedValues += droppedById.get(id) ?? 0;
      }

      if (rows.length < KG_MIGRATE_BATCH_SIZE) break;
    }

    if (attentionIds.length > 0) {
      // Ids only — never props, which may hold personal values.
      this.logger.warn(
        `kg.migrate: ${table} rows of owner ${ownerId} left unchanged because the reshaped props ` +
          `fail validation: ${attentionIds.join(', ')}`,
      );
    }
  }

  /** Apply and validate one row. */
  private reshape(
    table: KgMigrateTable,
    row: KgMigrateRow,
    targetVersion: string,
    schema: EffectiveSchema,
  ): 'unchanged' | 'invalid' | { update: KgMigrateUpdate; dropped: number } {
    const type = table === 'item' ? itemTypeKey(this.definition.registry, row.kind ?? '') : row.type;
    if (type === undefined || type === null) return 'invalid';

    let pending;
    try {
      pending = migrationsBetween(row.ontologyVersion, targetVersion, this.definition.migrations);
    } catch {
      // A malformed stored version (the SQL predicate already excludes one;
      // this is the belt to its braces) is a row for a person to look at.
      return 'invalid';
    }
    if (pending.length === 0) return 'unchanged';

    const input: MigratableRow = {
      table,
      type,
      ...(table === 'item' ? { kind: row.kind as KgItemKind, status: row.status } : {}),
      props: row.props,
      ontologyVersion: row.ontologyVersion,
    };
    const applied = applyMigrationSteps(input, pending);
    if (!this.valid(table, applied.row, row.status, schema)) return 'invalid';

    // A row the candidate predicate selected IS one a pending step touches. If
    // the steps left it as it was (a `coerce_attribute` whose value was already
    // in the target shape), it has still been through those migrations: its
    // version moves on, props untouched. Leaving it would make it a candidate
    // forever — rescanned on every run and re-enqueued by every hourly tick.
    const ontologyVersion = applied.changed ? applied.row.ontologyVersion : pending[pending.length - 1].to;

    return {
      update: {
        id: row.id,
        before: { type: row.type, status: row.status, props: row.props, ontologyVersion: row.ontologyVersion },
        after: {
          type: table === 'item' ? null : applied.row.type,
          status: table === 'item' ? (applied.row.status ?? null) : null,
          props: applied.row.props,
          ontologyVersion,
        },
      },
      dropped: applied.dropped.length,
    };
  }

  private valid(table: KgMigrateTable, row: MigratableRow, statusBefore: string | null, schema: EffectiveSchema): boolean {
    if (table === 'relation') return validateProps(schema, row.type, row.props, { relation: true }).ok;
    const type = schema.entityType(row.type);
    if (type === undefined) return false;
    if (table === 'entity' && type.storage !== 'entity') return false;
    if (table === 'item') {
      if (type.storage !== 'item') return false;
      // Only a status a step changed is checked: the steps are not the place to
      // judge a status nothing asked them to touch.
      if (row.status !== statusBefore && (typeof row.status !== 'string' || !(type.statuses ?? []).includes(row.status))) {
        return false;
      }
    }
    return validateProps(schema, row.type, row.props).ok;
  }
}
