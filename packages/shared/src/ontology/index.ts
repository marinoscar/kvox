// =============================================================================
// `@app/shared/ontology` — the ontology definition (docs/specs/ontology.md §17).
//
// Sources: packages/shared/src/ontology/**/*.ts. Compiled, committed output:
// packages/shared/ontology/. Rebuild with
// `npm run build:ontology --workspace=@app/shared` after any source edit; CI
// fails when the committed output is stale.
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

export type {
  AttributeChoice,
  AttributeKind,
  AttributeOptions,
  AttributeSpec,
  Deprecation,
  DomainKey,
  DomainMixin,
  DomainModule,
  EntityTypeSpec,
  KgItemKind,
  PseudoType,
  RelationRepresentation,
  RelationTypeSpec,
  Sensitivity,
  UserAttributeDef,
  ValidPrecision,
} from './types.js';

export { defineDomain, defineEntityType, defineRelationType, OntologyDefinitionError } from './define.js';

export { CHANGELOG, ONTOLOGY_VERSION } from './version.js';
export type { OntologyChangelogEntry } from './version.js';
export { SHIPPED_KEYS } from './shipped-keys.js';
export { buildOntologyRegistry } from './registry.js';
export type { OntologyRegistry } from './registry.js';
export { toEffectiveSchemaPayload } from './effective-schema.js';
export { buildPropsSchema, validateProps } from './props-schema.js';
export type { BuildPropsSchemaOptions, PropsIssue, PropsPurpose, ValidatePropsResult } from './props-schema.js';
export { buildPropsJsonSchema, extractableEntityTypes, extractableRelationTypes } from './json-schema.js';
export type {
  ComputeEffectiveSchemaInput,
  EffectiveAttribute,
  EffectiveAttributePayload,
  EffectiveDomainPayload,
  EffectiveEntityType,
  EffectiveEntityTypePayload,
  EffectiveRelationType,
  EffectiveRelationTypePayload,
  EffectiveSchema,
  EffectiveSchemaPayload,
} from './effective-schema.js';

// -----------------------------------------------------------------------------
// The domain modules, listed EXPLICITLY — never self-registered by import side
// effect (registration order under Vite pre-bundling vs Jest `require` is not
// something to depend on). Adding a domain is one import and one entry here.
// -----------------------------------------------------------------------------

import { coreDomain } from './domains/core.js';
import { workDomain } from './domains/work.js';
import { buildOntologyRegistry } from './registry.js';
import type { OntologyRegistry } from './registry.js';
import { ONTOLOGY_VERSION } from './version.js';
import { computeEffectiveSchemaFor } from './effective-schema.js';
import type { ComputeEffectiveSchemaInput, EffectiveSchema } from './effective-schema.js';

export const ONTOLOGY: OntologyRegistry = buildOntologyRegistry([coreDomain, workDomain], ONTOLOGY_VERSION);

/**
 * One user's effective schema: `core` plus their enabled domains, mixins and
 * their own attribute defs. `registry` defaults to `ONTOLOGY`. (Defined here
 * rather than in effective-schema.ts so that file never imports this one.)
 */
export function computeEffectiveSchema(input: ComputeEffectiveSchemaInput): EffectiveSchema {
  return computeEffectiveSchemaFor(input.registry ?? ONTOLOGY, input);
}
