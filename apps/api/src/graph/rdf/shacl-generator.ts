// =============================================================================
// SHACL shapes generator (issue #385, docs/specs/ontology.md §18.2 item 2)
// =============================================================================
//
// The constraints graph data must satisfy, generated from the same registry as
// the OWL vocabulary (`owl-generator.ts`) through the same IRI rules
// (`iris.ts`) — which is what lets an export (#386) validate against its own
// shapes by construction, and an import (#387) detect anything it does not.
//
// One `sh:NodeShape` per entity/item type, `kv:<Type>Shape`:
//
//   sh:targetClass kv:<Type>; sh:closed true — closed by default (§17.1), so
//     an undeclared property is a violation an import can report;
//   sh:ignoredProperties — rdf:type, rdfs:label, the kv: annotations,
//     prov:wasDerivedFrom and the standard properties a relation of this type
//     is aligned to (an export may state `schema:worksFor` beside `kv:WORKS_FOR`);
//   per attribute  — datatype (or class for entity_ref), sh:maxCount 1 unless
//     multi-valued, sh:minCount 1 when required, sh:in for selects,
//     sh:pattern for URLs;
//   per relation from this type — sh:class of its target(s), `sh:or` for
//     several (narrowed by allowedPairs and an item's subjectTypes); an item
//     column (one value by construction) adds sh:maxCount 1, and a required
//     subject sh:minCount 1;
//   per item type  — kv:status sh:in its declared statuses;
//   NO ORPHANS     — prov:wasDerivedFrom sh:minCount 1 on every node shape (§3.3);
//   the caller's own attribute definitions on their type, sensitive ones
//     omitted (never exported, §18.1).
//
// Plus `kv:AssertionShape` for reified temporal edges.
//
// ⚠ PURE. No Nest, no I/O, and no RDF library (§18.4).
// =============================================================================

import {
  VALID_PRECISIONS,
  type AttributeKind,
  type AttributeOptions,
  type EntityTypeSpec,
  type OntologyRegistry,
  type RelationTypeSpec,
  type UserAttributeDef,
} from '@app/shared/ontology';

import {
  PROV,
  RDF,
  RDFS,
  SH,
  XSD,
  alignmentIri,
  annotationIri,
  assertionClassIri,
  assertionShapeIri,
  attributeIri,
  classIri,
  itemStatusIri,
  relationIri,
  relationPropIri,
  shapeIri,
  userAttributeIri,
} from './iris';
import {
  artefactPrefixes,
  describedUserAttributes,
  exportedRelations,
  isMultiValued,
  kindDatatype,
  sortedTypes,
  targetsFrom,
  typeAttributes,
} from './ontology-rdf-model';
import {
  RDF_TYPE,
  bnode,
  iri,
  list,
  literal,
  po,
  writeTurtle,
  type TurtlePredicate,
  type TurtleSubject,
  type TurtleTerm,
} from './turtle-writer';

/** A URL value must be an http(s) URL — the same rule the props validator applies. */
export const URL_PATTERN = '^https?://';

const TRUE = literal('true', { datatype: `${XSD}boolean` });
const int = (n: number) => literal(String(n), { datatype: `${XSD}integer` });
const shIri = iri(`${SH}IRI`);

/** Predicates every node may carry without a shape declaring them. */
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

/** The no-orphans rule (§3.3): every node cites at least one source. */
function derivedFromShape(): TurtleTerm {
  return bnode([po(`${SH}path`, iri(`${PROV}wasDerivedFrom`)), po(`${SH}minCount`, int(1)), po(`${SH}nodeKind`, shIri)]);
}

/** `sh:class` for one target, `sh:or ( [sh:class …] … )` for several. */
function classConstraint(ns: string, targets: readonly string[]): TurtlePredicate[] {
  const keys = [...new Set(targets)].sort();
  if (keys.length === 0) return [];
  if (keys.length === 1) return [po(`${SH}class`, iri(classIri(ns, keys[0])))];
  return [po(`${SH}or`, list(keys.map((k) => bnode([po(`${SH}class`, iri(classIri(ns, k)))]))))];
}

interface ValueRules {
  kind: AttributeKind;
  options?: AttributeOptions | null;
  multiValued: boolean;
  required: boolean;
  name: string;
}

