// =============================================================================
// The provider adapters a live run calls (issue #580)
// =============================================================================
//
// The OpenAI and OpenAI-compatible adapters are the lean provider package's
// (`@marinoscar/platform-ai-providers/openai`): plain factories, no Nest, no
// database. `platformAdapter` calls the factory for the provider with no options
// (no logger, no tracer: a live run is a CLI); the key and base URL travel per call
// in the adapter's call context, never here.
//
// `openai` (the SDK) is an OPTIONAL peer of this package: it is loaded only when a
// live run asks for one of these two providers, never by a scoring run.
// =============================================================================

import type { AiProviderAdapter } from '@marinoscar/platform-ai-providers';

/**
 * A provider id {@link platformAdapter} can build.
 *
 * @stability experimental
 */
export type PlatformAdapterProvider = 'openai' | 'openai-compatible';

/**
 * The lean provider package's adapter for a provider, constructed outside Nest.
 *
 * @param provider - `openai` or `openai-compatible`.
 * @returns the adapter (`responses`, `embeddings`, ...).
 * @throws Error when the adapter built does not carry the id asked for.
 * @stability experimental
 */
export function platformAdapter(provider: PlatformAdapterProvider): AiProviderAdapter {
  // Required lazily: the subpath loads the OpenAI SDK, which a scoring run (gold, a
  // predictions directory) has no reason to load.
  const openai = require('@marinoscar/platform-ai-providers/openai') as typeof import('@marinoscar/platform-ai-providers/openai');
  const adapter: AiProviderAdapter = provider === 'openai' ? openai.createOpenAiAdapter() : openai.createOpenAiCompatibleAdapter();
  if (adapter.id !== provider) throw new Error(`The ${provider} adapter factory built '${adapter.id}', expected '${provider}'`);
  return adapter;
}
