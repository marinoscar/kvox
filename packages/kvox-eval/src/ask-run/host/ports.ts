// =============================================================================
// The ports the headless Ask evaluation binds (issue #608)
// =============================================================================
//
// Ten ports, most of them the in-memory fakes of `@marinoscar/kvox-api/testing`.
// The four that are not:
//
//   prisma    the PGlite client (`db.ts`).
//   ai        the port under test (live: `createLiveKvoxAi`; replay: a scripted
//             runtime under `createKvoxAi`), handed in by the caller.
//   settings  in-memory, with the system `ai` namespace REGISTERED here: the
//             graph and Ask slices read it and none of them declares it (in the
//             web edition it is the platform AI slice's; the bare host declares
//             it in `bootstrap.ts`). The graph switch is ON, the caps are null
//             (the model's own limits govern), no reasoning parameter.
//   jobs      the fake queue, except `enqueueWithin`: `ask_messages.job_id` is a
//             foreign key to `jobs`, so the turn's job must be a REAL row written
//             in the caller's transaction (never on the pool: one connection).
//             Nothing claims it; the runner calls the handler itself.
//   identity  one principal, the evaluation user, holding the three read
//             permissions the Ask handler probes (graph, transcripts, notes).
// =============================================================================

import { z } from 'zod';

import { GRAPH_READ_PERMISSION } from '@marinoscar/kvox-api/graph';
import { NOTES_READ_PERMISSION } from '@marinoscar/kvox-api/notes';
import type { KvoxEnqueueInput, KvoxEnqueueResult, KvoxJobsPort, KvoxSettingsPort } from '@marinoscar/kvox-api/ports';
import {
  createFakeKvoxIdentity,
  createFakeKvoxJobs,
  createInMemoryKvoxSettings,
  type FakeKvoxIdentity,
} from '@marinoscar/kvox-api/testing';
import { TRANSCRIPTS_READ_PERMISSION } from '@marinoscar/kvox-api/transcripts';

/**
 * The permissions the evaluation user holds: what `ask.respond` probes for its
 * actor. Read-only on purpose; the agent writes nothing.
 *
 * @stability experimental
 */
export const ASK_EVAL_PERMISSIONS: readonly string[] = Object.freeze([
  GRAPH_READ_PERMISSION,
  TRANSCRIPTS_READ_PERMISSION,
  NOTES_READ_PERMISSION,
]);

/** The `ai` system namespace as the slices read it (the bare host declares the same shape). */
const aiNamespaceSchema = z.object({
  maxInputTokens: z.number().int().positive().nullable().default(null),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  maxDocumentBytes: z.number().int().positive().default(10 * 1024 * 1024),
  graphEnabled: z.boolean().default(true),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']).default('none'),
});

/**
 * In-memory settings with the system `ai` namespace declared and the graph switch on.
 *
 * @returns the settings port.
 * @stability experimental
 */
export function createAskEvalSettings(): KvoxSettingsPort {
  const settings = createInMemoryKvoxSettings();
  settings.registerNamespace({
    scope: 'system',
    name: 'ai',
    schema: aiNamespaceSchema,
    defaults: {
      maxInputTokens: null,
      maxOutputTokens: null,
      maxDocumentBytes: 10 * 1024 * 1024,
      graphEnabled: true,
      reasoningEffort: 'none',
    },
  });
  return settings;
}

/** What `enqueueWithin` needs of the caller's transaction. */
interface JobsTx {
  job: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
}

/**
 * The fake queue, with `enqueueWithin` writing a real `jobs` row in the caller's
 * transaction (the turn's `ask_messages.job_id` references it). Nothing claims
 * the row: the runner hands it to the handler directly.
 *
 * @param orgId - the organization every job row is stamped with (the default one).
 * @returns the jobs port.
 * @stability experimental
 */
export function createAskEvalJobs(orgId: string): KvoxJobsPort {
  const jobs: KvoxJobsPort = createFakeKvoxJobs();
  // Replaced in place: the fake's getters (`jobs`, `handlers`) stay live.
  jobs.enqueueWithin = async (tx: unknown, input: KvoxEnqueueInput): Promise<KvoxEnqueueResult> => {
    const row = await (tx as JobsTx).job.create({
      data: {
        type: input.type,
        reason: input.reason ?? 'upload',
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        priority: input.priority ?? 0,
        payload: input.payload,
        orgId,
      },
    });
    return { id: row.id, deduplicated: false };
  };
  return jobs;
}

/**
 * One principal: the evaluation user with {@link ASK_EVAL_PERMISSIONS}.
 *
 * @param userId - the evaluation user's id.
 * @param orgId - the default organization's id.
 * @returns the identity port.
 * @stability experimental
 */
export function createAskEvalIdentity(userId: string, orgId: string): FakeKvoxIdentity {
  return createFakeKvoxIdentity({ principal: { userId, orgId, permissions: ASK_EVAL_PERMISSIONS } });
}
