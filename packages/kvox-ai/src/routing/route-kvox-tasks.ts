// =============================================================================
// Capability-based task routing (issue #630)
// =============================================================================
//
// A host with one primary provider that lacks a capability (GitHub Copilot has no
// tool calling and no embeddings) used to carry its own routing table. This is
// that table, once: each KVox task goes to the primary provider when the primary
// can serve it, else to the fallback when the fallback can, else it is reported
// unavailable so the host can hide the feature with a reason.
//
// The task ids are the PORT's feature vocabulary (`KvoxAiFeature` of
// `@marinoscar/kvox-api/ports`), the names a domain slice passes as `feature`;
// `featureOf` maps every one of them to a registered `KvoxAiFeatureId`. They are
// NOT the `AiTaskKey`s of the `tasks` slice, which is the narrower vocabulary of
// the stored `ai.taskModels` map (`graph.agent` there is `ask.respond` here, and
// notes, embeddings and name checks have no `AiTaskKey` at all).
//
// ⚠ PURE. No I/O, no clock, no SDK. A task id is permanent: it is a key of the
// `taskModels` a host persists.
// =============================================================================

/**
 * Every KVox task a model can be routed for, in the port's feature vocabulary.
 * The order is the order of `routeKvoxTasks` results.
 *
 * @stability experimental
 */
export const KVOX_TASK_IDS = [
  'notes.generate',
  'notes.title',
  'transcripts.name_check',
  'graph.extract',
  'graph.adjudicate',
  'graph.digest',
  'ask.respond',
  'graph.embed',
  'search.embed',
] as const;

/**
 * One KVox task.
 *
 * @stability experimental
 */
export type KvoxTaskId = (typeof KVOX_TASK_IDS)[number];

/**
 * What a provider must offer to serve a task.
 *
 * @stability experimental
 */
export interface KvoxTaskRequirement {
  /** The task calls tools (the Ask agent loop). */
  readonly toolCalling: boolean;
  /** The task calls an embeddings model. */
  readonly embeddings: boolean;
}

const NEITHER: KvoxTaskRequirement = Object.freeze({ toolCalling: false, embeddings: false });
const TOOLS: KvoxTaskRequirement = Object.freeze({ toolCalling: true, embeddings: false });
const EMBEDS: KvoxTaskRequirement = Object.freeze({ toolCalling: false, embeddings: true });

/**
 * The capability each task requires of its provider: `ask.respond` needs tool
 * calling, the two embedding tasks need embeddings, every other task needs neither.
 *
 * @stability experimental
 */
export const KVOX_TASK_REQUIREMENTS: Readonly<Record<KvoxTaskId, KvoxTaskRequirement>> =
  Object.freeze({
    'notes.generate': NEITHER,
    'notes.title': NEITHER,
    'transcripts.name_check': NEITHER,
    'graph.extract': NEITHER,
    'graph.adjudicate': NEITHER,
    'graph.digest': NEITHER,
    'ask.respond': TOOLS,
    'graph.embed': EMBEDS,
    'search.embed': EMBEDS,
  });

/**
 * A provider and the model a task runs on, as a host persists it.
 *
 * @stability experimental
 */
export interface KvoxTaskModel {
  /** The provider id (`copilot`, `openai`, ...). */
  provider: string;
  /** The model id on that provider. */
  model: string;
}

/**
 * The provider and model per task. An absent task is not routed (see
 * {@link RoutedKvoxTasks.unavailable}).
 *
 * @stability experimental
 */
export type KvoxTaskModels = Partial<Record<KvoxTaskId, KvoxTaskModel>>;

/**
 * One provider and model a host can route to, with the capabilities that decide
 * which tasks it can serve.
 *
 * @stability experimental
 */
export interface ProviderChoice {
  /** The provider id. */
  provider: string;
  /** The model id. */
  model: string;
  /** Whether the provider can call tools. */
  toolCalling: boolean;
  /** Whether the provider offers embeddings. */
  embeddings: boolean;
}

/**
 * Why a task has no provider.
 *
 * @stability experimental
 */
export type KvoxTaskUnavailableReason = 'needs_tool_calling' | 'needs_embeddings';

/**
 * A task no given provider can serve, and why.
 *
 * @stability experimental
 */
export interface KvoxTaskUnavailable {
  /** The task. */
  task: KvoxTaskId;
  /** The capability that neither provider offers. */
  reason: KvoxTaskUnavailableReason;
}

/**
 * The input of {@link routeKvoxTasks}.
 *
 * @stability experimental
 */
export interface RouteKvoxTasksInput {
  /** The provider the user chose; it serves every task it can. */
  primary: ProviderChoice;
  /** A provider for the tasks the primary cannot serve (for example OpenAI with a saved key). */
  fallback?: ProviderChoice | null;
}

/**
 * The result of {@link routeKvoxTasks}.
 *
 * @stability experimental
 */
export interface RoutedKvoxTasks {
  /** The provider and model of every task that has one, in {@link KVOX_TASK_IDS} order. */
  taskModels: KvoxTaskModels;
  /** The tasks that have none, in {@link KVOX_TASK_IDS} order, each with the missing capability. */
  unavailable: KvoxTaskUnavailable[];
}

function canServe(choice: ProviderChoice, need: KvoxTaskRequirement): boolean {
  return (!need.toolCalling || choice.toolCalling) && (!need.embeddings || choice.embeddings);
}

/**
 * Routes every KVox task to a provider by capability.
 *
 * @remarks
 * A task goes to `primary` when the primary can serve it, else to `fallback` when
 * the fallback can, else it is listed in `unavailable` (and absent from
 * `taskModels`) so the host can hide the feature with a reason. Any provider
 * without tool calling or embeddings is handled the same way, not only Copilot.
 * Pure and deterministic: no I/O, results follow {@link KVOX_TASK_IDS}, and the
 * input is not mutated.
 *
 * @param input - the primary provider and an optional fallback.
 * @returns the routed `taskModels` and the `unavailable` tasks.
 * @stability experimental
 */
export function routeKvoxTasks(input: RouteKvoxTasksInput): RoutedKvoxTasks {
  const { primary } = input;
  const fallback = input.fallback ?? null;
  const taskModels: KvoxTaskModels = {};
  const unavailable: KvoxTaskUnavailable[] = [];

  for (const task of KVOX_TASK_IDS) {
    const need = KVOX_TASK_REQUIREMENTS[task];
    const chosen = canServe(primary, need)
      ? primary
      : fallback && canServe(fallback, need)
        ? fallback
        : null;
    if (chosen) {
      taskModels[task] = { provider: chosen.provider, model: chosen.model };
    } else {
      unavailable.push({
        task,
        reason: need.toolCalling ? 'needs_tool_calling' : 'needs_embeddings',
      });
    }
  }
  return { taskModels, unavailable };
}
