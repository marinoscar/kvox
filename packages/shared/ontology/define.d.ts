import type { AttributeSpec, DomainModule, EntityTypeSpec, RelationTypeSpec } from './types.js';
/** Thrown for any ontology declaration that breaks a rule. Names the key. */
export declare class OntologyDefinitionError extends Error {
    constructor(message: string);
}
export declare const ENTITY_TYPE_KEY_PATTERN: RegExp;
export declare const RELATION_TYPE_KEY_PATTERN: RegExp;
export declare const ATTRIBUTE_KEY_PATTERN: RegExp;
/** Recursively freezes a plain-data declaration. */
export declare function deepFreeze<T>(value: T): Readonly<T>;
/**
 * Validates one attribute declaration (built-in, mixin or relation prop).
 * `owner` is the `Type.attr` / `RELATION.prop` name used in every message.
 */
export declare function assertAttributeSpec(owner: string, key: string, spec: AttributeSpec): void;
export declare function defineEntityType(spec: EntityTypeSpec): Readonly<EntityTypeSpec>;
export declare function defineRelationType(spec: RelationTypeSpec): Readonly<RelationTypeSpec>;
export declare function defineDomain(mod: DomainModule): Readonly<DomainModule>;
