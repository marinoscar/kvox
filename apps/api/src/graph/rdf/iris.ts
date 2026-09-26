// =============================================================================
// IRI rules for the ontology artefacts and the data export (issue #385,
// docs/specs/ontology.md §18.1)
// =============================================================================
//
// ONE FUNCTION PER RULE, AND EVERY IRI COMES FROM HERE. The OWL/RDFS generator,
// the SHACL generator and #386's data serializer all build IRIs through these
// functions, so an exported row and the shape that validates it agree by
// construction rather than by two string templates being kept in step.
//
// `ns` is always the application namespace, `kvNamespace(APP_SLUG)` — never a
// spelled product literal.
//
//   class               kv:<TypeKey>
//   built-in attribute  kv:<TypeKey>.<attrKey>, or its `alignment` when set
//   relation prop       kv:<RELATION_KEY>.<propKey>, or its `alignment`
//   user attribute      kv:attr/<defId>          (the id, never the label)
//   relation            kv:<RELATION_KEY>
//   annotations         kv:reviewStatus kv:confidence kv:ontologyVersion kv:validPrecision
//   item status         kv:status
//   item statement      kv:<ItemType>.statement
//   dates (#386)        kv:occurredAt kv:dueAt; an item's validity range is
//                       prov:startedAtTime/prov:endedAtTime + kv:validPrecision,
//                       exactly as on a reified assertion
//   reified assertion   kv:Assertion (rdf:subject/predicate/object + prov times)
//   resources (#386)    kv:entity/<uuid> kv:item/<uuid> kv:relation/<uuid>
//                       kv:evidence/<uuid> kv:segment/<uuid> kv:note/<uuid>/v<version>
//                       kv:export/<uuid> (the export document itself)
//
// Every function validates its input and throws on anything that could make
// an IRI mean something else — a key outside the ontology's own key patterns,
// a resource id that is not a UUID — because an IRI is an identity, and a
// malformed one silently becomes a different identity.
//
// ⚠ PURE. No Nest, no I/O.
// =============================================================================

import { RDF_PREFIXES, expandCurie } from '@app/shared/ontology';

export const RDF = RDF_PREFIXES.rdf;
export const RDFS = RDF_PREFIXES.rdfs;
export const OWL = RDF_PREFIXES.owl;
export const XSD = RDF_PREFIXES.xsd;
export const SH = RDF_PREFIXES.sh;
export const PROV = RDF_PREFIXES.prov;
export const OA = RDF_PREFIXES.oa;
export const SKOS = RDF_PREFIXES.skos;

const TYPE_KEY = /^[A-Z][A-Za-z]+$/;
const RELATION_KEY = /^[A-Z][A-Z_]+$/;
const ATTRIBUTE_KEY = /^[a-z][A-Za-z0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE = /^https?:\/\/[^\s<>"{}|^`\\]+[#/]$/;

function assertNamespace(ns: string): void {
  if (typeof ns !== 'string' || !NAMESPACE.test(ns)) {
    throw new Error(`iris: '${String(ns)}' is not a namespace IRI ending in '#' or '/'`);
  }
}

function assertMatch(what: string, value: string, pattern: RegExp): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`iris: '${String(value)}' is not a valid ${what}`);
  }
}

function under(ns: string, local: string): string {
  assertNamespace(ns);
  return `${ns}${local}`;
}

/** A standard-vocabulary CURIE (`schema:jobTitle`) as a full IRI; throws on an unknown prefix. */
export function alignmentIri(curie: string): string {
  const expanded = expandCurie(curie);
  if (expanded === undefined) throw new Error(`iris: alignment '${String(curie)}' has no known prefix`);
  return expanded;
}

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

/** `kv:<TypeKey>` — an entity or item type. */
export function classIri(ns: string, typeKey: string): string {
  assertMatch('type key', typeKey, TYPE_KEY);
  return under(ns, typeKey);
}

/** `kv:<TypeKey>Shape` — the SHACL node shape for a type. */
export function shapeIri(ns: string, typeKey: string): string {
  assertMatch('type key', typeKey, TYPE_KEY);
  return under(ns, `${typeKey}Shape`);
}

