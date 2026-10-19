/**
 * `@marinoscar/kvox-ai/copilot`: the GitHub Copilot provider adapter (#581).
 *
 * @remarks
 * Not re-exported by the package root: this entry is the only code that may load
 * the optional peer `@github/copilot-sdk` (lazily, inside
 * `createSdkCopilotTransport`), so a host that never imports it never needs the SDK.
 *
 * @packageDocumentation
 */
export * from './copilot-adapter.js';
export * from './copilot-catalog.js';
export * from './copilot-egress.js';
export * from './copilot-errors.js';
export * from './copilot-mock-transport.js';
export * from './copilot-runtime.js';
export * from './copilot-transport.js';
