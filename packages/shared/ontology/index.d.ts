export { ATTRIBUTE_KINDS, DEFAULT_ENABLED_DOMAINS, DOMAIN_KEYS, ITEM_KINDS, PSEUDO_TYPES, SENSITIVITIES, USER_ATTRIBUTE_KEY_PREFIX, VALID_PRECISIONS, } from './constants.js';
export type { AttributeChoice, AttributeKind, AttributeOptions, AttributeSpec, Deprecation, DomainKey, DomainMixin, DomainModule, EntityTypeSpec, KgItemKind, PseudoType, RelationRepresentation, RelationTypeSpec, Sensitivity, UserAttributeDef, ValidPrecision, } from './types.js';
export { defineDomain, defineEntityType, defineRelationType, OntologyDefinitionError } from './define.js';
export { CHANGELOG, ONTOLOGY_VERSION } from './version.js';
export type { OntologyChangelogEntry } from './version.js';
export { SHIPPED_KEYS } from './shipped-keys.js';
export { buildOntologyRegistry } from './registry.js';
export type { OntologyRegistry } from './registry.js';
export { toEffectiveSchemaPayload } from './effective-schema.js';
export type { ComputeEffectiveSchemaInput, EffectiveAttribute, EffectiveAttributePayload, EffectiveDomainPayload, EffectiveEntityType, EffectiveEntityTypePayload, EffectiveRelationType, EffectiveRelationTypePayload, EffectiveSchema, EffectiveSchemaPayload, } from './effective-schema.js';
import type { OntologyRegistry } from './registry.js';
import type { ComputeEffectiveSchemaInput, EffectiveSchema } from './effective-schema.js';
export declare const ONTOLOGY: OntologyRegistry;
/**
 * One user's effective schema: `core` plus their enabled domains, mixins and
 * their own attribute defs. `registry` defaults to `ONTOLOGY`. (Defined here
 * rather than in effective-schema.ts so that file never imports this one.)
 */
export declare function computeEffectiveSchema(input: ComputeEffectiveSchemaInput): EffectiveSchema;
