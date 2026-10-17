import { Injectable } from '@nestjs/common';

import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import type { KvoxAiEnabledModel, KvoxAiModelState, KvoxTaskModelSource } from '@marinoscar/kvox-ai';

import { PrismaService } from '../prisma/prisma.service';
import { KVOX_AI_POLICY } from './ai-policy';

// =============================================================================
// PlatformTaskModelSource: the web edition's task-model state (issue #579)
// =============================================================================
//
// THE ONE PLACE THE WEB EDITION READS WHAT TASK-TO-MODEL CHOICE NEEDS: the
// extended `ai` system-settings namespace (AI switch, provider slot, default
// model, task models, graph switch, effort, limits) and the `ai_models` rows the
// administrator enabled for the active provider. It implements
// `KvoxTaskModelSource` of `@marinoscar/kvox-ai`, so `createKvoxAi` (the bound
// `KVOX_AI`), the platform's target resolver (`KvoxAiTargetResolver`, which
// delegates here) and `/api/ai-tasks/*` all read the SAME state through the SAME
// cache.
//
// Split out of `KvoxAiTargetResolver.loadState` (#579): the reads and the cache
// moved here unchanged; the choosing is the package's (`chooseTaskModel`).
//
// ⚠ IT NEVER READS A KEY. Neither source has a key column; whether the caller
// holds a key is `PlatformAiRuntime.readiness` (existence only).
// =============================================================================

/** How long the policy and model rows are reused, like the platform's policy cache. */
export const KVOX_AI_RESOLVER_CACHE_MS = 5_000;

/** The one provider this product runs today. */
export const KVOX_AI_PROVIDER = 'openai';

/** One enabled model, as the resolver and `/api/ai-tasks/config` read it. */
export type KvoxEnabledModel = KvoxAiEnabledModel;

/** The policy and the enabled models, read once. */
export type KvoxAiResolverState = KvoxAiModelState;

function flagsOf(capabilities: unknown): { structuredOutput: boolean; toolCalling: boolean } {
  const list =
    typeof capabilities === 'object' && capabilities !== null
      ? (capabilities as { capabilities?: unknown }).capabilities
      : undefined;
  const ids = Array.isArray(list) ? list : [];
  return {
    structuredOutput: ids.includes('structured_output'),
    toolCalling: ids.includes('tools'),
  };
}

@Injectable()
export class PlatformTaskModelSource implements KvoxTaskModelSource {
  private cache: { at: number; state: KvoxAiResolverState } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  /** `KvoxTaskModelSource.load`: no web read depends on the user, so the cached state serves every user. */
  load(_userId: string): Promise<KvoxAiModelState> {
    return this.loadState();
  }

  /** Drops the cached policy and models (a settings or catalog write). */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * The extended `ai` namespace and the enabled models, in one read, reused for
   * {@link KVOX_AI_RESOLVER_CACHE_MS}.
   */
  async loadState(options: { fresh?: boolean } = {}): Promise<KvoxAiResolverState> {
    const now = Date.now();
    if (!options.fresh && this.cache && now - this.cache.at < KVOX_AI_RESOLVER_CACHE_MS) {
      return this.cache.state;
    }

    const ai = await this.settings.getNamespace(KVOX_AI_POLICY);
    const provider = ai.enabled && ai.providers[KVOX_AI_PROVIDER]?.enabled === true ? KVOX_AI_PROVIDER : null;

    const rows = provider
      ? await this.prisma.aiModel.findMany({
          where: { provider, enabled: true },
          orderBy: { modelId: 'asc' },
          select: {
            modelId: true,
            displayName: true,
            capabilities: true,
            contextWindow: true,
            maxOutputTokens: true,
          },
        })
      : [];

    const state: KvoxAiResolverState = {
      policy: {
        enabled: ai.enabled,
        provider,
        defaultModel: ai.defaultModel,
        graphEnabled: ai.graphEnabled,
        taskModels: ai.taskModels,
        reasoningEffort: ai.reasoningEffort,
        maxInputTokens: ai.maxInputTokens,
        maxOutputTokens: ai.maxOutputTokens,
      },
      provider,
      models: rows.map((row) => ({
        id: row.modelId,
        label: row.displayName ?? row.modelId,
        contextWindow: row.contextWindow,
        maxOutputTokens: row.maxOutputTokens,
        ...flagsOf(row.capabilities),
      })),
    };

    this.cache = { at: now, state };
    return state;
  }
}
