// =============================================================================
// OWL/RDFS generator (issue #385, docs/specs/ontology.md §18.1, §18.2 item 1)
// =============================================================================
//
// The vocabulary, generated from the ontology definition file — never
// hand-maintained beside it (§18.2), so it cannot drift from the live schema
// or from the SHACL shapes generated from the same registry next door.
//
//   <ns>           a owl:Ontology; owl:versionInfo <registry version>
//   kv:<Type>      a owl:Class; rdfs:subClassOf <alignment>
//   kv:<Type>.<a>  a owl:DatatypeProperty | owl:ObjectProperty (entity_ref)
//   kv:<REL>       a owl:ObjectProperty (+ owl:SymmetricProperty when the
//                  relation declares `symmetric`, #383); rdfs:subPropertyOf <alignment>
//   kv:attr/<id>   the caller's own attribute definitions
//
// ALIGNMENTS ARE `rdfs:subClassOf` / `rdfs:subPropertyOf`, NEVER EQUIVALENCE:
// a `kv:Person` row is a `schema:Person`, not the other way round.
//
// AN ALIGNED ATTRIBUTE IS THE STANDARD PROPERTY ITSELF (iris.ts), so this file
// never asserts `rdfs:domain`/`rdfs:range` on it: stating `schema:jobTitle
// rdfs:domain kv:Person` would claim that everything with a job title anywhere
// on the web is one of our Person rows. It uses Schema.org's own non-inferring
// `schema:domainIncludes`/`schema:rangeIncludes` instead.
//
// Not emitted as properties: IDENTIFIED_AS, MENTIONS, SUPPORTED_BY
// (`isExportedRelation`). Deterministic: byte-identical output for identical
// input (`turtle-writer.ts` sorts everything).
//
// ⚠ PURE. No Nest, no I/O, and no RDF library (§18.4).
// =============================================================================

import { APP_NAME } from '@app/shared';
import type {
  AttributeKind,
  AttributeOptions,
  OntologyRegistry,
  RelationTypeSpec,
  UserAttributeDef,
} from '@app/shared/ontology';

