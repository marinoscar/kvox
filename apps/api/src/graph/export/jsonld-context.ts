// =============================================================================
// The JSON-LD `@context` a graph export is compacted with (issue #386,
// docs/specs/ontology.md §18.2 item 3)
// =============================================================================
//
// Generated, never hand-written: `kv:` (the application namespace, derived
// from APP_SLUG by the caller) plus every standard vocabulary prefix the
// ontology aligns to (`RDF_PREFIXES`) — the same prefix table the Turtle
// artefacts declare (`artefactPrefixes`), so a JSON-LD export and a Turtle
// export of one graph abbreviate identically.
//
// PREFIXES ONLY, DELIBERATELY. An aligned attribute or relation is already
// written under its standard IRI (`schema:jobTitle`, and `schema:worksFor`
// beside `kv:WORKS_FOR`); mapping a `kv:` term onto a standard IRI in the
// context would silently change what an exported `kv:` property MEANS to any
// consumer that expands it.
//
// ⚠ PURE. No Nest, no I/O, no RDF library.
// =============================================================================

import { artefactPrefixes } from '../rdf/ontology-rdf-model';

export type JsonLdContext = Readonly<Record<string, string>>;

/** `{ kv: <ns>, rdf: …, rdfs: …, … }`, keys sorted so the output is stable. */
export function buildJsonLdContext(ns: string): JsonLdContext {
  const prefixes = artefactPrefixes(ns);
  const out: Record<string, string> = {};
  for (const key of Object.keys(prefixes).sort()) out[key] = prefixes[key];
  return Object.freeze(out);
}
