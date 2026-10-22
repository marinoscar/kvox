import { z } from 'zod';
import { ASK_CONTENT_MAX_CHARS, askMessageSchema } from './ask.js';

// =============================================================================
// `POST /api/ask/conversations/:id/messages` (issue #378, epic #348)
// =============================================================================

/**
 * Most entity ids, and most evidence ids, one turn's `scope` may carry.
 *
 * @stability experimental
 */
export const ASK_SCOPE_MAX_IDS = 50;

/**
 * Zod schema for the optional `scope` of a question: the graph handles the user selected before asking (the explorer's "Ask about this selection").
 *
 * @remarks
 * The ids are STARTING HANDLES, never evidence: the agent still retrieves evidence through its tools, and the graph is never a retrieval source on its own. Every id must be readable by the asker, otherwise the whole request is a 404. A `sensitive` PersonFact's evidence is never readable here.
 *
 * @stability experimental
 */
export const askScopeSchema = z
  .object({
    entityIds: z
      .array(z.uuid())
      .max(ASK_SCOPE_MAX_IDS)
      .optional()
      .describe(`Entities the question is about, at most ${ASK_SCOPE_MAX_IDS}.`),
    evidenceIds: z
      .array(z.uuid())
      .max(ASK_SCOPE_MAX_IDS)
      .optional()
      .describe(
        `Evidence ids of the selected edges or paths, at most ${ASK_SCOPE_MAX_IDS}. The agent starts from the entity, item or relation each one supports and reads the quote itself.`,
      ),
  })
  .describe('The graph selection the question starts from. Starting handles only; the agent still retrieves evidence.');
/**
 * The parsed shape of {@link askScopeSchema}.
 *
 * @stability experimental
 */
export type AskScope = z.infer<typeof askScopeSchema>;

/**
 * Zod schema for the post ask message wire shape.
 *
 * @stability experimental
 */
export const postAskMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1)
    .max(ASK_CONTENT_MAX_CHARS)
    .describe(`Your question, 1-${ASK_CONTENT_MAX_CHARS} characters.`),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Answer with this model instead of the `graph.agent` task model. Must be one this deployment permits and able to call tools.',
    ),
  scope: askScopeSchema.optional(),
});
/**
 * The parsed shape of {@link postAskMessageSchema}.
 *
 * @stability experimental
 */
export type PostAskMessage = z.infer<typeof postAskMessageSchema>;

/**
 * Zod schema for the post ask message response wire shape.
 *
 * @stability experimental
 */
export const postAskMessageResponseSchema = z.object({
  userMessage: askMessageSchema.describe('Your question, `complete`.'),
  assistantMessage: askMessageSchema.describe(
    'The answer, `pending` until `ask.respond` starts writing it. Stream it, or poll the conversation.',
  ),
});
/**
 * The parsed shape of {@link postAskMessageResponseSchema}.
 *
 * @stability experimental
 */
export type PostAskMessageResponse = z.infer<typeof postAskMessageResponseSchema>;