import {
  ANNOTATION_PROPERTIES,
  OWL,
  PROV,
  RDF,
  RDFS,
  XSD,
  alignmentIri,
  annotationIri,
  assertionClassIri,
  attributeIri,
  classIri,
  itemStatusIri,
  relationIri,
  relationPropIri,
  userAttributeIri,
  type AnnotationProperty,
} from './iris';
import {
  artefactPrefixes,
  describedUserAttributes,
  exportedRelations,
  kindDatatype,
  relationSources,
  relationTargets,
  sortedTypes,
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

const SCHEMA = 'https://schema.org/';
const TRUE = literal('true', { datatype: `${XSD}boolean` });

const ANNOTATION_COPY: Record<AnnotationProperty, { label: string; comment: string }> = {
  reviewStatus: {
    label: 'Review status',
    comment: 'Where a graph row stands in the review lifecycle (accepted or edited, for anything exported).',
  },
  confidence: { label: 'Confidence', comment: 'The extraction confidence recorded for a graph row, between 0 and 1.' },
  ontologyVersion: { label: 'Ontology version', comment: 'The ontology version a graph row was written against.' },
  validPrecision: {
    label: 'Valid precision',
    comment: 'How exact the source was about a validity range: day, month, year or unknown.',
  },
};

/** One class, or an anonymous `owl:unionOf` class for several. */
function classOrUnion(ns: string, typeKeys: readonly string[]): TurtleTerm | undefined {
  const keys = [...new Set(typeKeys)].sort();
  if (keys.length === 0) return undefined;
  if (keys.length === 1) return iri(classIri(ns, keys[0]));
  return bnode([po(RDF_TYPE, iri(`${OWL}Class`)), po(`${OWL}unionOf`, list(keys.map((k) => iri(classIri(ns, k)))))]);
}

function propertyClass(kind: AttributeKind): string {
  return kind === 'entity_ref' ? `${OWL}ObjectProperty` : `${OWL}DatatypeProperty`;
}

/** The range of an attribute: its XSD datatype, or its `entity_ref` target class(es). */
function rangeTerms(ns: string, kind: AttributeKind, options: AttributeOptions | null | undefined): TurtleTerm[] {
  const datatype = kindDatatype(kind);
  if (datatype !== undefined) return [iri(datatype)];
  return (options?.targetTypes ?? []).map((t) => iri(classIri(ns, t)));
}

/**
 * Domain and range statements for one attribute property. `aligned` switches
 * to the non-inferring Schema.org form (see the header).
 */
function domainAndRange(
  ns: string,
  domainTypes: readonly string[],
  kind: AttributeKind,
  options: AttributeOptions | null | undefined,
  aligned: boolean,
): TurtlePredicate[] {
  const ranges = rangeTerms(ns, kind, options);
  if (aligned) {
    return [
      po(`${SCHEMA}domainIncludes`, ...domainTypes.map((t) => iri(classIri(ns, t)))),
      po(`${SCHEMA}rangeIncludes`, ...ranges),
    ];
  }
  const out: TurtlePredicate[] = [];
  const domain = classOrUnion(ns, domainTypes);
  if (domain !== undefined) out.push(po(`${RDFS}domain`, domain));
  if (ranges.length === 1) out.push(po(`${RDFS}range`, ranges[0]));
  else if (ranges.length > 1) {
    const union = classOrUnion(ns, options?.targetTypes ?? []);
    if (union !== undefined) out.push(po(`${RDFS}range`, union));
  }
  return out;
}

function relationSubject(ns: string, relation: Readonly<RelationTypeSpec>): TurtleSubject {
  const props: TurtlePredicate[] = [
    // #383: a symmetric relation (SPOUSE_OF, FRIEND_OF) is stored once, and
    // `(a, b)` states `(b, a)` too — exactly OWL's owl:SymmetricProperty.
    relation.symmetric === true
      ? po(RDF_TYPE, iri(`${OWL}ObjectProperty`), iri(`${OWL}SymmetricProperty`))
      : po(RDF_TYPE, iri(`${OWL}ObjectProperty`)),
    po(`${RDFS}label`, literal(relation.label)),
    po(`${RDFS}comment`, literal(relation.description)),
  ];
  const domain = classOrUnion(ns, relationSources(relation));
  if (domain !== undefined) props.push(po(`${RDFS}domain`, domain));
  const range = classOrUnion(ns, relationTargets(relation));
  if (range !== undefined) props.push(po(`${RDFS}range`, range));
  if (relation.alignment !== undefined) props.push(po(`${RDFS}subPropertyOf`, iri(alignmentIri(relation.alignment))));
  // A newer decision/claim/commitment replacing an older one is PROV-O's revision.
  if (relation.representation.kind === 'supersedes') props.push(po(`${RDFS}subPropertyOf`, iri(`${PROV}wasRevisionOf`)));
  if (relation.deprecated !== undefined) props.push(po(`${OWL}deprecated`, TRUE));
  return { subject: relationIri(ns, relation.key), props };
}

/**
 * The OWL/RDFS vocabulary for every type, attribute and exported relation in
 * `registry` (all domains), plus the caller's own non-sensitive attribute
 * definitions (deprecated ones flagged `owl:deprecated`).
 */
export function generateOwl(
  registry: OntologyRegistry,
  userAttributes: readonly UserAttributeDef[],
  ns: string,
): string {
  const subjects: TurtleSubject[] = [];
  const types = sortedTypes(registry);

  subjects.push({
    subject: ns,
    props: [
      po(RDF_TYPE, iri(`${OWL}Ontology`)),
      po(`${OWL}versionInfo`, literal(registry.version)),
      po(`${RDFS}label`, literal(`${APP_NAME} ontology`)),
    ],
  });

  // --- Classes and their built-in attributes ---------------------------------
  for (const type of types) {
    const props: TurtlePredicate[] = [
      po(RDF_TYPE, iri(`${OWL}Class`)),
      po(`${RDFS}label`, literal(type.label)),
      po(`${RDFS}comment`, literal(type.description)),
    ];
    if (type.alignment !== undefined) props.push(po(`${RDFS}subClassOf`, iri(alignmentIri(type.alignment))));
    if (type.deprecated !== undefined) props.push(po(`${OWL}deprecated`, TRUE));
    subjects.push({ subject: classIri(ns, type.key), props });

    for (const { key, spec } of typeAttributes(registry, type)) {
      const attrProps: TurtlePredicate[] = [
        po(RDF_TYPE, iri(propertyClass(spec.kind))),
        po(`${RDFS}label`, literal(spec.label)),
        po(`${RDFS}comment`, literal(spec.description)),
        ...domainAndRange(ns, [type.key], spec.kind, spec.options, spec.alignment !== undefined),
      ];
      if (spec.deprecated !== undefined) attrProps.push(po(`${OWL}deprecated`, TRUE));
      subjects.push({ subject: attributeIri(ns, type.key, key, spec.alignment), props: attrProps });
    }
  }

  // --- Item status ----------------------------------------------------------
  const itemTypes = types.filter((t) => t.itemKind !== undefined).map((t) => t.key);
  if (itemTypes.length > 0) {
    const domain = classOrUnion(ns, itemTypes);
    subjects.push({
      subject: itemStatusIri(ns),
      props: [
        po(RDF_TYPE, iri(`${OWL}DatatypeProperty`)),
        po(`${RDFS}label`, literal('Status')),
        po(`${RDFS}comment`, literal("An item's lifecycle status: one of the statuses its type declares.")),
        ...(domain !== undefined ? [po(`${RDFS}domain`, domain)] : []),
        po(`${RDFS}range`, iri(`${XSD}string`)),
      ],
    });
  }

  // --- Relations, their props, and the reified assertion -------------------
  const relations = exportedRelations(registry);
  for (const relation of relations) {
    subjects.push(relationSubject(ns, relation));
    for (const [key, spec] of Object.entries(relation.props)) {
      const propProps: TurtlePredicate[] = [
        po(RDF_TYPE, iri(propertyClass(spec.kind))),
        po(`${RDFS}label`, literal(spec.label)),
        po(`${RDFS}comment`, literal(spec.description)),
      ];
      if (spec.alignment !== undefined) {
        propProps.push(po(`${SCHEMA}domainIncludes`, iri(assertionClassIri(ns))));
        propProps.push(po(`${SCHEMA}rangeIncludes`, ...rangeTerms(ns, spec.kind, spec.options)));
      } else {
        propProps.push(po(`${RDFS}domain`, iri(assertionClassIri(ns))));
        const range = rangeTerms(ns, spec.kind, spec.options);
        if (range.length === 1) propProps.push(po(`${RDFS}range`, range[0]));
      }
      if (spec.deprecated !== undefined) propProps.push(po(`${OWL}deprecated`, TRUE));
      subjects.push({ subject: relationPropIri(ns, relation.key, key, spec.alignment), props: propProps });
    }
  }

  subjects.push({
    subject: assertionClassIri(ns),
    props: [
      po(RDF_TYPE, iri(`${OWL}Class`)),
      po(`${RDFS}label`, literal('Assertion')),
      po(
        `${RDFS}comment`,
        literal(
          'A temporal relation, reified: rdf:subject/rdf:predicate/rdf:object name the edge and ' +
            'prov:startedAtTime/prov:endedAtTime its validity range.',
        ),
      ),
      po(`${RDFS}subClassOf`, iri(`${RDF}Statement`)),
    ],
  });

  for (const name of ANNOTATION_PROPERTIES) {
    subjects.push({
      subject: annotationIri(ns, name),
      props: [
        po(RDF_TYPE, iri(`${OWL}AnnotationProperty`)),
        po(`${RDFS}label`, literal(ANNOTATION_COPY[name].label)),
        po(`${RDFS}comment`, literal(ANNOTATION_COPY[name].comment)),
      ],
    });
  }

  // --- The caller's own attribute definitions --------------------------------
  for (const def of describedUserAttributes(registry, userAttributes)) {
    const props: TurtlePredicate[] = [
      po(RDF_TYPE, iri(propertyClass(def.kind))),
      po(`${RDFS}label`, literal(def.label)),
      ...domainAndRange(ns, [def.entityType], def.kind, def.options, false),
    ];
    if (def.deprecatedAt !== null) props.push(po(`${OWL}deprecated`, TRUE));
    subjects.push({ subject: userAttributeIri(ns, def.id), props });
  }

  return writeTurtle({ prefixes: artefactPrefixes(ns), subjects });
}
