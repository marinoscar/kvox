// =============================================================================
// What the OWL/RDFS and SHACL generators both read from the registry
// (issue #385, docs/specs/ontology.md §18.1, §18.2)
// =============================================================================
//
// The two generators must agree on every decision that is not a matter of
// output syntax — which attributes a type has once every domain's mixins are
// merged in, which relations are exported at all, which classes a relation may
// point at from a given type, which XSD datatype an attribute kind maps to,
// which user attributes never leave the deployment. Each of those lives here,
// once, so the vocabulary and the shapes cannot drift from each other.
//
// ⚠ PURE. No Nest, no I/O.
// =============================================================================

import {
  KV_PREFIX,
  PSEUDO_TYPES,
  RDF_PREFIXES,
  type AttributeKind,
  type AttributeSpec,
  type EntityTypeSpec,
  type OntologyRegistry,
  type RelationTypeSpec,
  type UserAttributeDef,
} from '@app/shared/ontology';

import { XSD } from './iris';

/** Every prefix an artefact declares: `kv:` plus the standard vocabularies. */
export function artefactPrefixes(ns: string): Record<string, string> {
  return { [KV_PREFIX]: ns, ...RDF_PREFIXES };
}

/** An attribute of a type, from its own declaration or another domain's mixin. */
export interface TypeAttribute {
  readonly key: string;
  readonly spec: Readonly<AttributeSpec>;
}

/**
 * A type's attributes across **every** domain in the registry — its own plus
 * every mixin onto it — sorted by key. All domains, not the caller's enabled
 * ones: the artefacts describe every row that can exist, including rows of a
 * domain its owner later switched off.
 */
export function typeAttributes(registry: OntologyRegistry, type: Readonly<EntityTypeSpec>): TypeAttribute[] {
  const out: TypeAttribute[] = Object.entries(type.attributes).map(([key, spec]) => ({ key, spec }));
  for (const domain of registry.domains()) {
    for (const mixin of domain.mixins) {
      if (mixin.entityType !== type.key) continue;
      for (const [key, spec] of Object.entries(mixin.attributes)) out.push({ key, spec });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Representations that are never exported as RDF properties (§18.1): a
 * speaker link (speakers are not exported), a mention (coarse, not a claim),
 * and evidence (exported as `prov:wasDerivedFrom` + `oa:Annotation` instead).
 * Today that is IDENTIFIED_AS, MENTIONS and SUPPORTED_BY. A relation type
 * declaring `sensitivityDefault: 'sensitive'` is never exported either (none
 * does today).
 */
const UNEXPORTED_REPRESENTATIONS: ReadonlySet<string> = new Set(['speaker_link', 'mention', 'evidence']);

export function isExportedRelation(relation: Readonly<RelationTypeSpec>): boolean {
  if (UNEXPORTED_REPRESENTATIONS.has(relation.representation.kind)) return false;
  // §5.6/§18.1: `sensitive` data never leaves the deployment, so a relation
  // type declaring it (#383's `sensitivityDefault`) is never described either.
  // `personal` is not `sensitive`: the personal domain's relations ARE exported.
  return relation.sensitivityDefault !== 'sensitive';
}

export function exportedRelations(registry: OntologyRegistry): Readonly<RelationTypeSpec>[] {
  return registry
    .relationTypes()
    .filter(isExportedRelation)
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const isPseudo = (key: string) => (PSEUDO_TYPES as readonly string[]).includes(key);

/** A relation's `from` types that are real graph types. */
export function relationSources(relation: Readonly<RelationTypeSpec>): string[] {
  return relation.from.filter((key) => !isPseudo(key));
}

/** A relation's `to` types that are real graph types. */
export function relationTargets(relation: Readonly<RelationTypeSpec>): string[] {
  return relation.to.filter((key) => !isPseudo(key));
}

/**
 * The classes a relation may point at **from one type** — `allowedPairs`
 * narrowed to that type when declared (PART_OF, SUPERSEDES), and for an item's
 * `subject_id` column additionally narrowed to the item's `subjectTypes`
 * (PersonFact is ABOUT a Person only). Empty when the type is not a source.
 */
export function targetsFrom(relation: Readonly<RelationTypeSpec>, type: Readonly<EntityTypeSpec>): string[] {
  if (!relation.from.includes(type.key)) return [];
  let targets = relation.allowedPairs
    ? relation.allowedPairs.filter(([from]) => from === type.key).map(([, to]) => to)
    : relationTargets(relation);
  if (
    relation.representation.kind === 'item_column' &&
    relation.representation.column === 'subject_id' &&
    type.subjectTypes !== undefined
  ) {
    const subjects = new Set(type.subjectTypes);
    targets = targets.filter((t) => subjects.has(t));
  }
  return [...new Set(targets)].filter((t) => !isPseudo(t)).sort();
}

/** The XSD datatype an attribute kind is stored as; `undefined` for `entity_ref`. */
export function kindDatatype(kind: AttributeKind): string | undefined {
  switch (kind) {
    case 'text':
    case 'select':
    case 'multi_select':
      return `${XSD}string`;
    case 'number':
      return `${XSD}decimal`;
    case 'date':
      return `${XSD}date`;
    case 'boolean':
      return `${XSD}boolean`;
    case 'url':
      return `${XSD}anyURI`;
    case 'entity_ref':
      return undefined;
  }
}

/** True when a value of this attribute may hold several values. */
export function isMultiValued(kind: AttributeKind, list: boolean | undefined): boolean {
  return kind === 'multi_select' || list === true;
}

/**
 * The caller's attribute definitions that the artefacts describe: those on a
 * type the registry knows, **minus every `sensitive` one** — a sensitive
 * attribute is never exported under any setting (§5.6, §18.1), so neither its
 * shape nor its label ever appears in an artefact. Deprecated definitions stay:
 * existing rows still carry their values. Sorted by id.
 */
export function describedUserAttributes(
  registry: OntologyRegistry,
  userAttributes: readonly UserAttributeDef[],
): UserAttributeDef[] {
  return userAttributes
    .filter((def) => {
      const type = registry.entityType(def.entityType);
      if (type === undefined) return false;
      return (def.sensitivity ?? type.sensitivityDefault) !== 'sensitive';
    })
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Entity and item types, sorted by key. */
export function sortedTypes(registry: OntologyRegistry): Readonly<EntityTypeSpec>[] {
  return registry
    .entityTypes()
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
