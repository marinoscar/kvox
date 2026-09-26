import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ASK_CONTENT_MAX_CHARS, askMessageSchema } from './ask.dto';

// =============================================================================
// `POST /api/ask/conversations/:id/messages` (issue #378, epic #348)
// =============================================================================

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
export type PostAskMessage = z.infer<typeof postAskMessageSchema>;
export class PostAskMessageDto extends createZodDto(postAskMessageSchema) {}

export const postAskMessageResponseSchema = z.object({
  userMessage: askMessageSchema.describe('Your question, `complete`.'),
  assistantMessage: askMessageSchema.describe(
    'The answer, `pending` until `ask.respond` starts writing it. Stream it, or poll the conversation.',
  ),
});
export type PostAskMessageResponse = z.infer<typeof postAskMessageResponseSchema>;
export class PostAskMessageResponseDto extends createZodDto(postAskMessageResponseSchema) {}
