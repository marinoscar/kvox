// =============================================================================
// GraphAiRunResolver (issue #475, epic #472)
// =============================================================================
//
// The graph's one question to the AI port: "which model would this task run on
// for this user, and what are its limits?". It replaces the retired task
// resolver's `resolve(userId, task, requested, { requireKey })` for the
// connected-knowledge tasks, with the same answers:
//
//   • a refusal is the 409 / 400 the product has always answered with
//     (`details.reason` = `graph_disabled`, `ai_not_configured`, `ai_key_missing`,
//     `model_not_permitted`, `model_lacks_capability`), built from the same
//     sentences (the port's error module);
//   • `requireKey: false` skips ONLY the missing-key refusal, for an estimate that
//     counts tokens without spending any;
//   • the result is a `GraphAiRun`, the numbers a prompt is planned against.
//
// It also owns the one read of the deployment's graph switch (`ai.graphEnabled`),
// so the services that gate on it no longer reach into the retired settings
// service.
//
// ⚠ NO KEY IS READ OR HELD HERE. `readiness` reports whether a key exists; the
// platform resolves it per call.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';

import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { KVOX_AI_POLICY } from '../ai-port/ai-policy';
import type { KvoxAiFeatureId } from '../ai-port/features';
import { KVOX_AI, type KvoxAi } from '../ai-port/kvox-ai';
import { notConfiguredConflict } from '../ai-port/kvox-ai-errors';
import { KVOX_AI_PROVIDER, KvoxAiTargetResolver } from '../ai-port/kvox-ai-target-resolver';
import { readinessRefusal } from '../ai-port/readiness-refusal';
import { taskDefinition } from '../ai-port/task-models';
import type { GraphAiRun } from './graph-ai-run';

/** The connected-knowledge tasks that run through this resolver. */
export type GraphAiTask = 'graph.extract' | 'graph.adjudicate' | 'graph.digest';

const FEATURE_FOR_TASK: Readonly<Record<GraphAiTask, KvoxAiFeatureId>> = {
  'graph.extract': 'graph_extract',
  'graph.adjudicate': 'graph_adjudicate',
  'graph.digest': 'graph_digest',
};

/** The conservative floor for a model whose catalogue row carries no numbers. */
const FLOOR_CONTEXT_WINDOW_TOKENS = 128_000;
const FLOOR_MAX_OUTPUT_TOKENS = 16_384;

export interface ResolveGraphAiOptions {
  /**
   * Default `true`. `false` skips ONLY the `ai_key_missing` refusal, for a caller
   * that never calls the provider (a token estimate): every other check applies.
   */
  requireKey?: boolean;
}

@Injectable()
export class GraphAiRunResolver {
  constructor(
    @Inject(KVOX_AI) private readonly ai: KvoxAi,
    private readonly settings: SystemSettingsService,
    private readonly targets: KvoxAiTargetResolver,
  ) {}

  /** `ai.graphEnabled`: the deployment's connected-knowledge spending switch. */
  async graphEnabled(): Promise<boolean> {
    const ai = await this.settings.getNamespace(KVOX_AI_POLICY);
    return ai.graphEnabled === true;
  }

  /**
   * The run `task` would make for `userId`, or the product's 409 / 400 refusal.
   * `requested` is a per-run model pick (re-validated against today's policy).
   */
  async resolve(
    userId: string,
    task: GraphAiTask,
    requested?: string | null,
    options: ResolveGraphAiOptions = {},
  ): Promise<GraphAiRun> {
    const readiness = await this.ai.readiness(userId, FEATURE_FOR_TASK[task], requested ?? null);

    // An estimate counts tokens without spending any, so a missing key alone
    // does not stop it, provided a model was chosen.
    const keyOnly =
      !readiness.ok &&
      readiness.reason === 'ai_key_missing' &&
      options.requireKey === false &&
      readiness.model !== null;
    if (!readiness.ok && !keyOnly) {
      throw await readinessRefusal({
        task,
        readiness,
        requested: requested ?? null,
        // The two refusals that name models read their data back from the target
        // resolver, so the message lists the same models it always did.
        permittedModels: async () => (await this.targets.loadState()).models.map((model) => model.id),
        lacksCapability: async () => {
          const choice = await this.targets.explain(userId, task, requested ?? null);
          return { model: choice.model, missing: choice.missing };
        },
      });
    }

    const model = readiness.model;
    if (model === null) throw notConfiguredConflict({ label: taskDefinition(task).label });

    const policy = await this.settings.getNamespace(KVOX_AI_POLICY);

    return {
      providerId: readiness.provider ?? KVOX_AI_PROVIDER,
      model,
      reasoningEffort: readiness.reasoningEffort,
      modelLimits: {
        contextWindowTokens: readiness.contextWindowTokens ?? FLOOR_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: readiness.maxOutputTokens ?? FLOOR_MAX_OUTPUT_TOKENS,
      },
      policy: {
        maxInputTokens: policy.maxInputTokens,
        maxOutputTokens: policy.maxOutputTokens,
        reasoningEffort: policy.reasoningEffort,
      },
      countTokens: (text: string) => this.ai.countTokens(text, model),
      keyConfigured: readiness.hasKey,
      source: readiness.source === 'requested' || readiness.source === 'task' ? readiness.source : 'default',
    };
  }
}
