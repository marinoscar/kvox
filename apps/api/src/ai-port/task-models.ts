import {
  AI_TASK_KEYS,
  type AiReasoningEffort,
  type AiTaskKey,
  type AiTaskModels,
} from './ai-task-keys';

// =============================================================================
// AI task models — definitions and the pure chooser (issue #360, ported by #473)
// =============================================================================
//
// docs/specs/ontology.md §20 "Task models": connected knowledge makes four
// kinds of model call with very different cost and capability profiles, so an
// administrator picks a model (and optionally a reasoning effort) PER TASK,
// falling back to the deployment default, and a user may override with another
// ENABLED model for their own run.
//
// ⚠ PURE, AND IT MUST STAY THAT WAY. No Nest, no Prisma, no registry lookups.
// `chooseTaskModel` is called by the run-time target resolver, the admin view
// and the per-user capability probe, and the whole point of having ONE function
// is that the three can never disagree about which model a task would run on.
// Anything that needs I/O belongs in the caller, which hands the chooser the
// already-resolved model list.
//
// PORTED from `ai/ai-task-models.ts`: the definitions, `taskDefinition`,
// `missingCapabilities` and the chooser body are unchanged. Only the INPUTS
// changed: `models` are the enabled `ai_models` rows of the active provider
// (mapped to `TaskModelCandidate`), the default model is the `ai.defaultModel`
// extension field (it had no platform home), and the provider is the single
// enabled provider slot.
// =============================================================================

export type { AiReasoningEffort, AiTaskKey } from './ai-task-keys';

/**
 * The 400 `details.reason` for a model outside the permitted list — shared by
 * the run-time resolver and save-time validation, so a client maps one value.
 */
export const AI_MODEL_NOT_PERMITTED = 'model_not_permitted' as const;

/**
 * The 400 `details.reason` save-time validation answers for a task model that
 * lacks a capability the task requires. The same string is the run-time 409
 * reason.
 */
export const AI_MODEL_LACKS_CAPABILITY = 'model_lacks_capability' as const;

/** A model capability a task may require. Flags on {@link TaskModelCandidate}. */
export type AiModelCapability = 'structuredOutput' | 'toolCalling';

/**
 * One enabled model the chooser may pick: the `ai_models` row's `modelId` and
 * the two capability flags this app gates on (`structured_output` and `tools` in the
 * row's `capabilities` JSON).
 */
export interface TaskModelCandidate {
  id: string;
  structuredOutput: boolean;
  toolCalling: boolean;
}

/** The slice of the `ai` namespace the chooser reads. */
export interface TaskModelPolicy {
  /** The single enabled provider slot (`'openai'`), or null when none is. */
  provider: string | null;
  /** `ai.defaultModel`; null when nobody chose one. */
  defaultModel: string | null;
  /** The connected-knowledge spending switch. */
  graphEnabled: boolean;
  /** The administrator's per-task models. */
  taskModels: AiTaskModels;
  /** The deployment-wide reasoning effort. */
  reasoningEffort: AiReasoningEffort;
}

/** One connected-knowledge task, as the admin form and user pickers show it. */
export interface AiTaskDefinition {
  key: AiTaskKey;
  label: string;
  description: string;
  /** Capabilities the task's model MUST have. Checked on save and on run. */
  requires: AiModelCapability[];
}

/**
 * Every task, in the order a form lists them. Published verbatim as the admin
 * view's `tasks`, so no client hardcodes a label.
 *
 * There is no `graph.brief`: the entity brief never calls a model in a request
 * (#372); its prose is `graph.digest`'s output.
 */
export const AI_TASK_DEFINITIONS: readonly AiTaskDefinition[] = [
  {
    key: 'graph.extract',
    label: 'Graph extraction',
    requires: ['structuredOutput'],
    description:
      'Reads a finished note and proposes people, organizations, projects, decisions, commitments and claims for review. One call per note.',
  },
  {
    key: 'graph.adjudicate',
    label: 'Entity matching',
    requires: ['structuredOutput'],
    description:
      'Decides whether two similar names are the same person or organization. Many small calls; a smaller model is usually enough.',
  },
  {
    key: 'graph.digest',
    label: 'Entity digest',
    requires: ['structuredOutput'],
    description:
      'Keeps the rolling, cited summary an entity page shows ("what\'s the latest on …"), refreshed by a background job after commits.',
  },
  {
    key: 'graph.agent',
    label: 'Ask (graph agent)',
    requires: ['toolCalling'],
    description:
      'Answers questions by calling read-only graph tools, with citations.',
  },
];

/** The definition for one task. Total over {@link AiTaskKey}. */
export function taskDefinition(task: AiTaskKey): AiTaskDefinition {
  const definition = AI_TASK_DEFINITIONS.find((d) => d.key === task);
  if (!definition) {
    // Unreachable while AI_TASK_DEFINITIONS covers AI_TASK_KEYS, which
    // `task-models.spec.ts` pins.
    throw new Error(`No AI task definition for "${task}"`);
  }
  return definition;
}

