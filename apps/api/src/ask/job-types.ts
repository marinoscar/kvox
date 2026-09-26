import { z } from 'zod';

// =============================================================================
// `ask.respond` — the job type, its subject and its payload (issue #378)
// =============================================================================
//
// The payload carries IDENTIFIERS and the model choice made at request time;
// the handler re-reads the rows and RE-VALIDATES the model against today's
// policy (an administrator may have narrowed the permitted list since), the
// same discipline `kg.extract` follows.
// =============================================================================

/** Permanent once jobs of this type exist. */
export const ASK_RESPOND_JOB_TYPE = 'ask.respond';

/** `jobs.subject_type` for an `ask.respond` job: the assistant message it answers into. */
export const ASK_MESSAGE_SUBJECT = 'ask_message';

export const askRespondPayloadSchema = z.object({
  assistantMessageId: z.guid(),
  conversationId: z.guid(),
  userId: z.guid(),
  model: z.string().min(1),
  providerId: z.string().min(1),
  reasoningEffort: z.string().nullable().optional(),
});

export type AskRespondPayload = z.infer<typeof askRespondPayloadSchema>;

/** The payload, or `null` for one this build cannot read. */
export function readAskRespondPayload(payload: unknown): AskRespondPayload | null {
  const parsed = askRespondPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
