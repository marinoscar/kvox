import { z } from 'zod';

// =============================================================================
// Topics promotion DTOs (#666, epic #661; docs/specs/ontology.md §11)
// =============================================================================
//
// `POST /api/graph/topics/promote` queues `kg.topics_promote`, which turns the
// free-text topics of the caller's past meetings into DRAFT Topic proposals;
// `GET /api/graph/topics/promote` reports where the latest run stands and how
// many topics are waiting for review. Both are the caller's own data.
// =============================================================================

/**
 * Zod schema for the response of `POST /api/graph/topics/promote`.
 *
 * @stability experimental
 */
export const topicsPromoteRequestResponseSchema = z.object({
  jobId: z.guid().describe('The queued `kg.topics_promote` job, or the run already in flight that this request joined.'),
  deduplicated: z.boolean().describe('True when a run was already pending or running and this request joined it.'),
});

/**
 * The parsed shape of {@link topicsPromoteRequestResponseSchema}.
 *
 * @stability experimental
 */
export type TopicsPromoteRequestResponse = z.infer<typeof topicsPromoteRequestResponseSchema>;

/**
 * Wire constant: the states of a topics-promotion run.
 *
 * @stability experimental
 */
export const TOPICS_PROMOTE_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;

/**
 * Zod schema for the response of `GET /api/graph/topics/promote`.
 *
 * @stability experimental
 */
export const topicsPromoteStatusSchema = z.object({
  job: z
    .object({
      id: z.guid().describe('The job id.'),
      status: z.enum(TOPICS_PROMOTE_STATUSES).describe('`succeeded` and `failed` are final.'),
      createdAt: z.iso.datetime().describe('When the run was queued.'),
      finishedAt: z.iso.datetime().nullable().describe('When the run settled; null while it has not.'),
    })
    .nullable()
    .describe('The latest run, or null when none was ever queued.'),
  proposedTopics: z
    .number()
    .int()
    .nonnegative()
    .describe('Draft Topic proposals from past meetings waiting for review. It grows while a run is working.'),
});

/**
 * The parsed shape of {@link topicsPromoteStatusSchema}.
 *
 * @stability experimental
 */
export type TopicsPromoteStatus = z.infer<typeof topicsPromoteStatusSchema>;