/** A property shape for one attribute value. */
function attributeShape(ns: string, path: string, rules: ValueRules): TurtleTerm {
  const props: TurtlePredicate[] = [po(`${SH}path`, iri(path)), po(`${SH}name`, literal(rules.name))];
  const datatype = kindDatatype(rules.kind);
  if (datatype !== undefined) props.push(po(`${SH}datatype`, iri(datatype)));
  else {
    props.push(po(`${SH}nodeKind`, shIri));
    props.push(...classConstraint(ns, rules.options?.targetTypes ?? []));
  }
  if (!rules.multiValued) props.push(po(`${SH}maxCount`, int(1)));
  if (rules.required) props.push(po(`${SH}minCount`, int(1)));
  if (rules.kind === 'select' || rules.kind === 'multi_select') {
    const choices = rules.options?.choices ?? [];
    if (choices.length > 0) props.push(po(`${SH}in`, list(choices.map((c) => literal(c.value)))));
  }
  if (rules.kind === 'url') props.push(po(`${SH}pattern`, literal(URL_PATTERN)));
  return bnode(props);
}

/** A property shape for a relation starting at `type`, or undefined if it cannot. */
function relationShape(
  ns: string,
  relation: Readonly<RelationTypeSpec>,
  type: Readonly<EntityTypeSpec>,
): TurtleTerm | undefined {
  const targets = targetsFrom(relation, type);
  if (targets.length === 0) return undefined;
  const props: TurtlePredicate[] = [
    po(`${SH}path`, iri(relationIri(ns, relation.key))),
    po(`${SH}name`, literal(relation.label)),
    po(`${SH}nodeKind`, shIri),
    ...classConstraint(ns, targets),
  ];
  const rep = relation.representation;
  if (rep.kind === 'item_column') {
    props.push(po(`${SH}maxCount`, int(1)));
    if (rep.column === 'subject_id' && type.subjectRequired === true) props.push(po(`${SH}minCount`, int(1)));
  }
  return bnode(props);
}

function nodeShape(
  ns: string,
  registry: OntologyRegistry,
  type: Readonly<EntityTypeSpec>,
  relations: readonly Readonly<RelationTypeSpec>[],
  userAttributes: readonly UserAttributeDef[],
): TurtleSubject {
  const properties: TurtleTerm[] = [derivedFromShape()];
  const alignedRelationIris = new Set<string>();

  for (const { key, spec } of typeAttributes(registry, type)) {
    properties.push(
      attributeShape(ns, attributeIri(ns, type.key, key, spec.alignment), {
        kind: spec.kind,
        options: spec.options,
        multiValued: isMultiValued(spec.kind, spec.list),
        required: spec.required === true,
        name: spec.label,
      }),
    );
  }

  for (const relation of relations) {
    const shape = relationShape(ns, relation, type);
    if (shape === undefined) continue;
    properties.push(shape);
    if (relation.alignment !== undefined) alignedRelationIris.add(alignmentIri(relation.alignment));
    if (relation.representation.kind === 'supersedes') alignedRelationIris.add(`${PROV}wasRevisionOf`);
  }

  if (type.itemKind !== undefined && type.statuses !== undefined) {
    properties.push(
      bnode([
        po(`${SH}path`, iri(itemStatusIri(ns))),
        po(`${SH}name`, literal('Status')),
        po(`${SH}datatype`, iri(`${XSD}string`)),
        po(`${SH}maxCount`, int(1)),
        po(`${SH}in`, list(type.statuses.map((s) => literal(s)))),
      ]),
    );
  }

  for (const def of userAttributes) {
    if (def.entityType !== type.key) continue;
    properties.push(
      attributeShape(ns, userAttributeIri(ns, def.id), {
        kind: def.kind,
        options: def.options,
        multiValued: isMultiValued(def.kind, false),
        required: false,
        name: def.label,
      }),
    );
  }

  const ignored = [...baseIgnored(ns), ...[...alignedRelationIris].sort()];
  return {
    subject: shapeIri(ns, type.key),
    props: [
      po(RDF_TYPE, iri(`${SH}NodeShape`)),
      po(`${SH}targetClass`, iri(classIri(ns, type.key))),
      po(`${SH}closed`, TRUE),
      po(`${SH}ignoredProperties`, list(ignored.map((p) => iri(p)))),
      po(`${SH}property`, ...properties),
    ],
  };
}