/** `kv:<TypeKey>.<attrKey>`, or the attribute's `alignment` when it declares one. */
export function attributeIri(ns: string, typeKey: string, attrKey: string, alignment?: string): string {
  assertMatch('type key', typeKey, TYPE_KEY);
  assertMatch('attribute key', attrKey, ATTRIBUTE_KEY);
  if (alignment !== undefined) return alignmentIri(alignment);
  return under(ns, `${typeKey}.${attrKey}`);
}

/** `kv:<RELATION_KEY>.<propKey>` (a relation prop, carried on the reified assertion), or its `alignment`. */
export function relationPropIri(ns: string, relationKey: string, propKey: string, alignment?: string): string {
  assertMatch('relation key', relationKey, RELATION_KEY);
  assertMatch('attribute key', propKey, ATTRIBUTE_KEY);
  if (alignment !== undefined) return alignmentIri(alignment);
  return under(ns, `${relationKey}.${propKey}`);
}

/** `kv:attr/<defId>` — a user-defined attribute, keyed by its definition id (§17.3). */
export function userAttributeIri(ns: string, defId: string): string {
  assertMatch('attribute definition id', defId, UUID);
  return under(ns, `attr/${defId.toLowerCase()}`);
}

/** `kv:<RELATION_KEY>`. */
export function relationIri(ns: string, relationKey: string): string {
  assertMatch('relation key', relationKey, RELATION_KEY);
  return under(ns, relationKey);
}

/** The `kv:` annotation properties no standard vocabulary has an opinion on (§18.1). */
export const ANNOTATION_PROPERTIES = ['reviewStatus', 'confidence', 'ontologyVersion', 'validPrecision'] as const;
export type AnnotationProperty = (typeof ANNOTATION_PROPERTIES)[number];

export function annotationIri(ns: string, name: AnnotationProperty): string {
  if (!(ANNOTATION_PROPERTIES as readonly string[]).includes(name)) {
    throw new Error(`iris: '${String(name)}' is not an annotation property`);
  }
  return under(ns, name);
}

/** `kv:status` — an item's lifecycle status (one of its type's declared `statuses`). */
export function itemStatusIri(ns: string): string {
  return under(ns, 'status');
}

/**
 * `kv:<ItemType>.statement` — an item's statement (the `kg_items.statement`
 * column). Named like a built-in attribute because it is one in all but
 * storage: every item carries exactly one.
 */
export function itemStatementIri(ns: string, itemTypeKey: string): string {
  return attributeIri(ns, itemTypeKey, 'statement');
}

/** `kv:occurredAt` — when a meeting or an item happened (`occurred_at`), an `xsd:dateTime`. */
export function occurredAtIri(ns: string): string {
  return under(ns, 'occurredAt');
}

/** `kv:dueAt` — when an item (a commitment) is due (`due_at`), an `xsd:dateTime`. */
export function dueAtIri(ns: string): string {
  return under(ns, 'dueAt');
}

/** `kv:Assertion` — the reified node every exported edge carries its range, props, confidence and citations on (§18.1, #386). */
export function assertionClassIri(ns: string): string {
  return under(ns, 'Assertion');
}

/** `kv:AssertionShape`. */
export function assertionShapeIri(ns: string): string {
  return under(ns, 'AssertionShape');
}

// -----------------------------------------------------------------------------
// Resources (used by the data export, #386)
// -----------------------------------------------------------------------------

function resource(ns: string, kind: string, id: string): string {
  assertMatch(`${kind} id (a UUID)`, id, UUID);
  return under(ns, `${kind}/${id.toLowerCase()}`);
}

export const entityIri = (ns: string, id: string): string => resource(ns, 'entity', id);
export const itemIri = (ns: string, id: string): string => resource(ns, 'item', id);
export const relationInstanceIri = (ns: string, id: string): string => resource(ns, 'relation', id);
export const evidenceIri = (ns: string, id: string): string => resource(ns, 'evidence', id);
export const segmentIri = (ns: string, id: string): string => resource(ns, 'segment', id);
/** `kv:export/<uuid>` — the export document (#386): its generation time and ontology version. */
export const exportIri = (ns: string, id: string): string => resource(ns, 'export', id);

/** `kv:note/<uuid>/v<version>` — one version of a note, the anchor of a note-span citation. */
export function noteSpanIri(ns: string, noteId: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`iris: note version '${String(version)}' is not a positive integer`);
  }
  return `${resource(ns, 'note', noteId)}/v${version}`;
}
