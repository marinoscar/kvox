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

/**
 * The job type string. Permanent once jobs of this type exist.
 *
 * @stability experimental
 */
export const ASK_RESPOND_JOB_TYPE = 'ask.respond';

/**
 * `jobs.subject_type` for an `ask.respond` job: the assistant message it answers into.
 *
 * @stability experimental
 */
export const ASK_MESSAGE_SUBJECT = 'ask_message';

const askRespondPayloadSchema = z.object({
  assistantMessageId: z.guid(),
  conversationId: z.guid(),
  userId: z.guid(),
  model: z.string().min(1),
  providerId: z.string().min(1),
  reasoningEffort: z.string().nullable().optional(),
  scope: z
    .object({ entityIds: z.array(z.guid()).optional(), evidenceIds: z.array(z.guid()).optional() })
    .optional(),
});

/**
 * The graph selection a question starts from, as the job carries it: ids only.
 *
 * @stability experimental
 */
export interface AskRespondScope {
  /** Entities the question is about. */
  entityIds?: string[];
  /** Evidence ids of the selected edge or path. */
  evidenceIds?: string[];
}

/**
 * The payload of an `ask.respond` job: identifiers and the model choice made at request time.
 *
 * @stability experimental
 */
export interface AskRespondPayload {
  /** The `pending` assistant message the turn answers into. */
  assistantMessageId: string;
  /** Its conversation. */
  conversationId: string;
  /** The asker, whose own key and permissions the turn uses. */
  userId: string;
  /** The model picked at request time (re-validated when the job runs). */
  model: string;
  /** The provider that model runs on. */
  providerId: string;
  /** The reasoning effort chosen at request time, when any. */
  reasoningEffort?: string | null;
  /** The graph selection the question starts from (GIC-17): ids only, re-checked when the job runs. */
  scope?: AskRespondScope;
}

/**
 * The payload, or `null` for one this build cannot read.
 *
 * @param payload - the job's stored payload.
 * @returns the parsed payload, or `null`.
 * @stability experimental
 */
export function readAskRespondPayload(payload: unknown): AskRespondPayload | null {
  const parsed = askRespondPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
