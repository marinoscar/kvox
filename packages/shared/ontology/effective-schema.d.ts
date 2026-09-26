import type { DomainKey, EffectiveAttribute, EffectiveEntityType, EffectiveRelationType, EffectiveSchema, EffectiveSchemaPayload, OntologyRegistry, UserAttributeDef } from './types.js';
export interface ComputeEffectiveSchemaInput {
    /** Default: `ONTOLOGY`. */
    registry?: OntologyRegistry;
    /** Domains the caller has enabled. Always-on domains (`core`) are forced in. */
    enabledDomains: readonly DomainKey[];
    /** The caller's own `kg_attribute_defs` rows, as plain data. */
    userAttributes: readonly UserAttributeDef[];
}
/**
 * Resolves one caller's effective schema. Throws `OntologyDefinitionError`
 * for a malformed user attribute definition (a bad key or kind, or a key used
 * twice on one type). A definition for a type the caller does not currently
 * have (its domain is off) is legitimately skipped, not an error.
 */
export declare function computeEffectiveSchema(input: ComputeEffectiveSchemaInput): EffectiveSchema;
/** The JSON-safe wire form: plain, unfrozen, no maps, no `undefined`. */
export declare function toEffectiveSchemaPayload(schema: EffectiveSchema): EffectiveSchemaPayload;
/** Looks up an entity type, or a relation type when `relation` is true. */
export declare function lookupEffectiveType(schema: EffectiveSchema, typeKey: string, relation: boolean): EffectiveEntityType | EffectiveRelationType | undefined;
/** The attributes (entity) or props (relation) of a resolved type. */
export declare function effectiveAttributesOf(type: EffectiveEntityType | EffectiveRelationType): readonly EffectiveAttribute[];
