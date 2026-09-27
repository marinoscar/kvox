// =============================================================================
// What an import may say about each node — the closed vocabulary (#387,
// docs/specs/ontology.md §17.1, §18.2, §18.3)
// =============================================================================
//
// For every type: the predicates its generated SHACL shape admits — its
// `sh:property` paths plus its `sh:ignoredProperties` — built through the SAME
// IRI rules (`rdf/iris.ts`) and registry helpers (`rdf/ontology-rdf-model.ts`)
// `shacl-generator.ts` uses. Anything else on a node of that type is an
// UNKNOWN property: the pre-pass (`unknown-properties.ts`) offers it as an
// attribute definition and removes it before validation, rather than letting
// the closed shape fail the whole file over it.
//
// `test/graph/rdf/import-vocabulary.spec.ts` parses the generated shapes and
// checks this table against them shape by shape, so the two cannot drift.
//
// ⚠ PURE. No Nest, no I/O, no RDF library.
// =============================================================================

import type { EntityTypeSpec, OntologyRegistry, UserAttributeDef } from '@app/shared/ontology';

import {
  PROV,
  RDF,
  RDFS,
  SKOS,
  alignmentIri,
  annotationIri,
  assertionClassIri,
  attributeIri,
  classIri,
  dueAtIri,
  itemStatementIri,
  itemStatusIri,
  occurredAtIri,
  relationIri,
  relationPropIri,
  userAttributeIri,
} from '../rdf/iris';
import { describedUserAttributes, exportedRelations, reifiedRelations, targetsFrom, typeAttributes } from '../rdf/ontology-rdf-model';

export interface ImportVocabulary {
  /** `kv:<Type>` → the type. Entity and item types, every domain. */
  readonly classes: ReadonlyMap<string, Readonly<EntityTypeSpec>>;
  /** `kv:Assertion`. */
  readonly assertionClass: string;
  /** Type key → every predicate its shape admits. */
  readonly allowed: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every predicate `kv:AssertionShape` admits. */
  readonly assertionAllowed: ReadonlySet<string>;
}

/** Predicates every node shape ignores (`shacl-generator.ts`'s `baseIgnored`). */
function baseIgnored(ns: string): string[] {
  return [
    `${RDF}type`,
    `${RDFS}label`,
    annotationIri(ns, 'reviewStatus'),
    annotationIri(ns, 'confidence'),
    annotationIri(ns, 'ontologyVersion'),
    `${PROV}wasDerivedFrom`,
  ];
}

export function buildImportVocabulary(
  registry: OntologyRegistry,
  userAttributes: readonly UserAttributeDef[],
  ns: string,
): ImportVocabulary {
  const relations = exportedRelations(registry);
  const described = describedUserAttributes(registry, userAttributes);
  const classes = new Map<string, Readonly<EntityTypeSpec>>();
  const allowed = new Map<string, Set<string>>();

  for (const type of registry.entityTypes()) {
    classes.set(classIri(ns, type.key), type);
    const set = new Set<string>([...baseIgnored(ns), occurredAtIri(ns)]);
    if (type.itemKind !== undefined) {
      set.add(itemStatementIri(ns, type.key));
      set.add(dueAtIri(ns));
      set.add(`${PROV}startedAtTime`);
      set.add(`${PROV}endedAtTime`);
      set.add(annotationIri(ns, 'validPrecision'));
      if (type.statuses !== undefined) set.add(itemStatusIri(ns));
    } else {
      set.add(`${SKOS}altLabel`);
    }
    for (const { key, spec } of typeAttributes(registry, type)) set.add(attributeIri(ns, type.key, key, spec.alignment));
    for (const relation of relations) {
      if (targetsFrom(relation, type).length === 0) continue;
      set.add(relationIri(ns, relation.key));
      if (relation.alignment !== undefined) set.add(alignmentIri(relation.alignment));
      if (relation.representation.kind === 'supersedes') set.add(`${PROV}wasRevisionOf`);
    }
    for (const def of described) if (def.entityType === type.key) set.add(userAttributeIri(ns, def.id));
    allowed.set(type.key, set);
  }

  const assertionAllowed = new Set<string>([
    ...baseIgnored(ns),
    `${RDF}subject`,
    `${RDF}predicate`,
    `${RDF}object`,
    `${PROV}startedAtTime`,
    `${PROV}endedAtTime`,
    annotationIri(ns, 'validPrecision'),
  ]);
  for (const relation of reifiedRelations(registry)) {
    for (const [key, spec] of Object.entries(relation.props)) {
      assertionAllowed.add(relationPropIri(ns, relation.key, key, spec.alignment));
    }
  }

  return { classes, assertionClass: assertionClassIri(ns), allowed, assertionAllowed };
}
