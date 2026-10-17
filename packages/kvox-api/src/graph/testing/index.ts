// The testing entry of the graph slice: the conformance suite of the write-path and
// access invariants, the migration fixtures, and the internals a host's integration specs
// and evaluation scripts reach for. Import it from tests and scripts only.

export * from './graph-conformance.js';

/**
 * The slice's internals and fixtures that a host's integration specs and evaluation scripts reach
 * for. Not part of the documented surface: no stability promise, and it changes with the slice.
 *
 * @internal
 */
export * as internals from './internals.js';
