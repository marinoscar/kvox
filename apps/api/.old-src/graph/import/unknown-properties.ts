// =============================================================================
// The unknown-property pre-pass (#387, docs/specs/ontology.md §17.1, §17.3, §18.3)
// =============================================================================
//
// Closed by default, without failing a whole CRM export over one custom
// column: every predicate on a typed node that the node's shape does not admit
// (`import-vocabulary.ts`) becomes an OFFER — a candidate `kg_attribute_defs`
// row the user accepts or rejects on the import page — and is REMOVED from the
// triples before SHACL validation. Offered, never silently kept (§17.1).
//
//   - Keyed by property IRI: one offer per IRI, however many types carry it.
//   - `suggestedKind` from the values: `xsd:boolean` → boolean, numeric →
//     number, `xsd:date`/`xsd:dateTime` → date, an IRI naming a typed entity
//     node of the file → entity_ref, another http(s) IRI or `xsd:anyURI` → url,
//     anything else (or a mix) → text.
//   - `label` is the file's own `rdfs:label` for the property when it states
//     one (#386's export labels every `kv:attr/<id>` it writes).
//   - An unknown property on a reified relation (`kv:Assertion`) can never
//     become an attribute — user attributes live on entity and item types — so
//     it is recorded as an offer already `rejected`.
//   - The values themselves are returned (`pending`) so an accepted offer can
//     move them into the proposal rows' `props`; only three short samples go
//     into the stats.
//
// Also lifted out here, and never offered: `kv:sensitivity` on an item node —
// how a file marks a person fact `sensitive` — which the mapping reads to skip
// that fact (a deployment never ingests sensitive facts in bulk, §5.6).
//
// Only nodes a shape targets are inspected — nodes typed with one of the
// ontology's classes or `kv:Assertion`. Everything else in the file (evidence
// annotations, the export header, attribute-definition labels) is left alone:
// no shape targets it, so it can neither fail validation nor become graph data.
//
// ⚠ PURE. No Nest, no I/O, no RDF library.
// =============================================================================

import { createHash } from 'node:crypto';

import type { AttributeKind } from '@app/shared/ontology';

import { RDF, RDFS, XSD } from '../rdf/iris';
import type { GraphImportOffer } from './dto/graph-import.dto';
import { indexBySubject, nodeKey, type ImportQuad, type ImportTerm } from './import-dataset';
import type { ImportVocabulary } from './import-vocabulary';

const RDF_TYPE = `${RDF}type`;
const SAMPLE_COUNT = 3;
const SAMPLE_LENGTH = 80;

/** The pseudo type an offer on a reified relation names. */
export const ASSERTION_SUBJECT_TYPE = 'Assertion';

/** One value of an unknown property, as kept for a later accept. */
export interface PendingValue {
  /** Lexical form, or the IRI. */
  v: string;
  /** Literal datatype; absent for an IRI. */
  d?: string;
  /** For an IRI naming another node of the file: that node's key (the mapping turns it into a row id). */
  node?: string;
}

export interface UnknownPropertiesResult {
  /** The triples with every unknown property (and `kv:sensitivity`) removed. */
  quads: ImportQuad[];
  offers: GraphImportOffer[];
  /** offerId → node key → values. */
  pending: Map<string, Map<string, PendingValue[]>>;
  /** Item node key → the `kv:sensitivity` value the file stated. */
  sensitivity: Map<string, string>;
}

/** `o` + 12 hex of sha256(iri): stable per IRI, so re-running an import names the same offers. */
export function offerIdFor(iri: string): string {
  return `o${createHash('sha256').update(iri).digest('hex').slice(0, 12)}`;
}

const NUMERIC = /#(decimal|integer|int|long|short|byte|double|float|nonNegativeInteger|positiveInteger|negativeInteger|nonPositiveInteger|unsignedInt|unsignedLong|unsignedShort|unsignedByte)$/;

function kindOfValue(term: ImportTerm, entityNodes: ReadonlySet<string>): AttributeKind {
  if (term.termType === 'NamedNode') {
    if (entityNodes.has(`N:${term.value}`)) return 'entity_ref';
    return /^https?:\/\//.test(term.value) ? 'url' : 'text';
  }
  if (term.termType === 'BlankNode') return entityNodes.has(`B:${term.value}`) ? 'entity_ref' : 'text';
  const dt = term.datatype ?? '';
  if (dt === `${XSD}boolean`) return 'boolean';
  if (NUMERIC.test(dt)) return 'number';
  if (dt === `${XSD}date` || dt === `${XSD}dateTime`) return 'date';
  if (dt === `${XSD}anyURI`) return 'url';
  return 'text';
}

