// =============================================================================
// Ontology migrations — declarative reshaping of stored graph rows on an
// ontology version bump (docs/specs/ontology.md §17.4, issue #384).
//
// The `kg_*` tables never change shape when the ontology does (`props` is
// JSONB), so a rename or a retag is NOT a Prisma migration: it is a list of
// steps declared here, next to the CHANGELOG entry that introduced it, and
// applied per user, per row, by the `kg.migrate` job (§11).
//
// Everything in this file is PURE — no I/O, no clock, no randomness — so the
// job, the parity test and a future importer (#387) all read the same answer.
//
// AUTHORING A MIGRATION (see docs/runbooks/ontology-migration.md):
//   1. Deprecate the old key in its domain module (never delete it — §17.1).
//   2. Declare the new key, append it to SHIPPED_KEYS.
//   3. Bump ONTOLOGY_VERSION and append a CHANGELOG entry (a retag of a type or
//      relation is a MAJOR bump — parity rule 16).
//   4. Append an `OntologyMigration` below whose `to` is that CHANGELOG version.
//   5. Rebuild: `npm run build:ontology --workspace=@app/shared`.
// =============================================================================

import { USER_ATTRIBUTE_KEY_PREFIX } from './constants.js';
import type { OntologyRegistry } from './registry.js';
import type { AttributeKind, AttributeSpec, KgItemKind } from './types.js';
import type { OntologyChangelogEntry } from './version.js';
import { ONTOLOGY_VERSION } from './version.js';

export type OntologyMigrationStep =
  /** `from` must be deprecated (or shipped and absent); `to` must exist. Entity-storage types only. */
  | { op: 'retag_entity_type'; from: string; to: string }
  | { op: 'retag_relation_type'; from: string; to: string }
  /** Built-in attributes only: user attributes are keyed by def id and never renamed (§17.3). */
  | { op: 'rename_attribute'; typeKey: string; from: string; to: string }
  /** e.g. `text` → `select` with a value map; unmapped values are dropped and counted. */
  | { op: 'coerce_attribute'; typeKey: string; key: string; to: AttributeKind; map?: Record<string, string> }
  /** Only a deprecated attribute. */
  | { op: 'drop_attribute'; typeKey: string; key: string }
  | { op: 'retag_item_status'; itemKind: KgItemKind; from: string; to: string };

export interface OntologyMigration {
  /** Semver; must equal a CHANGELOG version. */
  to: string;
  description: string;
  steps: OntologyMigrationStep[];
}

/**
 * Every declared migration, ascending by `to`. Empty at 1.x ship: the first
 * entry arrives with the first bump that renames or retags something.
 */
export const ONTOLOGY_MIGRATIONS: readonly OntologyMigration[] = Object.freeze([]);

/** Strict semver `MAJOR.MINOR.PATCH` — no pre-release or build suffix, ever. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isOntologyVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

/** `'1.2.3'` → `[1, 2, 3]`. Throws on anything that is not strict semver. */
export function parseOntologyVersion(version: string): [number, number, number] {
  if (!isOntologyVersion(version)) {
    throw new Error(`'${String(version)}' is not an ontology version (MAJOR.MINOR.PATCH)`);
  }
  const [a, b, c] = version.split('.').map((n) => Number.parseInt(n, 10));
  return [a, b, c];
}

export function compareOntologyVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseOntologyVersion(a);
  const pb = parseOntologyVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/** Whether `version` is a major bump (`X.0.0`, X ≥ 1) — the only kind that may change a type's meaning. */
export function isMajorOntologyVersion(version: string): boolean {
  const [major, minor, patch] = parseOntologyVersion(version);
  return major >= 1 && minor === 0 && patch === 0;
}

/**
 * The migrations a row written at `fromVersion` still needs to reach
 * `toVersion`: every `m` with `fromVersion < m.to <= toVersion`, ascending.
 * `migrations` defaults to `ONTOLOGY_MIGRATIONS` (a test injects its own).
 */
export function migrationsBetween(
  fromVersion: string,
  toVersion: string = ONTOLOGY_VERSION,
  migrations: readonly OntologyMigration[] = ONTOLOGY_MIGRATIONS,
): OntologyMigration[] {
  return migrations
    .filter((m) => compareOntologyVersions(fromVersion, m.to) < 0 && compareOntologyVersions(m.to, toVersion) <= 0)
    .sort((x, y) => compareOntologyVersions(x.to, y.to));
}

/** One stored graph row, as far as a migration step can see it. */
export interface MigratableRow {
  table: 'entity' | 'relation' | 'item';
  /** Entity type / relation type key; for an item, its item type key (`Commitment`). */
  type: string;
  kind?: KgItemKind;
  status?: string | null;
  props: Record<string, unknown>;
  ontologyVersion: string;
}