/** The capabilities `model` lacks out of `requires`, in `requires` order. */
export function missingCapabilities(
  model: Pick<TaskModelCandidate, AiModelCapability>,
  requires: readonly AiModelCapability[],
): AiModelCapability[] {
  return requires.filter((capability) => !model[capability]);
}

/** What {@link chooseTaskModel} decided, and whether it can run. */
export interface TaskModelChoice {
  task: AiTaskKey;
  /** The chosen model id; null only when nothing could be chosen. */
  model: string | null;
  /**
   * Which rank chose it: the caller's per-run pick, the administrator's task
   * model, the deployment default, or nothing at all.
   */
  source: 'requested' | 'task' | 'default' | 'none';
  reasoningEffort: AiReasoningEffort;
  /** Required capabilities the chosen model lacks. */
  missing: AiModelCapability[];
  /**
   * Why the task cannot run on `model`, or null when it can. `graph_disabled`
   * outranks every other problem, but the model is still computed so the admin
   * view can show what WOULD run.
   */
  problem:
    | null
    | 'graph_disabled'
    | 'not_permitted'
    | 'lacks_capability'
    | 'no_model';
  /**
   * True when an administrator's task model is configured but no longer in
   * `models` and the default was used instead — the caller logs `warn`.
   */
  staleTaskModel: boolean;
}

/**
 * Choose the model one task runs on.
 *
 * `models` is the list of ENABLED, USABLE models with their capability flags. A
 * model absent from it is never chosen, which is what makes "a user can only
 * reach an enabled model" true.
 *
 * Rules, in order (issue #360):
 *   1. `!policy.graphEnabled` → `graph_disabled` (the model is still computed);
 *   2. a `requested` model: not in `models` → `not_permitted`, else it wins;
 *   3. else the task's configured model when it is in `models` (a configured
 *      but no longer permitted one falls through, flagged `staleTaskModel`);
 *   4. else `defaultModel` when it is in `models`, otherwise `no_model`;
 *   5. `missing` = the task's required capabilities the model lacks →
 *      `lacks_capability`;
 *   6. the task's own `reasoningEffort` applies only when the chosen model IS
 *      the configured task model; otherwise the deployment's.
 */
export function chooseTaskModel(input: {
  policy: TaskModelPolicy;
  models: readonly TaskModelCandidate[];
  task: AiTaskKey;
  requested?: string | null;
}): TaskModelChoice {
  const { policy, models, task } = input;
  const requested = input.requested ?? null;
  const definition = taskDefinition(task);
  const configured = policy.taskModels[task];
  const providerId = policy.provider;
  const defaultModel = providerId ? policy.defaultModel : null;
  const find = (id: string | null | undefined) =>
    id ? models.find((m) => m.id === id) : undefined;

  let chosen: TaskModelCandidate | undefined;
  let model: string | null = null;
  let source: TaskModelChoice['source'] = 'none';
  let problem: TaskModelChoice['problem'] = null;
  let staleTaskModel = false;

  if (requested !== null) {
    source = 'requested';
    model = requested;
    chosen = find(requested);
    if (!chosen) problem = 'not_permitted';
  } else {
    const fromTask = find(configured?.model);
    if (fromTask) {
      chosen = fromTask;
      source = 'task';
    } else {
      staleTaskModel = configured !== undefined;
      const fromDefault = find(defaultModel);
      if (fromDefault) {
        chosen = fromDefault;
        source = 'default';
      } else {
        problem = 'no_model';
      }
    }
    model = chosen?.id ?? null;
  }

  const missing = chosen ? missingCapabilities(chosen, definition.requires) : [];
  if (problem === null && missing.length > 0) problem = 'lacks_capability';
  if (!policy.graphEnabled) problem = 'graph_disabled';

  const reasoningEffort: AiReasoningEffort =
    configured?.reasoningEffort !== undefined && model === configured.model
      ? configured.reasoningEffort
      : policy.reasoningEffort;

  return {
    task,
    model,
    source,
    reasoningEffort,
    missing,
    problem,
    staleTaskModel,
  };
}

/** The reasoning efforts the platform accepts on a request. */
export type PlatformReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/**
 * The app's effort as the platform request carries it. `none` means "do not send
 * the parameter" (returns `undefined`); `xhigh` is clamped to `high`, the
 * strongest value the platform accepts (record this in the admin form help text,
 * #477).
 */
export function toPlatformReasoningEffort(
  effort: AiReasoningEffort,
): PlatformReasoningEffort | undefined {
  if (effort === 'none') return undefined;
  if (effort === 'xhigh') return 'high';
  return effort;
}

// Keeps the key list in this module's public surface for callers that iterate it.
export { AI_TASK_KEYS };
