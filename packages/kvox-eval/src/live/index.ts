// The live slice's public surface (re-exported by the package root).
export { platformAdapter } from './adapters.js';
export type { PlatformAdapterProvider } from './adapters.js';
export { DEPRECATED_EVAL_API_KEY_ENVS, KVOX_EVAL_API_KEY_ENV, readEvalApiKey } from './env.js';
export type { EvalApiKey } from './env.js';
export { assertLiveProvider, createLiveKvoxAi, LIVE_PROVIDERS, LiveProviderError, staticTaskModelSource } from './live-ai.js';
export type { CreateLiveKvoxAiOptions, LiveCallFailure, LiveKvoxAi, LiveProvider } from './live-ai.js';
