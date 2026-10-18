import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';
import type { JobHandler } from '@marinoscar/platform-api/jobs';
import { deleteGrantsForResources } from '@marinoscar/platform-api/sharing';
import { USER_DATA_DB, USER_DATA_TX_TIMEOUT_MS } from '@marinoscar/platform-api/user-data';
import type { UserDataDbPort } from '@marinoscar/platform-api/user-data';
import { ORG_OFFBOARD_JOB_TYPE } from '@marinoscar/platform-contract/user-data';
import { SEARCH_DOC_TRANSCRIPT } from '@marinoscar/kvox-contract/search';
import { z } from 'zod';

import { TRANSCRIPT_RESOURCE_TYPE } from '../../app-registrations/sharing';
import { runKvoxOrgStorageObjects } from '../../kvox-objects/factory-reset-storage.step';

// =============================================================================
// This app's steps of the platform's organization offboarding (issue #568)
// =============================================================================
//
// `org.offboard` (`OrgOffboardHandler`, `@marinoscar/platform-api/user-data`) deletes the
// organization's rows model by model, children first (its step 3), then the storage objects
// (its step 4, only when a model is flagged `storageObjects: true`), then invites and
// memberships, then the organization. It was written for an app whose content lives in `org`
// models. This app's content is owned by USERS (notes, graph, Ask) or by a user inside an
// organization (transcripts), and it is wrong here on three counts, the same as the factory
// reset (#562, `factory-reset.steps.ts`):
//
//   1. `StorageObject` IS NOT `storageObjects: true`, so the platform sees no storage plan:
//      no byte leaves the bucket, and step 3 runs `storage_objects.deleteMany({ orgId })`
//      as an ordinary `org` model. Transcripts, note exports, graph exports and transcript
//      versions and exports reference `storage_objects` with `onDelete: Restrict`, so on any
//      organization that holds a transcript that statement fails on the foreign key.
//   2. THE ORGANIZATION'S TRANSCRIPTS ARE DELEGATED CONTENT (`Transcript.orgId`, the only
//      content model besides `StorageObject` with an organization column). The platform's
//      org plan never reaches them, and `transcripts.org_id` is ON DELETE CASCADE, so the
//      organization row would delete them last, after step 3 had already failed or, were the
//      object rows gone, leaving the search index rows and the share grants (no foreign key
//      to either) behind.
//   3. THE SEARCH INDEX AND THE SHARES HAVE NO FOREIGN KEY to a document: nothing removes
//      them with a transcript.
//
// THE PLATFORM HANDLER HAS NO STEP SEAM (the factory reset has `registerFactoryResetStep`;
// offboarding has only `registerOffboardingPrecondition`, which runs before the enqueue). So
// `KvoxOrgOffboardBinding` wraps `process` of the registered `org.offboard` handler at
// `OnApplicationBootstrap` (after every handler self-registered in its `onModuleInit`): the
// wrapper runs the two steps below, then delegates to the platform's `process`, which then
// finds no storage object and no transcript of the organization and finishes the invites,
// memberships, users and the organization row. Wrapping in place (not `registry.register`)
// keeps the handler's identity, label, profile and node members, and avoids the registry's
// duplicate-type warning.
//
//   kvox.org.content          ONE transaction on the bypass client: the organization's
//                             transcripts and everything that Restricts them or their
//                             objects, in foreign-key order
//   kvox.org.storage-objects  every storage object of the organization outside the surviving
//                             prefixes: bytes, then the row. In `kvox-objects/`: that module
//                             alone may name the storage tables
//                             (`test/kvox-objects/storage-boundary.spec.ts`)
//
// WHAT AN ORGANIZATION OWNS HERE, per model (the organization column, or the path to it):
//
//   transcripts, storage_objects          `org_id` (direct)
//   transcript segments, speakers,        through `transcript.orgId`
//     versions, exports, name checks
//   kg_exports, note_exports              through `object.orgId` (the storage object they
//                                         Restrict)
//   notes                                 NO organization column. A note belongs to its owner,
//                                         who may belong to several organizations, so it is NOT
//                                         deleted; the references that Restrict a transcript or
//                                         an object of the organization are cleared
//                                         (`source_transcript_id`, `source_object_id`), as
//                                         `transcript.purge` does
//   search_chunks, search_index_state     no organization column and no foreign key: reached
//                                         by the ids of the organization's transcripts
//   grants (transcript shares)            reached by the same ids, through
//                                         `deleteGrantsForResources`
//   graph (kg_*), Ask, note templates     no organization column: user-owned, left alone. A
//                                         `kg_evidence` anchored to a deleted transcript is
//                                         set null by the foreign key; a mention is cascaded
//
// NEVER ANOTHER ORGANIZATION'S ROWS, NEVER THE DEFAULT ORGANIZATION'S: every statement is
// filtered to the offboarded `orgId`, and the wrapper skips both steps (delegating at once, so
// the platform refuses it) when the organization is missing or is the default one.
//
// RETRY SAFETY. Every statement is a `deleteMany`/`updateMany` by predicate, and the storage
// sweep selects what is left on every page, so a retried job (3 attempts) finishes the work.
// =============================================================================

