// =============================================================================
// Resolving a job's INPUT OBJECT, and failing loudly when there isn't one
// (issue #269, epic #254)
// =============================================================================
//
// THIS FILE EXISTS BECAUSE OF A SPECIFIC PRODUCTION FAILURE IN THE
// APPLICATION THIS DESIGN WAS EXTRACTED FROM, and reproducing that failure
// here would be the easiest mistake in the whole epic to make.
//
// There, a worker resolved its input by reading a path out of a row and
// handing it straight to a stream open. When the row was missing, or the
// column was null, or the subject pointed at something that had been deleted,
// the "path" was the empty string — and the job died with:
//
//     Error: ENOENT: no such file or directory, open ''
//
// That message names nothing. Not the job, not the type, not the subject, not
// which of the three things was missing. An operator reading it learns only
// that a file was not found, and the file it was not found at has no name; the
// real cause (a job enqueued against a subject that no longer exists) is
// several inferences away, and the same message appears for three unrelated
// causes. Jobs that fail this way are retried to exhaustion, because nothing
// about the error suggests it is permanent.
//
// The fix is not defensive coding sprinkled at the call sites. It is ONE
// resolver, with THREE NAMED FAILURES, used by every caller that needs a
// job's input bytes:
//
//   - `missing_subject_id`             — the job names no subject at all
//   - `input_object_not_found`         — the subject id names no row
//   - `input_object_has_no_storage_key`— the row exists but holds no key
//
// Each is a distinct, permanent, actionable state, and each says which one it
// is in a message a human can act on without opening a database client. None
// of the three can produce an empty path, because the empty path is never
// constructed: the resolver returns a validated row or it throws.
//
// -----------------------------------------------------------------------------
// WHY IT IS A PLAIN FUNCTION RATHER THAN AN INJECTABLE SERVICE
// -----------------------------------------------------------------------------
//
// It has exactly two callers and they live in modules that must not be able
// to reach each other: `ExampleChecksumHandler` (in `JobsModule`, resolving
// the input it is about to hash on the server) and `NodeDataPlaneService` (in
// `NodesModule`, resolving the input it is about to mint a download URL for).
// A service would mean one of those modules exporting it and the other
// importing it — and `NodesModule` already imports `JobsModule`, so the
// dependency would run in the one direction the queue is deliberately kept
// free of ("the queue does not need to know that nodes exist",
// `nodes.module.ts`).
//
// A pure function taking the client it should query has no module, no
// provider, no export list and no direction. It is the same reasoning
// `resolveJobLeaseMs` and `resolveWorkerConcurrency` are exported functions
// out of `job.worker.ts` rather than methods on something injectable: a
// second caller appeared, and what it needed was a computation, not a
// collaborator.
//
// -----------------------------------------------------------------------------
// WHY THE ERROR IS A PLAIN CLASS AND NOT AN `HttpException`
// -----------------------------------------------------------------------------
//
// The two callers need opposite things from a failure. The node data plane
// needs an HTTP status (it is answering a request); the handler needs a
// throw that the worker turns into `Job.lastError` and an attempt (it is
// running a job, and `job-handler.interface.ts` says handlers fail by
// throwing). An `HttpException` thrown from a handler would be a transport
// concern leaking into background execution, and a status code recorded in
// `lastError` reads as noise to whoever finds it there.
//
// So the resolver throws a transport-agnostic error carrying a machine-
// readable `reason`, and `NodeDataPlaneService` — the only caller that speaks
// HTTP — is the one place that maps it to a status.
// =============================================================================

import { Job, StorageObject } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * The `Job.subjectType` a job carries when its subject is a stored object.
 *
 * Exported so the handler, the resolver and the tests all name it once. It
 * matches what `ObjectsService` and the storage processors already use, so a
 * job enqueued against an upload is describable without a new vocabulary.
 */
export const STORAGE_OBJECT_SUBJECT_TYPE = 'storage_object';

/** Which of the three ways input resolution can fail. */
export type JobInputFailureReason =
  | 'missing_subject_id'
  | 'input_object_not_found'
  | 'input_object_has_no_storage_key';

/**
 * A job whose input cannot be resolved — PERMANENTLY, in every case.
 *
 * All three reasons describe a job that will fail identically on every
 * retry: a subject that was never set does not appear later, a deleted row
 * does not come back, and a row with no storage key has no bytes to read. The
 * message says which one it is and names the job, so the admin job list shows
 * a `lastError` an operator can act on rather than one they have to
 * investigate.
 */
export class JobInputResolutionError extends Error {
  constructor(
    readonly reason: JobInputFailureReason,
    message: string,
    readonly jobId: string,
    readonly subjectId: string | null
  ) {
    super(message);
    this.name = 'JobInputResolutionError';
  }
}

/**
 * The `StorageObject` a job names as its input, guaranteed to carry a
 * non-empty `storageKey`.
 *
 * ⚠ THE RETURN VALUE IS THE GUARANTEE. Callers do not check anything
 * afterwards: if this returns, `storageKey` is a real, non-empty string, and
 * that is the whole reason the empty-path failure mode above cannot recur. A
 * caller that "helpfully" fell back to `object?.storageKey ?? ''` on a throw
 * would reintroduce it in one line.
 *
 * `subjectType` is deliberately NOT checked here. A job's subject type is the
 * handler's business — a fork may legitimately name its own subject type for a
 * row in this table — and a resolver that insisted on
 * `'storage_object'` would refuse work it can perform perfectly well, for a
 * label. What it checks is what it actually needs: an id, a row, and a key.
 */
export async function resolveStorageObjectInput(
  prisma: PrismaService,
  job: Job
): Promise<StorageObject> {
  if (!job.subjectId) {
    throw new JobInputResolutionError(
      'missing_subject_id',
      `Job ${job.id} (${job.type}) names no subjectId, so it has no input object to read. ` +
        `A job of this type must be enqueued with subjectType "${STORAGE_OBJECT_SUBJECT_TYPE}" ` +
        `and the StorageObject's id as subjectId.`,
      job.id,
      null
    );
  }

  const object = await prisma.storageObject.findUnique({
    where: { id: job.subjectId },
  });

  if (!object) {
    throw new JobInputResolutionError(
      'input_object_not_found',
      `Job ${job.id} (${job.type}) names storage object ${job.subjectId}, which does not ` +
        `exist. It was most likely deleted after this job was enqueued; this job cannot ` +
        `succeed on any retry.`,
      job.id,
      job.subjectId
    );
  }

  // A `storage_key` that is present but empty is the exact shape that produced
  // `ENOENT … open ''`. The column is non-nullable, so this is not a
  // type-system possibility — it is a data possibility, and it is checked
  // because the cost of being wrong is an unreadable error on someone else's
  // machine.
  if (!object.storageKey || object.storageKey.trim().length === 0) {
    throw new JobInputResolutionError(
      'input_object_has_no_storage_key',
      `Job ${job.id} (${job.type}) names storage object ${object.id}, which has no ` +
        `storageKey — there are no bytes to read. The object's upload never completed, or ` +
        `the row was written by something that did not set a key.`,
      job.id,
      object.id
    );
  }

  return object;
}