export interface ApplyMigrationStepsResult {
  row: MigratableRow;
  changed: boolean;
  /**
   * One `Type.key` entry per value the steps discarded (an unmapped coerce
   * value, a dropped attribute, a rename source whose target was already set).
   * Keys only — never values, which may be personal.
   */
  dropped: string[];
}

type Coerced = { ok: true; value: unknown } | { ok: false };

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:$|T)/;

/** Coerces one scalar to `kind`, without a value map. */
function coerceScalar(value: unknown, kind: AttributeKind): Coerced {
  switch (kind) {
    case 'text':
    case 'url':
    case 'select':
    case 'entity_ref':
      if (typeof value === 'string') return { ok: true, value };
      if (kind === 'text' && (typeof value === 'number' || typeof value === 'boolean')) {
        return { ok: true, value: String(value) };
      }
      return { ok: false };
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return { ok: true, value: Number(value) };
      }
      return { ok: false };
    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' };
      return { ok: false };
    case 'date': {
      if (typeof value !== 'string') return { ok: false };
      const match = ISO_DATE_PREFIX.exec(value);
      return match ? { ok: true, value: match[1] } : { ok: false };
    }
    case 'multi_select':
      // Handled by the caller (it is the only list-valued kind).
      return { ok: false };
  }
}

/**
 * Maps one string through a value map. A value that is already one of the
 * map's TARGETS is kept, which is what makes a second application a no-op.
 */
function mapValue(value: unknown, map: Record<string, string>): Coerced {
  if (typeof value !== 'string') return { ok: false };
  if (Object.prototype.hasOwnProperty.call(map, value)) return { ok: true, value: map[value] };
  if (Object.values(map).includes(value)) return { ok: true, value };
  return { ok: false };
}

/** Coerce one attribute value; `dropped` counts discarded list elements too. */
function coerceValue(
  value: unknown,
  kind: AttributeKind,
  map: Record<string, string> | undefined,
): { keep: boolean; value?: unknown; droppedCount: number } {
  const one = (v: unknown) => (map ? mapValue(v, map) : coerceScalar(v, kind));

  if (kind === 'multi_select' || Array.isArray(value)) {
    // A multi_select, or a list attribute of a scalar kind: coerce each element.
    const input = Array.isArray(value) ? value : [value];
    if (input.length === 0) return { keep: true, value: [], droppedCount: 0 };
    const out: unknown[] = [];
    let droppedCount = 0;
    for (const element of input) {
      const r = kind === 'multi_select' ? (map ? mapValue(element, map) : coerceScalar(element, 'select')) : one(element);
      if (!r.ok) {
        droppedCount += 1;
        continue;
      }
      if (!out.includes(r.value)) out.push(r.value);
    }
    if (out.length === 0) return { keep: false, droppedCount: Math.max(droppedCount, 1) };
    return { keep: true, value: out, droppedCount };
  }

  const r = one(value);
  return r.ok ? { keep: true, value: r.value, droppedCount: 0 } : { keep: false, droppedCount: 1 };
}

function has(props: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(props, key) && props[key] !== undefined;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Applies `migrations` (ascending, as `migrationsBetween` returns them) to one
 * row. Pure: the input is never mutated. Every op is idempotent — applying the
 * same steps to their own output changes nothing.
 *
 * When anything changed, the result's `ontologyVersion` is the last
 * migration's `to`; an unchanged row keeps its version (§17.4: the version a
 * row was written against is provenance, not a release counter).
 */
