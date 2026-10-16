import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { kvoxAiStoredSchema } from '../../platform/ai/ai-settings.extension';
import { AI_REASONING_EFFORTS, AI_TASK_KEYS } from '../ai-task-keys';

// =============================================================================
// DTOs of `/api/ai-tasks/*` (issue #473, epic #472)
// =============================================================================
//
// `GET /api/ai-tasks/config` keeps the response `GET /api/ai/config` always had
// (that path is the platform's now): the permitted models, whether the CALLER has
// a key, the connected-knowledge switch and, per task, the model it would run on.
// `GET|PUT /api/ai-tasks/settings` is the administrator's view of the fields this
// app adds to the platform `ai` namespace.
//
// ⚠ NO FIELD HERE CAN HOLD A KEY. `keyConfigured` is a boolean about the caller.
// =============================================================================

export const aiTasksConfigModelSchema = z.object({
  id: z.string().describe("The provider's own model id, e.g. `gpt-5.4`."),
  label: z.string().describe('Human name for a model picker.'),
  contextWindowTokens: z
    .number()
    .describe("The effective context window: the model's own, narrowed by the deployment's token policy."),
  maxOutputTokens: z
    .number()
    .describe("The effective output ceiling: the model's own, or the deployment's typed cap when smaller."),
  structuredOutput: z
    .boolean()
    .describe('Whether the model can return schema-constrained structured output. Graph extraction, matching and digest require it.'),
  toolCalling: z
    .boolean()
    .describe('Whether the model supports tool calling. The Ask agent requires it.'),
  source: z
    .enum(['explicit', 'catalogue', 'derived', 'default'])
    .describe('How the two numbers were learnt: `catalogue` when the model catalogue carries them, `default` for the conservative floor.'),
  derivedFrom: z
    .string()
    .nullable()
    .describe('The catalogue model id the numbers were inferred from; always null today.'),
});

export const aiTasksConfigTaskSchema = z.object({
  model: z
    .string()
    .nullable()
    .describe("The model this task runs on by default: the administrator's task model, else the default model. Null when no enabled model is available."),
  source: z
    .enum(['task', 'default', 'none'])
    .describe('`task`: chosen for this task; `default`: the deployment default model; `none`: nothing is available.'),
  reasoningEffort: z
    .enum(AI_REASONING_EFFORTS)
    .describe("The effort a run would use: the task's own when it runs on its configured model, else the deployment's."),
  requires: z
    .array(z.enum(['structuredOutput', 'toolCalling']))
    .describe("Capabilities the task's model must have."),
  usable: z.boolean().describe('Whether the task can run right now on `model`.'),
  reason: z
    .enum(['graph_disabled', 'model_lacks_capability', 'no_model'])
    .nullable()
    .describe('Why `usable` is false, or null when it is true.'),
});

export const aiTasksConfigSchema = z.object({
  available: z
    .boolean()
    .describe('True when AI is enabled, the provider slot is on and at least one model is enabled. Independent of `keyConfigured`.'),
  provider: z.string().nullable().describe('The provider id a key would belong to.'),
  providerLabel: z.string().nullable().describe('Human name of the provider.'),
  models: z.array(aiTasksConfigModelSchema).describe('The enabled models, ordered by id.'),
  defaultModel: z.string().nullable().describe('Which of `models` to offer first. Never a model absent from that list.'),
  maxInputTokens: z.number().nullable().describe("The deployment's optional cap on the assembled prompt, or null."),
  maxOutputTokens: z.number().nullable().describe("The deployment's optional cap on one answer, or null."),
  keyConfigured: z
    .boolean()
    .describe('Whether the CALLING user has saved an API key for the provider. The one field every AI surface gates on.'),
  graphEnabled: z.boolean().describe('Whether connected knowledge may spend AI on this deployment.'),
  taskModels: z
    .object(
      Object.fromEntries(AI_TASK_KEYS.map((key) => [key, aiTasksConfigTaskSchema])) as Record<
        (typeof AI_TASK_KEYS)[number],
        typeof aiTasksConfigTaskSchema
      >,
    )
    .describe('Every connected-knowledge task, always all four keys.'),
});

export class AiTasksConfigDto extends createZodDto(aiTasksConfigSchema) {}

export type AiTasksConfig = z.infer<typeof aiTasksConfigSchema>;
export type AiTasksConfigTask = z.infer<typeof aiTasksConfigTaskSchema>;
export type AiTasksConfigModel = z.infer<typeof aiTasksConfigModelSchema>;

// ---------------------------------------------------------------------------
// Settings (admin)
// ---------------------------------------------------------------------------

/** `PUT /api/ai-tasks/settings`: every field optional, a present field replaces the stored one. */
export const updateAiTasksSettingsSchema = kvoxAiStoredSchema.partial();

export class UpdateAiTasksSettingsDto extends createZodDto(updateAiTasksSettingsSchema) {}

export type UpdateAiTasksSettings = z.infer<typeof updateAiTasksSettingsSchema>;

const aiTaskDefinitionSchema = z.object({
  key: z.enum(AI_TASK_KEYS),
  label: z.string(),
  description: z.string(),
  requires: z.array(z.enum(['structuredOutput', 'toolCalling'])),
});

const aiTaskStatusSchema = z.object({
  task: z.enum(AI_TASK_KEYS),
  configuredModel: z.string().nullable().describe("The administrator's `taskModels[task].model`, or null when unset."),
  effectiveModel: z.string().nullable().describe('The model the task would run on, or null when none can be.'),
  source: z.enum(['task', 'default', 'none']),
  missing: z.array(z.enum(['structuredOutput', 'toolCalling'])),
  problem: z.enum(['lacks_capability', 'no_model']).nullable(),
  staleTaskModel: z
    .boolean()
    .describe('True when the configured task model is no longer enabled and the default is used instead.'),
});

const aiEnabledModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  structuredOutput: z.boolean(),
  toolCalling: z.boolean(),
});

export const aiTasksSettingsViewSchema = z.object({
  settings: kvoxAiStoredSchema,
  tasks: z.array(aiTaskDefinitionSchema).describe('Every connected-knowledge task with its label and requirements.'),
  models: z.array(aiEnabledModelSchema).describe('The enabled models of the active provider, with capability flags.'),
  taskModelStatus: z
    .array(aiTaskStatusSchema)
    .describe('What each task would run on right now, computed without the `graphEnabled` gate.'),
  version: z.number().describe('Bumped on every write of the `global` settings row. The `If-Match` token.'),
});

export class AiTasksSettingsViewDto extends createZodDto(aiTasksSettingsViewSchema) {}

export type AiTasksSettingsView = z.infer<typeof aiTasksSettingsViewSchema>;
