// =============================================================================
// GraphAiRunResolver (issue #475, epic #472)
// =============================================================================
//
// The graph's one question to the AI port: "which model would this task run on
// for this user, and what are its limits?". It replaces the retired task
// resolver's `resolve(userId, task, requested, { requireKey })` for the
// connected-knowledge tasks, with the same answers:
//
//   • a refusal is the 409 the product has always answered with
//     (`details.reason` = `graph_disabled`, `ai_not_configured`, `ai_key_missing`,
//     `model_lacks_capability`), built from the same sentences
//     (`graph-ai-support.ts`);
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

import {
  KVOX_AI,
  KVOX_SETTINGS,
  type KvoxAiPort,
  type KvoxAiTarget,
  type KvoxReasoningEffort,
  type KvoxSettingsPort,
} from '../ports/index.js';
import type { GraphAiRun } from './graph-ai-run.js';
import { graphDisabledConflict, refusalForResolution, type GraphAiTask } from './graph-ai-support.js';

export type { GraphAiTask } from './graph-ai-support.js';

/** The conservative floor for a model whose catalogue row carries no numbers. */
const FLOOR_CONTEXT_WINDOW_TOKENS = 128_000;
const FLOOR_MAX_OUTPUT_TOKENS = 16_384;

/** The `ai` system-settings namespace, as far as the graph reads it. */
interface GraphAiPolicy {
  graphEnabled?: boolean;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  reasoningEffort?: KvoxReasoningEffort;
}

/**
 * Options of `GraphAiRunResolver.resolve`.
 *
 * @stability experimental
 */
export interface ResolveGraphAiOptions {
  /**
   * Default `true`. `false` skips ONLY the `ai_key_missing` refusal, for a caller
   * that never calls the provider (a token estimate): every other check applies.
   */
  requireKey?: boolean;
}

/**
 * GraphAiRunResolver: wiring the slice registers itself; a host configures it through `GraphModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphAiRunResolver {
  constructor(
    @Inject(KVOX_AI) private readonly ai: KvoxAiPort,
    @Inject(KVOX_SETTINGS) private readonly settings: KvoxSettingsPort,
  ) {}

  /** `ai.graphEnabled`: the deployment's connected-knowledge spending switch. */
  async graphEnabled(): Promise<boolean> {
    return (await this.policy()).graphEnabled === true;
  }

  /**
   * The run `task` would make for `userId`, or the product's 409 refusal.
   * `requested` is a per-run model pick (re-validated against today's policy).
   */
  async resolve(
    userId: string,
    task: GraphAiTask,
    requested?: string | null,
    options: ResolveGraphAiOptions = {},
  ): Promise<GraphAiRun> {
    const policy = await this.policy();
    if (policy.graphEnabled !== true) throw graphDisabledConflict();

    const requireKey = options.requireKey !== false;
    let target: KvoxAiTarget;
    try {
      target = await this.ai.resolveTask({ userId, orgId: null, feature: task }, task, {
        ...(requested ? { model: requested } : {}),
        requireKey,
      });
    } catch (error) {
      throw refusalForResolution(error, task, requested ?? null);
    }

    // An estimate counts tokens without spending any, so a missing key alone does not stop
    // it; the caller is still told whether there is one.
    const keyConfigured = requireKey
      ? true
      : (await this.ai.capabilities({ userId, orgId: null, feature: task })).reason !== 'ai_key_missing';

    return {
      target,
      providerId: target.provider,
      model: target.model,
      reasoningEffort: target.reasoningEffort ?? policy.reasoningEffort ?? 'none',
      modelLimits: {
        contextWindowTokens: target.contextWindowTokens > 0 ? target.contextWindowTokens : FLOOR_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: target.maxOutputTokens > 0 ? target.maxOutputTokens : FLOOR_MAX_OUTPUT_TOKENS,
      },
      policy: {
        maxInputTokens: policy.maxInputTokens ?? null,
        maxOutputTokens: policy.maxOutputTokens ?? null,
        reasoningEffort: policy.reasoningEffort ?? 'none',
      },
      countTokens: (text: string) => this.ai.countTokens(target, text),
      keyConfigured,
      source: target.source === 'requested' || target.source === 'task' ? target.source : 'default',
    };
  }

  private async policy(): Promise<GraphAiPolicy> {
    return (await this.settings.readSystem<GraphAiPolicy>('ai')).value ?? {};
  }
}
