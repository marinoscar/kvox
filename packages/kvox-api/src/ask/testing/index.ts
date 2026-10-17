// The testing entry of the Ask slice: the conformance suite of the turn's invariants, the scripted
// chat model and the fakes the slice's own specs and a host's integration specs use. Import it from
// tests and scripts only.
//
// A host's AI adapter that passes `describeKvoxPortsConformance` can be handed to
// `describeAskConformance` to prove it runs an Ask turn unchanged.

export * from './ask-conformance.js';
export * from './ask-tool-fakes.js';
export * from './in-memory-ask-db.js';
export * from './scripted-chat.js';

/**
 * The slice's internals that a host's integration specs and evaluation scripts reach for. Not part
 * of the documented surface: no stability promise, and it changes with the slice.
 *
 * @internal
 */
export * as internals from './internals.js';
