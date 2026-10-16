import { z } from 'zod';

// =============================================================================
// AI task keys and the per-task model schema (issue #473, epic #472)
// =============================================================================
//
// The vocabulary of `ai.taskModels`: which connected-knowledge tasks an
// administrator can pick a model for, and the reasoning efforts the product has
// always offered. Copied from the retired `ai/ai-settings.schema.ts` (deleted in
// #477); the values are the stored ones and are byte-for-byte the same.
//
// ⚠ A TASK KEY IS PERMANENT ONCE AN ADMINISTRATOR HAS SAVED A MODEL FOR IT: it is
// a key of the stored `ai.taskModels` map, and renaming one silently drops that
// choice. There is deliberately no `graph.brief` (the entity brief never calls a
// model inside a request; its prose is `graph.digest`'s output).
// =============================================================================

/** How hard a reasoning model may think, cheapest first. `none` omits the parameter. */
export const AI_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

/** One reasoning effort. */
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

/** The AI tasks connected knowledge makes model calls for. */
export const AI_TASK_KEYS = [
  'graph.extract',
  'graph.adjudicate',
  'graph.digest',
  'graph.agent',
] as const;

/** One AI task. */
export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/** The reasoning efforts a per-task override may name (a subset of the above). */
export const AI_TASK_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;

/** One per-task reasoning effort. */
export type AiTaskReasoningEffort = (typeof AI_TASK_REASONING_EFFORTS)[number];

/** One `ai.taskModels` entry. Carries no secret-bearing field. */
export const aiTaskModelSchema = z.object({
  model: z.string().trim().min(1).max(128),
  reasoningEffort: z.enum(AI_TASK_REASONING_EFFORTS).optional(),
});

export type AiTaskModel = z.infer<typeof aiTaskModelSchema>;

/**
 * The per-task model map. `z.partialRecord`, not `z.record`: Zod 4's record over
 * an enum is exhaustive, and an absent task key is the ordinary case ("use the
 * default model").
 */
export const aiTaskModelsSchema = z.partialRecord(z.enum(AI_TASK_KEYS), aiTaskModelSchema);

export type AiTaskModels = z.infer<typeof aiTaskModelsSchema>;