export function applyMigrationSteps(
  row: MigratableRow,
  migrations: readonly OntologyMigration[],
): ApplyMigrationStepsResult {
  let type = row.type;
  let status = row.status;
  const props: Record<string, unknown> = { ...row.props };
  const dropped: string[] = [];

  for (const migration of migrations) {
    for (const step of migration.steps) {
      switch (step.op) {
        case 'retag_entity_type':
          if (row.table === 'entity' && type === step.from) type = step.to;
          break;
        case 'retag_relation_type':
          if (row.table === 'relation' && type === step.from) type = step.to;
          break;
        case 'rename_attribute':
          if (type !== step.typeKey || !has(props, step.from) || step.from === step.to) break;
          if (has(props, step.to) && props[step.to] !== null) {
            // The target already holds a value: it wins, the source is discarded.
            if (props[step.from] !== null) dropped.push(`${step.typeKey}.${step.from}`);
          } else {
            props[step.to] = props[step.from];
          }
          delete props[step.from];
          break;
        case 'coerce_attribute': {
          if (type !== step.typeKey || !has(props, step.key) || props[step.key] === null) break;
          const r = coerceValue(props[step.key], step.to, step.map);
          for (let i = 0; i < r.droppedCount; i += 1) dropped.push(`${step.typeKey}.${step.key}`);
          if (r.keep) props[step.key] = r.value;
          else delete props[step.key];
          break;
        }
        case 'drop_attribute':
          if (type !== step.typeKey || !has(props, step.key)) break;
          if (props[step.key] !== null) dropped.push(`${step.typeKey}.${step.key}`);
          delete props[step.key];
          break;
        case 'retag_item_status':
          if (row.table === 'item' && row.kind === step.itemKind && status === step.from) status = step.to;
          break;
      }
    }
  }

  const changed = type !== row.type || status !== row.status || !sameJson(props, row.props);
  const last = migrations[migrations.length - 1];
  const next: MigratableRow = {
    ...row,
    type,
    props: changed ? props : { ...row.props },
    ontologyVersion: changed && last !== undefined ? last.to : row.ontologyVersion,
  };
  if (status !== row.status) next.status = status;
  return { row: next, changed, dropped };
}

// -----------------------------------------------------------------------------
// Parity checks (rules 14–17 of apps/api/test/ontology/ontology-parity.spec.ts)
//
// Kept here, beside the declarations, as a function of its inputs, so the
// parity test can run it against the real ontology AND against deliberately
// broken fixtures (proving each rule actually rejects something).
// -----------------------------------------------------------------------------

export interface CheckOntologyMigrationsInput {
  migrations: readonly OntologyMigration[];
  registry: OntologyRegistry;
  changelog: readonly OntologyChangelogEntry[];
  shippedKeys: readonly string[];
}

/** Every attribute a type carries across all domains: base ∪ mixins, or a relation's props. */
function attributesOf(registry: OntologyRegistry, typeKey: string): Record<string, AttributeSpec> | undefined {
  const entity = registry.entityType(typeKey);
  if (entity !== undefined) {
    const out: Record<string, AttributeSpec> = { ...entity.attributes };
    for (const d of registry.domains()) {
      for (const mixin of d.mixins) if (mixin.entityType === typeKey) Object.assign(out, mixin.attributes);
    }
    return out;
  }
  const relation = registry.relationType(typeKey);
  return relation === undefined ? undefined : { ...relation.props };
}

/**
 * Returns one message per broken rule (empty when the declarations are
 * sound). Each message starts with `rule N:` and names the migration and step.
 */
