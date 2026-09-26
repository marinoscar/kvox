// =============================================================================
// `@app/shared/ontology` -- the ontology definition (issue #350, epic #344)
// =============================================================================
//
// The single TypeScript + Zod declaration of the knowledge-graph ontology
// that `apps/api` validates and extracts against and `apps/web` renders forms
// from (docs/specs/ontology.md §17). Sources live in
// `packages/shared/src/ontology/`; the committed CommonJS + .d.ts under
// `packages/shared/ontology/` is what consumers load. After editing a source,
// run `npm run build:ontology --workspace=@app/shared` and commit the output
// in the same commit -- CI fails otherwise. See packages/shared/README.md.
//
// Web code imports TYPES and small constants from here; its forms render from
// the `GET /api/graph/ontology` payload, never from `ONTOLOGY` directly,
// because a user's effective schema includes their own attribute definitions.
// =============================================================================

export {
  ATTRIBUTE_KINDS,
  DEFAULT_ENABLED_DOMAINS,
  DOMAIN_KEYS,
  ITEM_KINDS,
  PSEUDO_TYPES,
  SENSITIVITIES,
  USER_ATTRIBUTE_KEY_PREFIX,
  VALID_PRECISIONS,
} from './constants.js';
export { CHANGELOG, ONTOLOGY_VERSION } from './version.js';
export type { OntologyChangelogEntry } from './version.js';
export { SHIPPED_KEYS } from './shipped-keys.js';

export type {
  AttributeKind,
  AttributeOptions,
  AttributeSpec,
  DomainKey,
  DomainModule,
  EffectiveAttribute,
  EffectiveAttributePayload,
  EffectiveDomainPayload,
  EffectiveEntityType,
  EffectiveEntityTypePayload,
  EffectiveRelationType,
  EffectiveRelationTypePayload,
  EffectiveSchema,
  EffectiveSchemaPayload,
  EntityTypeSpec,
  KgItemKind,
  OntologyRegistry,
  PropsIssue,
  RelationRepresentation,
  RelationTypeSpec,
  Sensitivity,
  UserAttributeDef,
  ValidatePropsResult,
  ValidPrecision,
} from './types.js';

export { OntologyDefinitionError, defineDomain, defineEntityType, defineRelationType } from './define.js';
export { ONTOLOGY, buildOntologyRegistry } from './registry.js';
export { computeEffectiveSchema, toEffectiveSchemaPayload } from './effective-schema.js';
export type { ComputeEffectiveSchemaInput } from './effective-schema.js';
export { buildPropsSchema, validateProps } from './props-schema.js';
export { buildPropsJsonSchema, extractableEntityTypes, extractableRelationTypes } from './json-schema.js';
