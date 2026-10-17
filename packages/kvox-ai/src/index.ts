/**
 * `@marinoscar/kvox-ai`: the host-neutral KVox model mechanics.
 *
 * @remarks
 * One package for what KVox does with a model, written once for every host:
 * strict structured output (`structured`), the chat and tool-call mapping to and
 * from the provider-adapter events (`chat`), the task-to-model chooser and the
 * task vocabulary (`tasks`, `features`), the local token estimate (`tokens`), the
 * embedding catalog (`embedding`), the call and event types (`types`) and the
 * interfaces a host supplies (`runtime`). The package root re-exports every
 * slice.
 *
 * @packageDocumentation
 */
export * from './chat/index.js';
export * from './embedding/index.js';
export * from './features/index.js';
export * from './runtime/index.js';
export * from './structured/index.js';
export * from './tasks/index.js';
export * from './tokens/index.js';
export * from './types/index.js';
