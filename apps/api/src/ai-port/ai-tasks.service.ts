import { Injectable } from '@nestjs/common';

import type { PatchSystemSettingsDto } from '@marinoscar/platform-api/settings';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { computeTokenBudget } from './ai-token-budget';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AiTasksConfig,
  AiTasksConfigModel,
  AiTasksConfigTask,
  AiTasksSettingsView,
  UpdateAiTasksSettings,
} from './dto/ai-tasks.dto';
import { AI_TASK_KEYS, type AiTaskKey } from './ai-task-keys';
import {
  KvoxAiBadRequest,
  notPermittedBadRequest,
  lacksCapabilityConflict,
} from './kvox-ai-errors';
import {
  KVOX_AI_PROVIDER,
  KvoxAiTargetResolver,
  type KvoxAiResolverState,
} from './kvox-ai-target-resolver';
import {
  AI_MODEL_LACKS_CAPABILITY,
  AI_TASK_DEFINITIONS,
  chooseTaskModel,
  missingCapabilities,
  taskDefinition,
} from './task-models';

// =============================================================================
// AiTasksService (issue #473, epic #472)
// =============================================================================
//
// The two read/write surfaces `/api/ai-tasks/*` serves:
//
//   • the per-caller capability probe that replaced `GET /api/ai/config` (that
//     path belongs to the platform now). Same response, computed from the
//     enabled `ai_models` rows and the extended `ai` namespace through
//     `KvoxAiTargetResolver.loadState`, with the SAME `chooseTaskModel` the
//     run-time resolver uses, so what it says a task would run on is what runs;
//   • the administrator's view and write of the fields this app adds to the `ai`
//     namespace (task models, graph switch, default model, limits).
//
// Tables read: `system_settings` (through the platform service), `ai_models`,
// `user_ai_keys` (for `keyConfigured`, existence only: the secret column is never
// selected). A write goes through the platform `SystemSettingsService`, so it is
// versioned (`If-Match`) and audited like every other settings write.
// =============================================================================

/** The conservative floor for a model whose row carries no numbers. */
const FLOOR_CONTEXT_WINDOW_TOKENS = 128_000;
const FLOOR_MAX_OUTPUT_TOKENS = 16_384;

