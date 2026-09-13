// =============================================================================
// The job-settled event (issue #261, epic #254)
// =============================================================================
//
// EMITTED ONLY WHEN A JOB IS GENUINELY OVER — it reached `succeeded`, or it
// gave up and reached `failed`. A retry emits nothing. A rate-limit deferral
// emits nothing. That restraint is the entire value of the event.
//
// REJECTED: emitting on every state change (`job.running`, `job.retried`,
// `job.deferred`, `job.settled`). It looks more useful and is strictly less
// useful, because it moves work from here into every subscriber: a listener
// that wants to know "did this finish" would have to re-derive the answer
// from `status`, `attempts`, `rateLimitHits`, `scheduledFor` and the attempt
// budget — that is, to re-implement `JobTerminalService`'s decision, from
// outside, against config it does not read. Every subscriber would carry a
// copy of the retry logic, and each copy would be a place for the two to
// disagree. Emitting ONLY at the terminal branches means a subscriber can
// treat the event as what it says on the tin: this job is done, here is how
// it ended.
//
// The `status` on the carried row is what says WHICH ending it was, so there
// is one event rather than a `job.succeeded` / `job.failed` pair: a listener
// that cares about both (metrics, an admin activity feed, a notification)
// subscribes once, and a listener that cares about one branches on a field it
// has to read anyway.
//
// -----------------------------------------------------------------------------
// WHAT A LISTENER MAY ASSUME, AND WHAT IT MUST NOT
// -----------------------------------------------------------------------------
//
//   - It is emitted AFTER the row has been written, so the database already
//     agrees with the event. A listener that re-reads the job by id sees the
//     terminal row, not the running one.
//   - It is emitted through `EventEmitter2`, which dispatches
//     SYNCHRONOUSLY to listeners. `JobTerminalService` wraps the emit in
//     try/catch precisely so a throwing listener cannot affect the row that
//     was just written — but a listener that BLOCKS still blocks the worker
//     slot. Do real work in a queued job (there is a queue right here), not
//     in a listener.
//   - The carried `Job` is a snapshot as of the terminal write. It is not
//     live, and a `failed` job can later be re-run by an operator; the event
//     describes the ending that just happened, not a promise about the
//     future.
// =============================================================================

import { Job } from '@prisma/client';

/**
 * A job reached a terminal state.
 *
 * Carries the whole row (as `ObjectUploadedEvent` carries its
 * `StorageObject`) rather than a hand-picked subset: the row is already in
 * memory from the terminal `UPDATE ... RETURNING`, subsetting it would need
 * updating every time a listener wants one more field, and the accessors
 * below cover the questions a listener actually asks.
 */
export class JobSettledEvent {
  constructor(public readonly job: Job) {}

  get jobId(): string {
    return this.job.id;
  }

  /** The handler key — what KIND of work just finished. */
  get type(): string {
    return this.job.type;
  }

  /** `'succeeded'` or `'failed'`; never `pending` or `running`. */
  get status(): Job['status'] {
    return this.job.status;
  }

  get succeeded(): boolean {
    return this.job.status === 'succeeded';
  }

  /** The message from the final failure, when this job ended badly. */
  get lastError(): string | null {
    return this.job.lastError;
  }

  /** Which side ran it — `'server'` or `'node'`. Never cleared on settle. */
  get executor(): string | null {
    return this.job.executor;
  }

  get subjectType(): string | null {
    return this.job.subjectType;
  }

  get subjectId(): string | null {
    return this.job.subjectId;
  }
}

/**
 * The `EventEmitter2` key.
 *
 * Dotted and product-neutral, matching `OBJECT_UPLOADED_EVENT`
 * (`'storage.object.uploaded'`). Treat it as permanent: a listener in a fork
 * subscribes by string, so renaming it silently unsubscribes them.
 */
export const JOB_SETTLED_EVENT = 'job.settled';
