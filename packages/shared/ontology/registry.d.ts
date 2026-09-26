import type { DomainModule, EntityTypeSpec, RelationTypeSpec } from './types.js';
export interface OntologyRegistry {
    version: string;
    domains(): readonly DomainModule[];
    entityType(key: string): Readonly<EntityTypeSpec> | undefined;
    relationType(key: string): Readonly<RelationTypeSpec> | undefined;
    entityTypes(): readonly Readonly<EntityTypeSpec>[];
    relationTypes(): readonly Readonly<RelationTypeSpec>[];
}
/** Semver `MAJOR.MINOR.PATCH`, no pre-release or build suffix. */
export declare const SEMVER_PATTERN: RegExp;
export declare function buildOntologyRegistry(mods: DomainModule[], version: string): OntologyRegistry;