@Injectable()
export class AiTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly resolver: KvoxAiTargetResolver,
  ) {}

  /** The capability answer for one caller. Never throws for an unconfigured deployment. */
  async getConfig(userId: string): Promise<AiTasksConfig> {
    const state = await this.resolver.loadState();
    const { policy } = state;

    // Existence only: `secret` is never selected.
    const key = await this.prisma.userAiKey.findUnique({
      where: { userId_provider: { userId, provider: KVOX_AI_PROVIDER } },
      select: { id: true },
    });

    const models = state.models.map((model): AiTasksConfigModel => {
      const budget = computeTokenBudget({
        contextWindowTokens: model.contextWindow ?? FLOOR_CONTEXT_WINDOW_TOKENS,
        modelMaxOutputTokens: model.maxOutputTokens ?? FLOOR_MAX_OUTPUT_TOKENS,
        policyMaxInputTokens: policy.maxInputTokens,
        policyMaxOutputTokens: policy.maxOutputTokens,
        reasoningEffort: policy.reasoningEffort,
      });
      return {
        id: model.id,
        label: model.label,
        contextWindowTokens:
          budget.inputSource === 'model'
            ? budget.contextWindowTokens
            : Math.min(budget.contextWindowTokens, budget.availableInputTokens + budget.maxOutputTokens),
        maxOutputTokens: budget.maxOutputTokens,
        structuredOutput: model.structuredOutput,
        toolCalling: model.toolCalling,
        source: model.contextWindow !== null && model.maxOutputTokens !== null ? 'catalogue' : 'default',
        derivedFrom: null,
      };
    });

    const usable = models.filter(() => true);
    const configuredDefault = policy.defaultModel;
    const defaultModel =
      usable.find((model) => model.id === configuredDefault)?.id ?? usable[0]?.id ?? null;

    return {
      available: state.provider !== null && usable.length > 0,
      provider: KVOX_AI_PROVIDER,
      providerLabel: 'OpenAI',
      models,
      defaultModel,
      maxInputTokens: policy.maxInputTokens,
      maxOutputTokens: policy.maxOutputTokens,
      keyConfigured: key !== null,
      graphEnabled: policy.graphEnabled,
      taskModels: this.describeTaskModels(state),
    };
  }

  /** Every task as a caller would run it, chosen from exactly the models the probe offers. */
  private describeTaskModels(state: KvoxAiResolverState): AiTasksConfig['taskModels'] {
    const entries = AI_TASK_KEYS.map((task): [AiTaskKey, AiTasksConfigTask] => {
      const choice = chooseTaskModel({ policy: state.policy, models: state.models, task });
      const reason: AiTasksConfigTask['reason'] =
        choice.problem === 'graph_disabled'
          ? 'graph_disabled'
          : choice.problem === 'lacks_capability'
            ? 'model_lacks_capability'
            : choice.problem === null
              ? null
              : // `no_model`; `not_permitted` needs a requested model.
                'no_model';
      return [
        task,
        {
          model: choice.model,
          source: choice.source as AiTasksConfigTask['source'],
          reasoningEffort: choice.reasoningEffort,
          requires: [...taskDefinition(task).requires],
          usable: reason === null,
          reason,
        },
      ];
    });
    return Object.fromEntries(entries) as AiTasksConfig['taskModels'];
  }

  /** What `GET /api/ai-tasks/settings` renders. */
  async describeForAdmin(): Promise<AiTasksSettingsView> {
    const [ai, row, state] = await Promise.all([
      this.settings.getNamespace('ai') as Promise<unknown>,
      this.prisma.systemSettings.findUnique({
        where: { key: 'global' },
        select: { version: true },
      }),
      this.resolver.loadState({ fresh: true }),
    ]);
    const stored = ai as AiTasksSettingsView['settings'];

    // The admin view is computed WITHOUT the graph gate so an administrator can
    // configure tasks before switching the feature on.
    const ungated = { ...state.policy, graphEnabled: true };

    return {
      settings: {
        taskModels: stored.taskModels,
        graphEnabled: stored.graphEnabled,
        defaultModel: stored.defaultModel,
        maxInputTokens: stored.maxInputTokens,
        maxOutputTokens: stored.maxOutputTokens,
        requestTimeoutMs: stored.requestTimeoutMs,
        reasoningEffort: stored.reasoningEffort,
        maxDocumentBytes: stored.maxDocumentBytes,
      },
      tasks: AI_TASK_DEFINITIONS.map((task) => ({ ...task, requires: [...task.requires] })),
      models: state.models.map((model) => ({
        id: model.id,
        label: model.label,
        structuredOutput: model.structuredOutput,
        toolCalling: model.toolCalling,
      })),
      taskModelStatus: AI_TASK_KEYS.map((task) => {
        const choice = chooseTaskModel({ policy: ungated, models: state.models, task });
        return {
          task,
          configuredModel: stored.taskModels[task]?.model ?? null,
          effectiveModel: choice.model,
          source: choice.source === 'requested' ? 'default' : choice.source,
          missing: choice.missing,
          problem:
            choice.problem === 'lacks_capability' || choice.problem === 'no_model'
              ? choice.problem
              : null,
          staleTaskModel: choice.staleTaskModel,
        };
      }),
      version: row?.version ?? 0,
    };
  }

  /**
   * `PUT /api/ai-tasks/settings`: a partial update despite the verb (every field
   * is optional; `taskModels` replaces wholesale, so `{}` clears it).
   *
   * Each task model present is checked against the ENABLED models: outside the
   * list is a 400 `model_not_permitted` (with `task`), one that lacks a capability
   * the task requires is a 400 `model_lacks_capability` (with `missing`). The
   * generic `PATCH /api/system-settings` skips this validation; that is accepted,
   * because a non-enabled task model already falls back at run time
   * (`staleTaskModel`).
   */
  async update(
    patch: UpdateAiTasksSettings,
    userId: string,
    expectedVersion?: number,
  ): Promise<AiTasksSettingsView> {
    if (patch.taskModels) {
      const state = await this.resolver.loadState({ fresh: true });
      this.assertTaskModelsValid(patch.taskModels, state);
    }

    await this.settings.patchSettings(
      { ai: patch } as unknown as PatchSystemSettingsDto,
      userId,
      expectedVersion,
    );
    this.resolver.invalidateCache();

    return this.describeForAdmin();
  }

  private assertTaskModelsValid(
    taskModels: NonNullable<UpdateAiTasksSettings['taskModels']>,
    state: KvoxAiResolverState,
  ): void {
    const permitted = state.models.map((model) => model.id);

    for (const task of AI_TASK_KEYS) {
      const entry = taskModels[task];
      if (!entry) continue;

      const model = state.models.find((candidate) => candidate.id === entry.model);
      if (!model) {
        throw notPermittedBadRequest({ model: entry.model, permitted, task });
      }

      const definition = taskDefinition(task);
      const missing = missingCapabilities(model, definition.requires);
      if (missing.length > 0) {
        const conflict = lacksCapabilityConflict({
          subject: { label: definition.label },
          task,
          model: model.id,
          missing,
        });
        throw new KvoxAiBadRequest(
          conflict.message,
          { task, model: model.id, missing },
          AI_MODEL_LACKS_CAPABILITY,
        );
      }
    }
  }
}