/** One kind for all of an offer's values; a mix is `text`. */
export function suggestKind(kinds: readonly AttributeKind[]): AttributeKind {
  const set = new Set(kinds);
  return set.size === 1 ? [...set][0] : 'text';
}

function sample(term: ImportTerm): string {
  return term.value.length > SAMPLE_LENGTH ? `${term.value.slice(0, SAMPLE_LENGTH - 1)}…` : term.value;
}

export function splitUnknownProperties(quads: readonly ImportQuad[], vocabulary: ImportVocabulary, ns: string): UnknownPropertiesResult {
  const bySubject = indexBySubject(quads);
  const sensitivityIri = `${ns}sensitivity`;

  // Each node's type keys (or Assertion); only these nodes are inspected.
  const nodeTypes = new Map<string, string[]>();
  const entityNodes = new Set<string>();
  for (const [key, list] of bySubject) {
    const types: string[] = [];
    for (const q of list) {
      if (q.p !== RDF_TYPE || q.o.termType !== 'NamedNode') continue;
      if (q.o.value === vocabulary.assertionClass) types.push(ASSERTION_SUBJECT_TYPE);
      const type = vocabulary.classes.get(q.o.value);
      if (type) {
        types.push(type.key);
        if (type.itemKind === undefined) entityNodes.add(key);
      }
    }
    if (types.length > 0) nodeTypes.set(key, [...new Set(types)].sort());
  }

  // Labels the file gives its own properties (`kv:attr/<id> rdfs:label "Tier"`).
  const labels = new Map<string, string>();
  for (const q of quads) {
    if (q.p === `${RDFS}label` && q.s.termType === 'NamedNode' && q.o.termType === 'Literal' && !labels.has(q.s.value)) {
      labels.set(q.s.value, q.o.value);
    }
  }

  interface Acc {
    iri: string;
    count: number;
    subjectTypes: Set<string>;
    samples: string[];
    kinds: AttributeKind[];
    assertionOnly: boolean;
  }
  const acc = new Map<string, Acc>();
  const pending = new Map<string, Map<string, PendingValue[]>>();
  const sensitivity = new Map<string, string>();
  const removed = new Set<ImportQuad>();

  for (const [key, types] of nodeTypes) {
    const isAssertion = types.includes(ASSERTION_SUBJECT_TYPE);
    const realTypes = types.filter((t) => t !== ASSERTION_SUBJECT_TYPE);
    const admits = (p: string): boolean =>
      (isAssertion && vocabulary.assertionAllowed.has(p)) || realTypes.some((t) => vocabulary.allowed.get(t)?.has(p) === true);
    for (const q of bySubject.get(key) ?? []) {
      if (q.p === sensitivityIri && realTypes.some((t) => vocabulary.classes.get(`${ns}${t}`)?.itemKind !== undefined)) {
        if (q.o.termType === 'Literal') sensitivity.set(key, q.o.value);
        removed.add(q);
        continue;
      }
      if (admits(q.p)) continue;
      removed.add(q);
      const offerId = offerIdFor(q.p);
      let a = acc.get(offerId);
      if (!a) {
        a = { iri: q.p, count: 0, subjectTypes: new Set(), samples: [], kinds: [], assertionOnly: true };
        acc.set(offerId, a);
      }
      a.count += 1;
      for (const t of types) a.subjectTypes.add(t);
      if (realTypes.length > 0) a.assertionOnly = false;
      if (a.samples.length < SAMPLE_COUNT) a.samples.push(sample(q.o));
      a.kinds.push(kindOfValue(q.o, entityNodes));

      const target = nodeKey(q.o);
      const value: PendingValue =
        q.o.termType === 'Literal'
          ? { v: q.o.value, d: q.o.datatype }
          : { v: q.o.value, ...(target !== null && nodeTypes.has(target) ? { node: target } : {}) };
      let byNode = pending.get(offerId);
      if (!byNode) {
        byNode = new Map();
        pending.set(offerId, byNode);
      }
      const list = byNode.get(key);
      if (list) list.push(value);
      else byNode.set(key, [value]);
    }
  }

  const offers: GraphImportOffer[] = [...acc.entries()]
    .sort(([, a], [, b]) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0))
    .map(([offerId, a]) => ({
      offerId,
      iri: a.iri,
      label: labels.get(a.iri) ?? null,
      count: a.count,
      subjectTypes: [...a.subjectTypes].sort(),
      sampleValues: a.samples,
      suggestedKind: suggestKind(a.kinds),
      status: a.assertionOnly ? 'rejected' : 'offered',
    }));
  // An assertion-only offer can never be accepted: nothing to keep for it.
  for (const offer of offers) if (offer.status === 'rejected') pending.delete(offer.offerId);

  return { quads: quads.filter((q) => !removed.has(q)), offers, pending, sensitivity };
}
