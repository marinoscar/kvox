// =============================================================================
// `kg.migrate` — the definition it runs against, its payload, and the SQL
// candidate predicates (#384; docs/specs/ontology.md §11, §17.4)
// =============================================================================
//
// Pure: no Nest, no Prisma client — only `Prisma.sql` fragments. The handler,
// the repository and the scheduler cron all build from these, so "which rows
// does a migration touch?" has exactly one answer.
//
// THE CANDIDATE PREDICATE. A row is a candidate when, for SOME migration `m`
// up to the target, the row is still below `m.to` AND one of `m`'s steps would
// actually touch it:
//
//   retag_entity_type / retag_relation_type   type = from
//   rename / coerce / drop attribute           type = typeKey AND props has key
//   retag_item_status                          kind = itemKind AND status = from
//
// Being precise here (rather than "every row below the target") is what keeps
// the hourly cron from re-enqueueing every owner forever: a row no step
// touches is never selected, so its version stays as provenance (§17.4) and it
// costs nothing. The version comparison is semver-as-int-array, which is why
// the parity test forbids pre-release tags (rule 14).
// =============================================================================

import {
  CHANGELOG,
  ONTOLOGY,
  ONTOLOGY_MIGRATIONS,
  ONTOLOGY_VERSION,
  compareOntologyVersions,
  isMajorOntologyVersion,
  isOntologyVersion,
  migrationsBetween,
  parseOntologyVersion,
  type KgItemKind,
  type OntologyChangelogEntry,
  type OntologyMigration,
  type OntologyRegistry,
} from '@app/shared/ontology';
import { Prisma } from '@prisma/client';

import { KG_MIGRATE_JOB_TYPE, KG_SUBJECT_USER } from '../job-types';

/** DI token: tests inject a fixture definition; production takes the default. */
export const KG_MIGRATE_DEFINITION = Symbol('KG_MIGRATE_DEFINITION');

export interface KgMigrateDefinition {
  registry: OntologyRegistry;
  migrations: readonly OntologyMigration[];
  changelog: readonly OntologyChangelogEntry[];
  /** The version this build writes (`ONTOLOGY_VERSION`); a job never migrates past it. */
  targetVersion: string;
}

export const DEFAULT_KG_MIGRATE_DEFINITION: KgMigrateDefinition = Object.freeze({
  registry: ONTOLOGY,
  migrations: ONTOLOGY_MIGRATIONS,
  changelog: CHANGELOG,
  targetVersion: ONTOLOGY_VERSION,
});

export type KgMigrateTable = 'entity' | 'relation' | 'item';

/** Processing order (§11): entities first, so a relation never outruns its endpoints' retag. */
export const KG_MIGRATE_TABLES: readonly KgMigrateTable[] = ['entity', 'relation', 'item'];

// -----------------------------------------------------------------------------
// Payload
// -----------------------------------------------------------------------------

export interface KgMigratePayload {
  ownerId: string;
  targetVersion: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `null` for anything without a uuid `ownerId`; a missing/invalid version falls back to the build's. */
export function readKgMigratePayload(value: unknown, fallbackVersion: string): KgMigratePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ownerId !== 'string' || !UUID_PATTERN.test(record.ownerId)) return null;
  const targetVersion = isOntologyVersion(record.targetVersion) ? record.targetVersion : fallbackVersion;
  return { ownerId: record.ownerId, targetVersion };
}

/** The one enqueue shape (§11): subject `user`/ownerId, so dedup is per owner. */
export function kgMigrateEnqueueFields(ownerId: string, targetVersion: string) {
  return {
    type: KG_MIGRATE_JOB_TYPE,
    subjectType: KG_SUBJECT_USER,
    subjectId: ownerId,
    payload: { ownerId, targetVersion },
  };
}

/**
 * The effective target: the payload's, but never past what this build knows —
 * a job queued by a newer replica during a rolling deploy, claimed by an older
 * one, migrates as far as the older one can and leaves the rest for later.
 */
export function effectiveTarget(requested: string, definition: KgMigrateDefinition): string {
  return compareOntologyVersions(requested, definition.targetVersion) > 0 ? definition.targetVersion : requested;
}

/** Every declared migration up to `target`, ascending. */
export function migrationsUpTo(target: string, definition: KgMigrateDefinition): OntologyMigration[] {
  return migrationsBetween('0.0.0', target, definition.migrations);
}

// -----------------------------------------------------------------------------
// Item kinds ↔ item type keys
// -----------------------------------------------------------------------------

export function itemTypeKey(registry: OntologyRegistry, kind: string): string | undefined {
  return registry.entityTypes().find((t) => t.itemKind === kind)?.key;
}

