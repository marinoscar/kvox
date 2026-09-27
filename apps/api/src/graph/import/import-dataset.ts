// =============================================================================
// The plain-data triples an import works on (#387, docs/specs/ontology.md §18.3)
// =============================================================================
//
// `rdf-parse.ts` is the one import file that touches an RDF library (§18.4);
// it hands every later step these plain objects instead of library quads, so
// version negotiation, the unknown-property pre-pass and the mapping to
// proposal rows are pure functions a unit test can drive with literals.
//
// Named graphs are merged into the default graph on the way in: an import is
// one document, and nothing downstream has a use for the graph component.
//
// ⚠ PURE. No Nest, no I/O, no RDF library.
// =============================================================================

export type ImportTermType = 'NamedNode' | 'BlankNode' | 'Literal';

export interface ImportTerm {
  readonly termType: ImportTermType;
  readonly value: string;
  /** Literals only: the datatype IRI (`xsd:string` for a plain literal, `rdf:langString` with a language). */
  readonly datatype?: string;
  /** Literals only, when tagged. */
  readonly language?: string;
}

export interface ImportQuad {
  readonly s: ImportTerm;
  readonly p: string;
  readonly o: ImportTerm;
}

/** A stable key for a subject/object node: `N:<iri>` or `B:<label>`. Literals have none. */
export function nodeKey(term: ImportTerm): string | null {
  if (term.termType === 'NamedNode') return `N:${term.value}`;
  if (term.termType === 'BlankNode') return `B:${term.value}`;
  return null;
}

/** The IRI of a named node, or `_:label` for a blank one — how a report names a node. */
export function displayNode(term: ImportTerm): string {
  return term.termType === 'BlankNode' ? `_:${term.value}` : term.value;
}

/** Quads grouped by subject key, in input order. */
export function indexBySubject(quads: readonly ImportQuad[]): Map<string, ImportQuad[]> {
  const out = new Map<string, ImportQuad[]>();
  for (const q of quads) {
    const key = nodeKey(q.s);
    if (key === null) continue;
    const list = out.get(key);
    if (list) list.push(q);
    else out.set(key, [q]);
  }
  return out;
}
