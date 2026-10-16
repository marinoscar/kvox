/**
 * The `/api/ai-tasks/*` client and the types behind it (issue #477, epic #472).
 *
 * WHAT THIS MODULE IS, AND WHAT IT REPLACED. The deployment's AI settings, the
 * provider keys and the model catalogue are the platform's now
 * (`@marinoscar/platform-web/ai/ui`: the AI, AI models, AI usage and AI Provider
 * pages). The app keeps exactly two server concerns that the platform has no
 * word for, and this module is the only client of both:
 *
 *   `GET /api/ai-tasks/config`    the capability probe every AI surface gates
 *                                 on. It is the old `GET /api/ai/config` moved
 *                                 (the platform owns that path now) and keeps
 *                                 its shape: the caller's `keyConfigured`, the
 *                                 permitted `models`, `graphEnabled` and what
 *                                 each connected-knowledge task would run on.
 *                                 Gate: `notes:read`.
 *   `GET|PUT /api/ai-tasks/settings`
 *                                 the per-task model map, the connected
 *                                 knowledge switch, the default model and the
 *                                 token / timeout / document ceilings, all
 *                                 fields of the `ai` system-settings namespace
 *                                 that the app extends. Gate: `ai_config:read`
 *                                 / `ai_config:write`.
 *
 * THE KEY IS NOT HERE. The caller's own key is saved, tested and removed on the
 * platform's `UserAiKeysPage` (`/api/ai/keys`), which returns a hint only.
 * Nothing in this module has a field that could hold key material, and the
 * browser never calls a provider.
 *
 * THE WIRE CONTRACT IS THE API'S. The types below mirror
 * `apps/api/src/ai-port/dto/ai-tasks.dto.ts` field for field (the response of
 * `GET /api/ai-tasks/config`, the document and its `version` of
 * `GET|PUT /api/ai-tasks/settings`), and the calls return the response as sent:
 * there is no normalisation and no alternative spelling to accept.
 */

import { api } from './api';

// =============================================================================
// Tasks
// =============================================================================

/**
 * The connected-knowledge tasks a model can be chosen for.
 *
 * ⚠ A VALUE HERE IS PERMANENT: it is a key of the stored `ai.taskModels` map.
 * There is deliberately no `graph.brief` (the entity brief never calls a model
 * inside a request; its prose is `graph.digest`'s output).
 */
export const AI_TASK_KEYS = [
  'graph.extract',
  'graph.adjudicate',
  'graph.digest',
  'graph.agent',
] as const;

export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/** A capability a task may require of its model. */
export type AiModelCapability = 'structuredOutput' | 'toolCalling';

/**
 * Per-task reasoning effort. A narrower set than {@link AiReasoningEffort}:
 * ABSENT is how "follow the page-wide setting" is spelled, so there is no
 * `'none'` here to mean a second thing.
 */
export type AiTaskReasoningEffort = 'low' | 'medium' | 'high';

/** One task's stored choice. Absent `reasoningEffort` follows the page-wide one. */
export interface AiTaskModel {
  model: string;
  reasoningEffort?: AiTaskReasoningEffort;
}

/** One task as the admin form describes it. */
export interface AiTaskDefinition {
  key: AiTaskKey;
  label: string;
  description: string;
  requires: AiModelCapability[];
}

// =============================================================================
// GET /api/ai-tasks/config — the capability probe
// =============================================================================

/**
 * How hard a reasoning-capable model is asked to think. `'none'` is a VALUE
 * (omit the parameter), not an absence.
 *
 * ⚠ `'xhigh'` RUNS AS `'high'`. The platform's AI runtime accepts
 * `minimal | low | medium | high`, so the API clamps `xhigh` to `high` before
 * the call. The value is kept (rather than removed) so a stored setting still
 * reads back; the admin form says so beside the control.
 */
export type AiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/** One enabled model, with the numbers narrowed by the deployment's token policy. */
export interface AiTasksConfigModel {
  /** The provider's own model id, e.g. `gpt-5.4`. */
  id: string;
  label: string;
  /** The effective context window: the model's own, narrowed by the token policy. */
  contextWindowTokens: number;
  /** The effective output ceiling: the model's own, or the deployment's cap when smaller. */
  maxOutputTokens: number;
  /** Whether the model can return schema-constrained JSON. */
  structuredOutput: boolean;
  /** Whether the model can call tools. */
  toolCalling: boolean;
  /** How the two numbers were learnt; `default` is the conservative floor. */
  source: 'explicit' | 'catalogue' | 'derived' | 'default';
  derivedFrom: string | null;
}

/** What one connected-knowledge task would run on for THIS caller. */
export interface AiTasksConfigTaskModel {
  /** The task model, else the default; null when no enabled model is available. */
  model: string | null;
  /** `task`: chosen for this task; `default`: the deployment default; `none`: nothing. */
  source: 'task' | 'default' | 'none';
  reasoningEffort: AiReasoningEffort;
  requires: AiModelCapability[];
  /** Whether the task can run right now on `model`. */
  usable: boolean;
  /** Why `usable` is false, or null when it is true. */
  reason: 'graph_disabled' | 'model_lacks_capability' | 'no_model' | null;
}