export function checkOntologyMigrations(input: CheckOntologyMigrationsInput): string[] {
  const { migrations, registry, changelog, shippedKeys } = input;
  const failures: string[] = [];
  const shipped = new Set(shippedKeys);
  const changelogVersions = new Set(changelog.map((e) => e.version));

  // Rule 14 — versions: semver, in the CHANGELOG, strictly ascending.
  for (const entry of changelog) {
    if (!isOntologyVersion(entry.version)) {
      failures.push(`rule 14: CHANGELOG version '${entry.version}' is not MAJOR.MINOR.PATCH (pre-release tags are never used)`);
    }
  }
  migrations.forEach((m, i) => {
    const where = `migration '${m.to}'`;
    if (!isOntologyVersion(m.to)) {
      failures.push(`rule 14: ${where} is not MAJOR.MINOR.PATCH`);
      return;
    }
    if (!changelogVersions.has(m.to)) failures.push(`rule 14: ${where} has no CHANGELOG entry of that version`);
    if (typeof m.description !== 'string' || m.description.trim().length === 0) failures.push(`rule 14: ${where} has no description`);
    if (!Array.isArray(m.steps) || m.steps.length === 0) failures.push(`rule 14: ${where} declares no steps`);
    const prev = migrations[i - 1];
    if (prev !== undefined && isOntologyVersion(prev.to) && compareOntologyVersions(prev.to, m.to) >= 0) {
      failures.push(`rule 14: ${where} does not strictly ascend over '${prev.to}'`);
    }
  });

  // Where the LAST coerce of each attribute sits — only it must match the current definition.
  const lastCoerce = new Map<string, OntologyMigrationStep>();
  for (const m of migrations) {
    for (const step of m.steps ?? []) {
      if (step.op === 'coerce_attribute') lastCoerce.set(`${step.typeKey}.${step.key}`, step);
    }
  }

  for (const m of migrations) {
    for (const [i, step] of (m.steps ?? []).entries()) {
      const where = `migration '${m.to}' step ${i} (${step.op})`;

      // Rule 17 — never a user attribute key.
      const attrKeys =
        step.op === 'rename_attribute' ? [step.from, step.to]
        : step.op === 'coerce_attribute' || step.op === 'drop_attribute' ? [step.key]
        : [];
      if (attrKeys.some((k) => k.startsWith(USER_ATTRIBUTE_KEY_PREFIX))) {
        failures.push(`rule 17: ${where} names a user attribute key (u_*) — those are keyed by def id and never migrated`);
        continue;
      }

      // Rule 16 — a retag (a meaning change) only in a MAJOR bump.
      if ((step.op === 'retag_entity_type' || step.op === 'retag_relation_type') && isOntologyVersion(m.to) && !isMajorOntologyVersion(m.to)) {
        failures.push(`rule 16: ${where} retags a type, a meaning change, but '${m.to}' is not a major version (X.0.0)`);
      }

      // Rule 15 — sources are retired, targets exist.
      switch (step.op) {
        case 'retag_entity_type': {
          const from = registry.entityType(step.from);
          const to = registry.entityType(step.to);
          if (from === undefined ? !shipped.has(step.from) : from.deprecated === undefined) {
            failures.push(`rule 15: ${where} source '${step.from}' is not deprecated (retire it before retagging its rows)`);
          }
          if (from?.itemKind !== undefined) failures.push(`rule 15: ${where} source '${step.from}' is an item type, not an entity type`);
          if (to === undefined || to.itemKind !== undefined) failures.push(`rule 15: ${where} target '${step.to}' is not a registered entity type`);
          else if (to.deprecated !== undefined) failures.push(`rule 15: ${where} target '${step.to}' is itself deprecated`);
          break;
        }
        case 'retag_relation_type': {
          const from = registry.relationType(step.from);
          const to = registry.relationType(step.to);
          if (from === undefined ? !shipped.has(step.from) : from.deprecated === undefined) {
            failures.push(`rule 15: ${where} source '${step.from}' is not deprecated (retire it before retagging its rows)`);
          }
          if (to === undefined) failures.push(`rule 15: ${where} target '${step.to}' is not a registered relation type`);
          else if (to.deprecated !== undefined) failures.push(`rule 15: ${where} target '${step.to}' is itself deprecated`);
          break;
        }
        case 'rename_attribute':
        case 'drop_attribute': {
          const attrs = attributesOf(registry, step.typeKey);
          const source = step.op === 'rename_attribute' ? step.from : step.key;
          if (attrs === undefined) {
            failures.push(`rule 15: ${where} type '${step.typeKey}' is not registered`);
            break;
          }
          const spec = attrs[source];
          if (spec === undefined ? !shipped.has(`${step.typeKey}.${source}`) : spec.deprecated === undefined) {
            failures.push(`rule 15: ${where} source '${step.typeKey}.${source}' is not deprecated`);
          }
          if (step.op === 'rename_attribute') {
            const target = attrs[step.to];
            if (target === undefined) failures.push(`rule 15: ${where} target '${step.typeKey}.${step.to}' is not declared`);
            else if (target.deprecated !== undefined) failures.push(`rule 15: ${where} target '${step.typeKey}.${step.to}' is itself deprecated`);
          }
          break;
        }
        case 'coerce_attribute': {
          const attrs = attributesOf(registry, step.typeKey);
          const spec = attrs?.[step.key];
          if (spec === undefined) {
            failures.push(`rule 15: ${where} attribute '${step.typeKey}.${step.key}' is not declared`);
            break;
          }
          if (lastCoerce.get(`${step.typeKey}.${step.key}`) !== step) break;
          if (spec.kind !== step.to) {
            failures.push(`rule 15: ${where} coerces to '${step.to}' but '${step.typeKey}.${step.key}' is declared '${spec.kind}'`);
          }
          if (step.map !== undefined && (step.to === 'select' || step.to === 'multi_select')) {
            const choices = new Set((spec.options?.choices ?? []).map((c) => c.value));
            for (const target of Object.values(step.map)) {
              if (!choices.has(target)) failures.push(`rule 15: ${where} maps to '${target}', not a choice of '${step.typeKey}.${step.key}'`);
            }
          }
          break;
        }
        case 'retag_item_status': {
          const type = registry.entityTypes().find((t) => t.itemKind === step.itemKind);
          if (type === undefined) {
            failures.push(`rule 15: ${where} item kind '${step.itemKind}' has no item type`);
            break;
          }
          if (step.from === step.to) failures.push(`rule 15: ${where} retags '${step.from}' to itself`);
          if (!(type.statuses ?? []).includes(step.to)) {
            failures.push(`rule 15: ${where} target status '${step.to}' is not a status of '${type.key}'`);
          }
          break;
        }
      }
    }
  }

  return failures;
}
