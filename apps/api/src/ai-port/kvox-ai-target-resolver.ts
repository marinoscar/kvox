import { Injectable, Logger } from '@nestjs/common';

import {
  DefaultAiTargetResolver,
  type AiTarget,
  type AiTargetContext,
  type AiTargetResolver,
} from '@marinoscar/platform-api/ai';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import {
  KVOX_EMBEDDING_FEATURES,
  KVOX_FEATURE_TASK,
  isKvoxAiFeature,
} from './features';
import {
  graphDisabledConflict,
  lacksCapabilityConflict,
  notConfiguredConflict,
  notPermittedBadRequest,
} from './kvox-ai-errors';
import { KVOX_AI_POLICY } from './ai-policy';
import {
  chooseTaskModel,
  taskDefinition,
  type AiTaskKey,
  type TaskModelCandidate,
  type TaskModelChoice,
  type TaskModelPolicy,
} from './task-models';

// =============================================================================
// KvoxAiTargetResolver (issue #473, epic #472)
// =============================================================================
//
// THE ONE PLACE A KVOX AI CALL DECIDES WHICH (provider, model) IT RUNS ON. The
// platform's `AiService` asks `AI_TARGET_RESOLVER` for a target when a caller
// names a feature; this resolver answers with the same model `chooseTaskModel`
// has always picked, now fed from the `ai_models` rows the administrator enabled
// and the extended `ai` namespace (task models, default model, graph switch).
//
// ⚠ IT NEVER RETURNS `null` FOR A KVOX FEATURE. `null` would let the platform
// pick a model this product did not choose (the sole provider's first model).
// When no model can be chosen it THROWS the 409/400 the product has always
// answered with (`KvoxAiConflict`, `KvoxAiBadRequest`).
//
// Per feature:
//   • a task feature (`graph_*` except embeddings): `chooseTaskModel` over the
//     enabled models, the requested model first, then the task's model, then the
//     default;
//   • a feature with no task (notes, name check): the requested model when it is
//     enabled, else the default model, else `ai_not_configured`;
//   • an embedding feature: the catalog embedding model on the active provider;
//   • any other feature (a platform page such as the Playground, or no feature at
//     all): the platform's own `DefaultAiTargetResolver`.
//
// THE KEY IS NOT CHECKED HERE. Whose key pays, and whether it can reach the model,
// is the platform's gate (`AI_KEY_REQUIRED`, `AI_MODEL_NOT_REACHABLE`), which
// `mapAiError` turns into the product's wire codes.
// =============================================================================

/** How long the policy and model rows are reused, like the platform's policy cache. */
export const KVOX_AI_RESOLVER_CACHE_MS = 5_000;

/** The one provider this product runs today. */
export const KVOX_AI_PROVIDER = 'openai';

/** The embeddings model the catalog offers, which the embedding features use. */
export const KVOX_EMBEDDING_MODEL = 'text-embedding-3-small';

/** One enabled model, as the resolver and `/api/ai-tasks/config` read it. */
export interface KvoxEnabledModel extends TaskModelCandidate {
  label: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

/** The policy and the enabled models, read once. */
export interface KvoxAiResolverState {
  policy: TaskModelPolicy & {
    enabled: boolean;
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
  };
  /** The active provider slot, or null while AI or the slot is off. */
  provider: string | null;
  /** Enabled `ai_models` rows of the active provider; empty when there is none. */
  models: KvoxEnabledModel[];
}

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
export class KvoxAiTargetResolver implements AiTargetResolver {
  private readonly logger = new Logger(KvoxAiTargetResolver.name);
  private cache: { at: number; state: KvoxAiResolverState } | null = null;
  private staleWarned = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly fallback: DefaultAiTargetResolver,
  ) {}

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

  async resolve(ctx: AiTargetContext): Promise<AiTarget | null> {
    const feature = ctx.feature;
    if (!isKvoxAiFeature(feature)) {
      // A platform page (the Playground) or a call that named no feature: the
      // platform's own order, not this product's.
      return this.fallback.resolve(ctx);
    }

    const state = await this.loadState();

    if (KVOX_EMBEDDING_FEATURES.includes(feature)) {
      return { provider: state.provider ?? KVOX_AI_PROVIDER, model: KVOX_EMBEDDING_MODEL };
    }

    const task = KVOX_FEATURE_TASK[feature];
    return task === null
      ? this.resolveWithoutTask(state, ctx.requested.model ?? null)
      : this.resolveTask(state, task, ctx.requested.model ?? null);
  }

  /**
   * The same answer as {@link resolve}, without throwing: for the admin view and
   * `/api/ai-tasks/config`. `userId` is the caller the answer is for; the choice
   * does not depend on whose key pays.
   */
  async explain(
    _userId: string,
    task: AiTaskKey,
    requested?: string | null,
  ): Promise<TaskModelChoice> {
    const state = await this.loadState();
    return chooseTaskModel({
      policy: state.policy,
      models: state.models,
      task,
      requested: requested ?? null,
    });
  }

  private resolveTask(
    state: KvoxAiResolverState,
    task: AiTaskKey,
    requested: string | null,
  ): AiTarget {
    const definition = taskDefinition(task);
    const choice = chooseTaskModel({
      policy: state.policy,
      models: state.models,
      task,
      requested,
    });

    if (choice.staleTaskModel && !this.staleWarned) {
      this.staleWarned = true;
      // Never user data: the task key and the administrator's model id only.
      this.logger.warn({
        msg: 'Configured task model is no longer enabled; using the default model',
        task,
        configuredModel: state.policy.taskModels[task]?.model,
      });
    }

    if (choice.problem === 'graph_disabled') throw graphDisabledConflict();

    // Nothing is enabled to choose from: the deployment is not set up, whatever
    // model was asked for (a 409, as the product has always answered).
    if (state.provider === null || state.models.length === 0) {
      throw notConfiguredConflict({ label: definition.label });
    }

    if (choice.problem === 'not_permitted') {
      throw notPermittedBadRequest({
        model: choice.model,
        permitted: state.models.map((model) => model.id),
        task,
      });
    }

    if (choice.problem === 'no_model' || choice.model === null) {
      throw notConfiguredConflict({ label: definition.label });
    }

    if (choice.problem === 'lacks_capability') {
      throw lacksCapabilityConflict({
        subject: { label: definition.label },
        task,
        model: choice.model,
        missing: choice.missing,
      });
    }

    return { provider: state.provider, model: choice.model };
  }

  private resolveWithoutTask(state: KvoxAiResolverState, requested: string | null): AiTarget {
    if (state.provider === null || state.models.length === 0) {
      throw notConfiguredConflict();
    }

    if (requested !== null) {
      if (!state.models.some((model) => model.id === requested)) {
        throw notPermittedBadRequest({
          model: requested,
          permitted: state.models.map((model) => model.id),
        });
      }
      return { provider: state.provider, model: requested };
    }

    const fallback = state.policy.defaultModel;
    if (fallback !== null && state.models.some((model) => model.id === fallback)) {
      return { provider: state.provider, model: fallback };
    }

    throw notConfiguredConflict();
  }
}