/**
 * `kv:AssertionShape`: a reified temporal edge names exactly one subject,
 * predicate and object, carries at most one start and end instant and one
 * precision, cites a source, and — for a relation with a required prop, like
 * HAS_ROLE's title — carries that prop whenever its predicate is that relation.
 */
function assertionShape(ns: string, relations: readonly Readonly<RelationTypeSpec>[]): TurtleSubject {
  const reified = relations.filter((r) => r.temporal || Object.keys(r.props).length > 0);
  const properties: TurtleTerm[] = [
    bnode([po(`${SH}path`, iri(`${RDF}subject`)), po(`${SH}minCount`, int(1)), po(`${SH}maxCount`, int(1)), po(`${SH}nodeKind`, shIri)]),
    bnode([
      po(`${SH}path`, iri(`${RDF}predicate`)),
      po(`${SH}minCount`, int(1)),
      po(`${SH}maxCount`, int(1)),
      po(`${SH}in`, list(reified.map((r) => iri(relationIri(ns, r.key))))),
    ]),
    bnode([po(`${SH}path`, iri(`${RDF}object`)), po(`${SH}minCount`, int(1)), po(`${SH}maxCount`, int(1)), po(`${SH}nodeKind`, shIri)]),
    bnode([po(`${SH}path`, iri(`${PROV}startedAtTime`)), po(`${SH}datatype`, iri(`${XSD}dateTime`)), po(`${SH}maxCount`, int(1))]),
    bnode([po(`${SH}path`, iri(`${PROV}endedAtTime`)), po(`${SH}datatype`, iri(`${XSD}dateTime`)), po(`${SH}maxCount`, int(1))]),
    bnode([
      po(`${SH}path`, iri(annotationIri(ns, 'validPrecision'))),
      po(`${SH}datatype`, iri(`${XSD}string`)),
      po(`${SH}maxCount`, int(1)),
      po(`${SH}in`, list(VALID_PRECISIONS.map((p) => literal(p)))),
    ]),
    derivedFromShape(),
  ];

  const requiredProps: TurtleTerm[] = [];
  for (const relation of reified) {
    for (const [key, spec] of Object.entries(relation.props)) {
      const path = relationPropIri(ns, relation.key, key, spec.alignment);
      properties.push(
        attributeShape(ns, path, {
          kind: spec.kind,
          options: spec.options,
          multiValued: isMultiValued(spec.kind, spec.list),
          required: false,
          name: spec.label,
        }),
      );
      if (spec.required === true) {
        // Either this assertion is not about `relation`, or it carries the prop.
        requiredProps.push(
          list([
            bnode([po(`${SH}not`, bnode([po(`${SH}path`, iri(`${RDF}predicate`)), po(`${SH}hasValue`, iri(relationIri(ns, relation.key)))]))]),
            bnode([po(`${SH}path`, iri(path)), po(`${SH}minCount`, int(1))]),
          ]),
        );
      }
    }
  }

  const ignored = baseIgnored(ns).filter((p) => p !== `${PROV}wasDerivedFrom`);
  const props: TurtlePredicate[] = [
    po(RDF_TYPE, iri(`${SH}NodeShape`)),
    po(`${SH}targetClass`, iri(assertionClassIri(ns))),
    po(`${SH}closed`, TRUE),
    po(`${SH}ignoredProperties`, list(ignored.map((p) => iri(p)))),
    po(`${SH}property`, ...properties),
  ];
  if (requiredProps.length > 0) props.push(po(`${SH}or`, ...requiredProps));
  return { subject: assertionShapeIri(ns), props };
}

/**
 * SHACL shapes for every type and exported relation in `registry` (all
 * domains), plus the caller's own non-sensitive attribute definitions.
 */
export function generateShacl(
  registry: OntologyRegistry,
  userAttributes: readonly UserAttributeDef[],
  ns: string,
): string {
  const relations = exportedRelations(registry);
  const described = describedUserAttributes(registry, userAttributes);
  const subjects: TurtleSubject[] = sortedTypes(registry).map((type) =>
    nodeShape(ns, registry, type, relations, described),
  );
  subjects.push(assertionShape(ns, relations));
  return writeTurtle({ prefixes: artefactPrefixes(ns), subjects });
}
