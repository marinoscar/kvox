// =============================================================================
// `@marinoscar/kvox-contract/ontology` — the ontology definition
// (docs/specs/ontology.md §17).
//
// Moved here from `packages/shared/src/ontology` (issue #488). `@app/shared/ontology`
// is a thin re-export of this entry point. There is no committed compiled output
// any more: `npm run build --workspace=@marinoscar/kvox-contract` builds it.
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
export { KV_PREFIX, RDF_PREFIXES, expandCurie, kvNamespace } from './rdf-namespaces.js';
export type { RdfPrefix } from './rdf-namespaces.js';
export type { OntologyChangelogEntry } from './version.js';
export { SHIPPED_KEYS } from './shipped-keys.js';
export { buildOntologyRegistry } from './registry.js';
export type { OntologyRegistry } from './registry.js';
export { toEffectiveSchemaPayload } from './effective-schema.js';
export { buildPropsSchema, validateProps } from './props-schema.js';
export type { BuildPropsSchemaOptions, PropsIssue, PropsPurpose, ValidatePropsResult } from './props-schema.js';
export {
  ONTOLOGY_MIGRATIONS,
  applyMigrationSteps,
  checkOntologyMigrations,
  compareOntologyVersions,
  isMajorOntologyVersion,
  isOntologyVersion,
  migrationsBetween,
  parseOntologyVersion,
} from './migrations.js';
export type {
  ApplyMigrationStepsResult,
  CheckOntologyMigrationsInput,
  MigratableRow,
  OntologyMigration,
  OntologyMigrationStep,
} from './migrations.js';
export { buildPropsJsonSchema, extractableEntityTypes, extractableRelationTypes } from './json-schema.js';
export type {
  ComputeEffectiveSchemaInput,
  DeepReadonly,
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
import { personalDomain } from './domains/personal.js';
import { buildOntologyRegistry } from './registry.js';
import type { OntologyRegistry } from './registry.js';
import { ONTOLOGY_VERSION } from './version.js';
import { computeEffectiveSchemaFor } from './effective-schema.js';
import type { ComputeEffectiveSchemaInput, EffectiveSchema } from './effective-schema.js';

/**
 * The shipped ontology: the `core`, `work` and `personal` domain modules at
 * {@link ONTOLOGY_VERSION}.
 *
 * @stability experimental
 */
export const ONTOLOGY: OntologyRegistry = buildOntologyRegistry(
  [coreDomain, workDomain, personalDomain],
  ONTOLOGY_VERSION,
);

/**
 * One user's effective schema: `core` plus their enabled domains, mixins and
 * their own attribute defs. `registry` defaults to `ONTOLOGY`. (Defined here
 * rather than in effective-schema.ts so that file never imports this one.)
 *
 * @stability experimental
 */
export function computeEffectiveSchema(input: ComputeEffectiveSchemaInput): EffectiveSchema {
  return computeEffectiveSchemaFor(input.registry ?? ONTOLOGY, input);
}
