// The testing entry of the graph-rdf slice: the conformance suite of the export and import
// invariants, the RDF fixtures, and the generators a host's specs reach for. Import it from
// tests only (it loads the optional peers `n3` and `rdf-validate-shacl`).

export * from './graph-rdf-conformance.js';

/**
 * The slice's internals and fixtures that a host's integration specs and evaluation scripts reach
 * for. Not part of the documented surface: no stability promise, and it changes with the slice.
 *
 * @internal
 */
export * as internals from './internals.js';
