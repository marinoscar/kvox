// =============================================================================
// The provider adapters a live run calls (issue #580)
// =============================================================================
//
// The OpenAI and OpenAI-compatible adapters are the platform's
// (`@marinoscar/platform-api/ai`). Its public entry exports their Nest MODULES
// (`OpenAiProviderModule`, `OpenAiCompatibleProviderModule`), not the adapter
// classes, so the adapter is read off the module's own `exports` metadata and
// constructed by hand over a fresh `AiProviderRegistry` and the module's client
// factory (no Nest application is booted: the adapter registers itself only in
// `onModuleInit`, which is never called here).
//
// PLATFORM-ADOPTION-SHIM(#578): until the lean provider-adapter package exports
// the adapter classes (or factories), at which point this file becomes two
// `new` expressions.
// =============================================================================

import type { AiProviderAdapter } from '@marinoscar/platform-api/ai';

/**
 * A provider id {@link platformAdapter} can build.
 *
 * @stability experimental
 */
export type PlatformAdapterProvider = 'openai' | 'openai-compatible';

/** The platform module that carries each provider's adapter. */
const ADAPTER_MODULES: Readonly<Record<PlatformAdapterProvider, string>> = {
  openai: 'OpenAiProviderModule',
  'openai-compatible': 'OpenAiCompatibleProviderModule',
};

type Ctor = new (...args: unknown[]) => unknown;

/** `Reflect.getMetadata`, installed by `reflect-metadata` (the platform's Nest import loads it). */
function metadata(key: string, target: object): unknown {
  const reflect = Reflect as unknown as { getMetadata?: (k: string, t: object) => unknown };
  if (typeof reflect.getMetadata !== 'function') throw new Error('reflect-metadata is not loaded');
  return reflect.getMetadata(key, target);
}

/**
 * The platform's adapter for a provider, constructed outside Nest.
 *
 * @param provider - `openai` or `openai-compatible`.
 * @returns the adapter (`responses`, `embeddings`, ...).
 * @throws Error when the installed platform no longer carries the adapter where this shim looks.
 * @stability experimental
 */
export function platformAdapter(provider: PlatformAdapterProvider): AiProviderAdapter {
  // Required lazily: the platform's AI entry loads Nest and the OpenAI SDK, which a
  // scoring run (gold, a predictions directory) has no reason to load.
  const ai = require('@marinoscar/platform-api/ai') as typeof import('@marinoscar/platform-api/ai');
  const moduleClass = (ai as unknown as Record<string, object | undefined>)[ADAPTER_MODULES[provider]];
  if (moduleClass === undefined) throw new Error(`@marinoscar/platform-api/ai has no ${ADAPTER_MODULES[provider]}`);

  const exported = (metadata('exports', moduleClass) as Ctor[] | undefined) ?? [];
  const providers = (metadata('providers', moduleClass) as Ctor[] | undefined) ?? [];
  const Adapter = exported.find((c) => typeof c === 'function');
  const Factory = providers.find((c) => typeof c === 'function' && c !== Adapter);
  if (Adapter === undefined || Factory === undefined) {
    throw new Error(`${ADAPTER_MODULES[provider]} does not carry an adapter and a client factory`);
  }
  const adapter = new Adapter(new ai.AiProviderRegistry(), new Factory()) as AiProviderAdapter;
  if (adapter.id !== provider) throw new Error(`${ADAPTER_MODULES[provider]} built '${adapter.id}', expected '${provider}'`);
  return adapter;
}
