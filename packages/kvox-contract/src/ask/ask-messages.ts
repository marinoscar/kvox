import { z } from 'zod';
import { ASK_CONTENT_MAX_CHARS, askMessageSchema } from './ask.js';

// =============================================================================
// `POST /api/ask/conversations/:id/messages` (issue #378, epic #348)
// =============================================================================

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
