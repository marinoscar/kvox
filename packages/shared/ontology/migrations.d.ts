import type { OntologyRegistry } from './registry.js';
import type { AttributeKind, KgItemKind } from './types.js';
import type { OntologyChangelogEntry } from './version.js';
export type OntologyMigrationStep = 
/** `from` must be deprecated (or shipped and absent); `to` must exist. Entity-storage types only. */
{
    op: 'retag_entity_type';
    from: string;
    to: string;
} | {
    op: 'retag_relation_type';
    from: string;
    to: string;
}
/** Built-in attributes only: user attributes are keyed by def id and never renamed (§17.3). */
 | {
    op: 'rename_attribute';
    typeKey: string;
    from: string;
    to: string;
}
/** e.g. `text` → `select` with a value map; unmapped values are dropped and counted. */
 | {
    op: 'coerce_attribute';
    typeKey: string;
    key: string;
    to: AttributeKind;
    map?: Record<string, string>;
}
/** Only a deprecated attribute. */
 | {
    op: 'drop_attribute';
    typeKey: string;
    key: string;
} | {
    op: 'retag_item_status';
    itemKind: KgItemKind;
    from: string;
    to: string;
};
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
export declare const ONTOLOGY_MIGRATIONS: readonly OntologyMigration[];
export declare function isOntologyVersion(value: unknown): value is string;
/** `'1.2.3'` → `[1, 2, 3]`. Throws on anything that is not strict semver. */
export declare function parseOntologyVersion(version: string): [number, number, number];
export declare function compareOntologyVersions(a: string, b: string): -1 | 0 | 1;
/** Whether `version` is a major bump (`X.0.0`, X ≥ 1) — the only kind that may change a type's meaning. */
export declare function isMajorOntologyVersion(version: string): boolean;
/**
 * The migrations a row written at `fromVersion` still needs to reach
 * `toVersion`: every `m` with `fromVersion < m.to <= toVersion`, ascending.
 * `migrations` defaults to `ONTOLOGY_MIGRATIONS` (a test injects its own).
 */
export declare function migrationsBetween(fromVersion: string, toVersion?: string, migrations?: readonly OntologyMigration[]): OntologyMigration[];
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
/**
 * Applies `migrations` (ascending, as `migrationsBetween` returns them) to one
 * row. Pure: the input is never mutated. Every op is idempotent — applying the
 * same steps to their own output changes nothing.
 *
 * When anything changed, the result's `ontologyVersion` is the last
 * migration's `to`; an unchanged row keeps its version (§17.4: the version a
 * row was written against is provenance, not a release counter).
 */
export declare function applyMigrationSteps(row: MigratableRow, migrations: readonly OntologyMigration[]): ApplyMigrationStepsResult;
export interface CheckOntologyMigrationsInput {
    migrations: readonly OntologyMigration[];
    registry: OntologyRegistry;
    changelog: readonly OntologyChangelogEntry[];
    shippedKeys: readonly string[];
}
/**
 * Returns one message per broken rule (empty when the declarations are
 * sound). Each message starts with `rule N:` and names the migration and step.
 */
export declare function checkOntologyMigrations(input: CheckOntologyMigrationsInput): string[];