const logger = new Logger('KvoxOrgOffboarding');

/** Transcript ids read per page when their index rows and grants are deleted. */
const TRANSCRIPT_ID_PAGE = 2000;

/** The part of the `org.offboard` payload the wrapper needs (the platform parses the rest). */
const orgPayloadSchema = z.object({ orgId: z.string().uuid() });

/** `deleteMany` on one model, returning the count. */
async function wipe(tx: any, model: string, where: Record<string, unknown>): Promise<number> {
  return (await tx[model].deleteMany({ where })).count as number;
}

/**
 * `kvox.org.content`: the organization's transcripts and what Restricts them, in foreign-key
 * order. Call it inside ONE transaction on the bypass client. See the header for the scope of
 * every statement.
 *
 * @param tx - the transaction client.
 * @param orgId - the organization being offboarded (never the default one: the caller checks).
 * @returns the counts of what went.
 */
export async function runKvoxOrgContent(tx: any, orgId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  // 1. The exports that Restrict an object of the organization. `kg_exports` and `note_exports`
  //    reference `storage_objects` with `onDelete: Restrict`; the notes and the graph
  //    themselves are user-owned and stay.
  counts.graphExports = await wipe(tx, 'kgExport', { object: { orgId } });
  counts.noteExports = await wipe(tx, 'noteExport', { object: { orgId } });

  // 2. Notes keep existing, but a note that cites a transcript or a source document of the
  //    organization would Restrict it (`source_transcript_id`, `source_object_id`).
  counts.notesDetached = (
    await tx.note.updateMany({
      where: { OR: [{ sourceTranscript: { orgId } }, { sourceObject: { orgId } }] },
      data: { sourceTranscriptId: null, sourceObjectId: null },
    })
  ).count as number;

  // 3. The search index rows and the share grants of the organization's transcripts. No foreign
  //    key points at a document, so nothing else removes them. Page the ids by cursor so a large
  //    organization never loads them all; only the platform helper touches the grants table.
  counts.searchChunks = 0;
  counts.searchIndexState = 0;
  counts.transcriptGrants = 0;
  for (let cursor: string | undefined; ; ) {
    const page: { id: string }[] = await tx.transcript.findMany({
      where: { orgId, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: TRANSCRIPT_ID_PAGE,
    });

    if (page.length === 0) break;

    const ids = page.map((t) => t.id);
    const documents = { documentType: SEARCH_DOC_TRANSCRIPT, documentId: { in: ids } };

    counts.searchChunks += await wipe(tx, 'searchChunk', documents); // search_embeddings cascade
    counts.searchIndexState += await wipe(tx, 'searchIndexState', documents);
    counts.transcriptGrants += await deleteGrantsForResources(tx, TRANSCRIPT_RESOURCE_TYPE, ids);
    cursor = ids[ids.length - 1];
  }

  // 4. The transcripts, children first. A segment Restricts its speaker, so segments first;
  //    versions and exports Restrict their objects (the sweep after this step deletes those).
  const ofOrg = { transcript: { orgId } };

  await wipe(tx, 'transcriptNameCheck', ofOrg); // suggestions cascade
  await wipe(tx, 'transcriptExport', ofOrg);
  await wipe(tx, 'transcriptVersion', ofOrg);
  await wipe(tx, 'transcriptSegment', ofOrg);
  await wipe(tx, 'transcriptSpeaker', ofOrg);
  counts.transcripts = await wipe(tx, 'transcript', { orgId });

  return counts;
}

/**
 * The two KVox steps for one `org.offboard` job: `kvox.org.content` in one transaction, then
 * `kvox.org.storage-objects`. Skips both (returns `null`) when the organization does not exist
 * or is the default one, leaving the refusal to the platform.
 *
 * @param db - the bypass client port (`USER_DATA_DB`).
 * @param job - the claimed job (`id`, `payload`).
 * @param txTimeoutMs - the content transaction's timeout.
 * @returns the content counts, or `null` when skipped.
 * @throws Error when a storage object could not be deleted (the job retries).
 */
export async function runKvoxOrgOffboardingSteps(
  db: Pick<UserDataDbPort, 'runAsSystem' | 'system'>,
  job: { id: string; payload?: unknown },
  txTimeoutMs: number = USER_DATA_TX_TIMEOUT_MS,
): Promise<Record<string, number> | null> {
  const parsed = orgPayloadSchema.safeParse(job.payload);

  if (!parsed.success) return null; // the platform rejects a malformed payload with its own message

  const { orgId } = parsed.data;
  const org: { id: string; isDefault: boolean } | null = await db
    .system('purge')
    .organization.findUnique({ where: { id: orgId }, select: { id: true, isDefault: true } });

  if (!org || org.isDefault) return null;

  const counts = await db.runAsSystem('purge', (tx) => runKvoxOrgContent(tx, orgId), { timeout: txTimeoutMs });

  logger.log(`org.offboard job ${job.id}: organization ${orgId} content ${JSON.stringify(counts)}`);

  await runKvoxOrgStorageObjects({ orgId, jobId: job.id });

  return counts;
}

/** Marks a handler this binding already wrapped, so a second bootstrap never wraps twice. */
const WRAPPED = Symbol.for('kvox.org-offboard.wrapped');

/**
 * Wraps `handler.process` so the KVox steps run first. Idempotent.
 *
 * @param handler - the registered `org.offboard` handler (mutated in place).
 * @param db - the bypass client port.
 * @param txTimeoutMs - the content transaction's timeout.
 * @returns whether it wrapped (false when it already was).
 */
export function wrapOrgOffboardHandler(
  handler: JobHandler,
  db: Pick<UserDataDbPort, 'runAsSystem' | 'system'>,
  txTimeoutMs: number = USER_DATA_TX_TIMEOUT_MS,
): boolean {
  const target = handler as JobHandler & { [WRAPPED]?: true };

  if (target[WRAPPED]) return false;

  const original = handler.process.bind(handler);

  handler.process = async (job) => {
    await runKvoxOrgOffboardingSteps(db, job as { id: string; payload?: unknown }, txTimeoutMs);

    return original(job);
  };
  target[WRAPPED] = true;

  return true;
}

/**
 * Installs the wrapper once every handler has registered (`OnApplicationBootstrap` runs after
 * every `onModuleInit`). A deployment whose user-data slice registered no `org.offboard`
 * handler is logged and skipped: nothing can enqueue the job then.
 */
@Injectable()
export class KvoxOrgOffboardBinding implements OnApplicationBootstrap {
  constructor(
    private readonly registry: JobHandlerRegistry,
    @Inject(USER_DATA_DB) private readonly db: UserDataDbPort,
  ) {}

  onApplicationBootstrap(): void {
    const handler = this.registry.get(ORG_OFFBOARD_JOB_TYPE);

    if (!handler) {
      logger.warn(`No "${ORG_OFFBOARD_JOB_TYPE}" handler is registered; the KVox offboarding steps were not installed`);

      return;
    }

    if (wrapOrgOffboardHandler(handler, this.db)) {
      logger.log(`KVox offboarding steps installed on "${ORG_OFFBOARD_JOB_TYPE}"`);
    }
  }
}