function itemKindOf(registry: OntologyRegistry, typeKey: string): KgItemKind | undefined {
  return registry.entityType(typeKey)?.itemKind;
}

// -----------------------------------------------------------------------------
// SQL candidate predicates
// -----------------------------------------------------------------------------

/**
 * `ontology_version < version`, semver as `int[]`. A malformed stored version
 * is never a candidate: the CASE keeps the cast from ever seeing it (a plain
 * `AND` would not — PostgreSQL does not promise to evaluate the regex first),
 * so one bad row can never fail an owner's whole job on every attempt.
 */
function versionBelow(version: string): Prisma.Sql {
  const [a, b, c] = parseOntologyVersion(version);
  return Prisma.sql`(CASE WHEN ontology_version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'
    THEN string_to_array(ontology_version, '.')::int[] < ARRAY[${a}::int, ${b}::int, ${c}::int]
    ELSE false END)`;
}

function hasProp(key: string): Prisma.Sql {
  return Prisma.sql`(props -> ${key}::text) IS NOT NULL`;
}

/** A present, non-null value — a coerce leaves JSON `null` alone, so it is never a candidate. */
function hasValue(key: string): Prisma.Sql {
  return Prisma.sql`jsonb_typeof(props -> ${key}::text) <> 'null'`;
}

/** The step predicates of one migration for one table (no version clause). */
function stepPredicates(table: KgMigrateTable, migration: OntologyMigration, registry: OntologyRegistry): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  for (const step of migration.steps) {
    switch (step.op) {
      case 'retag_entity_type':
        if (table === 'entity') out.push(Prisma.sql`type = ${step.from}`);
        break;
      case 'retag_relation_type':
        if (table === 'relation') out.push(Prisma.sql`type = ${step.from}`);
        break;
      case 'rename_attribute':
      case 'coerce_attribute':
      case 'drop_attribute': {
        const key = step.op === 'rename_attribute' ? step.from : step.key;
        const present = step.op === 'coerce_attribute' ? hasValue(key) : hasProp(key);
        if (table === 'item') {
          const kind = itemKindOf(registry, step.typeKey);
          if (kind !== undefined) out.push(Prisma.sql`kind::text = ${kind} AND ${present}`);
        } else {
          const isRelation = registry.relationType(step.typeKey) !== undefined;
          const isEntity = registry.entityType(step.typeKey) !== undefined && itemKindOf(registry, step.typeKey) === undefined;
          // An unregistered typeKey (absent-but-shipped) could be either; check both tables.
          const unknown = !isRelation && registry.entityType(step.typeKey) === undefined;
          if ((table === 'relation' && (isRelation || unknown)) || (table === 'entity' && (isEntity || unknown))) {
            out.push(Prisma.sql`type = ${step.typeKey} AND ${present}`);
          }
        }
        break;
      }
      case 'retag_item_status':
        if (table === 'item') out.push(Prisma.sql`kind::text = ${step.itemKind} AND status = ${step.from}`);
        break;
    }
  }
  return out;
}

/**
 * The WHERE fragment selecting `table`'s candidate rows for `migrations`, or
 * `null` when no step of any of them can touch that table (skip it entirely).
 */
export function candidatePredicate(
  table: KgMigrateTable,
  migrations: readonly OntologyMigration[],
  registry: OntologyRegistry,
): Prisma.Sql | null {
  const clauses: Prisma.Sql[] = [];
  for (const m of migrations) {
    const steps = stepPredicates(table, m, registry);
    if (steps.length === 0) continue;
    clauses.push(Prisma.sql`(${versionBelow(m.to)} AND (${Prisma.join(steps.map((s) => Prisma.sql`(${s})`), ' OR ')}))`);
  }
  return clauses.length === 0 ? null : Prisma.sql`(${Prisma.join(clauses, ' OR ')})`;
}

// -----------------------------------------------------------------------------
// Stale drafts (§11: a draft predating a MAJOR migration is flagged)
// -----------------------------------------------------------------------------

/**
 * The instant before which a `draft` proposal predates the newest major
 * migration up to the target — the end (UTC) of that version's CHANGELOG day,
 * erring toward flagging: `stale_ontology` is advisory, and commit validates
 * against the current schema regardless. `null` when no major migration applies.
 */
export function staleDraftCutoff(migrations: readonly OntologyMigration[], definition: KgMigrateDefinition): Date | null {
  const majors = migrations.filter((m) => isMajorOntologyVersion(m.to));
  const latest = majors[majors.length - 1];
  if (latest === undefined) return null;
  const entry = definition.changelog.find((e) => e.version === latest.to);
  if (entry === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return null;
  const start = Date.parse(`${entry.date}T00:00:00.000Z`);
  if (Number.isNaN(start)) return null;
  return new Date(start + 24 * 60 * 60 * 1000);
}
