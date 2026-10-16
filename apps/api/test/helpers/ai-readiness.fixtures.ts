import { DEFAULT_SYSTEM_SETTINGS } from '../../src/settings/registry/default-system-settings';
import { KvoxAiTargetResolver } from '../../src/ai-port/kvox-ai-target-resolver';
import type { TestContext } from './test-app.helper';
import { prismaMock } from '../mocks/prisma.mock';

// =============================================================================
// Mocked-database fixtures for the REAL `KvoxAi.readiness` (issue #475)
// =============================================================================
//
// An integration spec that drives a route which asks "may this user generate?"
// no longer mocks a settings service and a credentials service: the answer is
// computed from three reads, and these helpers prime exactly those:
//
//   • the `ai` system-settings namespace (AI switched on, the `openai` slot on, a
//     default model);
//   • the enabled `ai_models` rows;
//   • whether the caller has a `user_ai_keys` row.
//
// The resolver reuses what it read for five seconds per process, so a spec that
// changes the settings between tests must call `invalidateAiResolverCache`.
// =============================================================================

/** The `ai` block of a deployment that has AI on and `defaultModel` chosen. */
export function enabledAiBlock(defaultModel = 'gpt-4o'): Record<string, unknown> {
  return {
    ...DEFAULT_SYSTEM_SETTINGS.ai,
    enabled: true,
    providers: { ...DEFAULT_SYSTEM_SETTINGS.ai.providers, openai: { enabled: true } },
    defaultModel,
  };
}

/** A whole stored `system_settings` row carrying `ai`. */
export function storedSystemSettings(ai: Record<string, unknown> = enabledAiBlock()) {
  return {
    id: 'settings-1',
    key: 'global',
    value: { ...DEFAULT_SYSTEM_SETTINGS, ai },
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: null,
    updatedByUser: null,
  };
}

/** An enabled `ai_models` row with a chat-capable capability list. */
export function enabledModelRow(modelId = 'gpt-4o') {
  return {
    id: `row-${modelId}`,
    provider: 'openai',
    modelId,
    displayName: null,
    capabilities: { capabilities: ['responses', 'streaming', 'structured_output', 'tools'] },
    capabilitySource: 'catalogue',
    enabled: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  };
}

/**
 * Primes the three reads for a configured deployment. `hasKey` says whether the
 * caller has saved an AI key.
 */
export function primeAiReadiness(options: { hasKey?: boolean; models?: string[] } = {}): void {
  prismaMock.systemSettings.findUnique.mockResolvedValue(storedSystemSettings() as never);
  prismaMock.aiModel.findMany.mockResolvedValue(
    (options.models ?? ['gpt-4o']).map((id) => enabledModelRow(id)) as never,
  );
  prismaMock.userAiKey.findUnique.mockResolvedValue(
    (options.hasKey === false ? null : { id: 'key-1' }) as never,
  );
}

/** Forget the settings and models the resolver cached (it reuses them for 5 seconds). */
export function invalidateAiResolverCache(context: TestContext): void {
  context.module.get(KvoxAiTargetResolver, { strict: false }).invalidateCache();
}