/**
 * `GET /api/ai-tasks/config`.
 *
 * ⚠ `keyConfigured` IS THE SINGLE BOOLEAN EVERY AI SURFACE GATES ON, and it
 * describes the CALLER (they have saved a key), not the deployment. It is
 * independent of `available` (the deployment can do AI) so a surface can say
 * "your administrator has not turned this on" and "you have not added a key" as
 * the two different sentences they are.
 */
export interface AiTasksConfig {
  /** AI is enabled, the provider slot is on and at least one model is enabled. */
  available: boolean;
  /** The provider id a key would belong to. */
  provider: string | null;
  /** Human name of the provider, for the "this is sent to …" disclosure. */
  providerLabel: string | null;
  /** The enabled models, ordered by id. */
  models: AiTasksConfigModel[];
  /** Which of `models` to offer first; never a model absent from that list. */
  defaultModel: string | null;
  /** The deployment's optional cap on the assembled prompt, or null. */
  maxInputTokens: number | null;
  /** The deployment's optional cap on one answer, or null. */
  maxOutputTokens: number | null;
  /** Whether **the calling user** has saved a key for the provider. */
  keyConfigured: boolean;
  /** Whether connected knowledge may spend AI on this deployment. */
  graphEnabled: boolean;
  /** What each connected-knowledge task would run on for THIS caller; always all four keys. */
  taskModels: Record<AiTaskKey, AiTasksConfigTaskModel>;
}

/** `GET /api/ai-tasks/config` — `notes:read`, seeded to every role. */
export async function getAiTasksConfig(): Promise<AiTasksConfig> {
  return api.get<AiTasksConfig>('/ai-tasks/config');
}

// =============================================================================
// GET|PUT /api/ai-tasks/settings — the admin document
// =============================================================================

/** The editable document. Every field is a field of the extended `ai` namespace. */
export interface AiTasksSettings {
  /** REPLACES wholesale on write: send the full map, omitting tasks left on Default. */
  taskModels: Partial<Record<AiTaskKey, AiTaskModel>>;
  /** The connected-knowledge SPENDING switch. */
  graphEnabled: boolean;
  /** The model a task with no model of its own runs on; `null` = none chosen. */
  defaultModel: string | null;
  /** Optional spend cap on the assembled prompt; `null` = the model's own window governs. */
  maxInputTokens: number | null;
  /** Optional cap on one answer; `null` = the model's own ceiling governs. */
  maxOutputTokens: number | null;
  requestTimeoutMs: number;
  maxDocumentBytes: number;
  /** Page-wide reasoning effort. */
  reasoningEffort: AiReasoningEffort;
}

/** An enabled model with its capability flags, as the settings document lists them. */
export interface AiTasksEnabledModel {
  id: string;
  label: string;
  structuredOutput: boolean;
  toolCalling: boolean;
}

/**
 * How the SAVED policy resolves for one task, computed by the server WITHOUT the
 * `graphEnabled` gate so an administrator can configure tasks before switching
 * the feature on.
 */
export interface AiTaskModelStatus {
  task: AiTaskKey;
  /** What the administrator saved for the task, or null on Default. */
  configuredModel: string | null;
  /** The model the task would run on, or null when none can be. */
  effectiveModel: string | null;
  source: 'task' | 'default' | 'none';
  /** Capabilities the effective model lacks. */
  missing: AiModelCapability[];
  problem: 'lacks_capability' | 'no_model' | null;
  /** The configured task model is no longer enabled and the default is used instead. */
  staleTaskModel: boolean;
}

/** `GET /api/ai-tasks/settings`: the document, the task copy, the models and the status. */
export interface AiTasksSettingsView {
  settings: AiTasksSettings;
  /** Every connected-knowledge task with its label and requirements. */
  tasks: AiTaskDefinition[];
  /** The enabled models of the active provider, with capability flags. */
  models: AiTasksEnabledModel[];
  taskModelStatus: AiTaskModelStatus[];
  /** Bumped on every write of the `global` settings row; sent back as `If-Match`. */
  version: number;
}

/** Bounds the admin form mirrors from the `ai` namespace's stored schema. */
export const AI_TASKS_BOUNDS = {
  maxInputTokens: { min: 256, max: 2_000_000 },
  maxOutputTokens: { min: 64, max: 200_000 },
  requestTimeoutMs: { min: 1_000, max: 3_600_000 },
  maxDocumentBytes: { min: 65_536, max: 268_435_456 },
} as const;

/** `GET /api/ai-tasks/settings` — `ai_config:read`. */
export async function getAiTasksSettings(): Promise<AiTasksSettingsView> {
  return api.get<AiTasksSettingsView>('/ai-tasks/settings');
}

/**
 * `PUT /api/ai-tasks/settings` — `ai_config:write`, `If-Match: <version>`.
 *
 * The API validates each task model against the enabled catalogue: a 400 with
 * `details.reason` of `model_not_permitted` or `model_lacks_capability` (and
 * `details.task`) names the offending task; a stale `version` is a 409.
 */
export async function putAiTasksSettings(
  values: AiTasksSettings,
  version: number,
): Promise<AiTasksSettingsView> {
  return api.put<AiTasksSettingsView>('/ai-tasks/settings', values, {
    headers: { 'If-Match': String(version) },
  });
}
