// =============================================================================
// Job handler contract (issue #259, epic #254)
// =============================================================================
//
// THE EXTENSION POINT OF THE WHOLE QUEUE, and deliberately the smallest thing
// that can be one. Epic #254's headline promise is that a fork adds a new
// background job type with ONE class and no queue wiring: no migration (the
// `jobs` table stores `type` as a plain string precisely so a new handler
// costs zero schema change — see the `Job` model's own comment in
// prisma/schema.prisma), no enum arm, no `switch` in a worker, no entry in a
// central dispatch table. That promise is only true if the worker's entire
// knowledge of a job type is "ask the registry for a handler with this
// `type`, call `process`" — which is what the interface below is, and why it
// has exactly two required members.
//
// The same argument `notification-events.ts` makes for notifications and
// `object-processor.interface.ts` makes for post-upload processing, applied
// to background work: the framework owns the mechanism, the feature owns one
// class, and neither has to edit the other.
//
// -----------------------------------------------------------------------------
// `process` THROWS TO FAIL — IT DOES NOT RETURN A RESULT OBJECT
// -----------------------------------------------------------------------------
//
// `Promise<void>` and "throw to fail" rather than
// `ObjectProcessor`-style `Promise<{ success, error }>`. The two contracts
// look similar and are answering different questions, so the difference is
// deliberate:
//
//   - An object processor is one of SEVERAL processors run in sequence over
//     the same upload, and one failing must not abort the others. It needs to
//     report a per-processor outcome that the pipeline aggregates into
//     metadata, so a result object is right there.
//   - A job handler IS the job. There is nothing to aggregate: the job either
//     completed or it did not, and "did not" must be visible to the retry
//     machinery (#263) as `attempts`, `lastError` and a `failed` status.
//
// A returned `{ success: false }` would have to be converted into a throw
// somewhere anyway, and a handler that forgot to check an inner promise would
// return `{ success: true }` for work that never happened. Throwing is the
// default failure mode of every async call a handler makes — an unawaited-but-
// awaited rejection, a database error, a fetch timeout — so "throw to fail"
// means a handler gets correct failure behaviour by writing NO error handling
// at all. Swallowing an error is then the visible, deliberate act (a
// `try/catch` in the handler that does not rethrow), which is the right way
// round: a job that silently reports success is far worse than one that
// retries something it did not need to.
//
// The message on the thrown error is what lands in `Job.lastError`, so throw
// something a human reading the admin job list can act on.
//
// -----------------------------------------------------------------------------
// NODE ELIGIBILITY: THE OPTIONAL PAIR *IS* THE MECHANISM
// -----------------------------------------------------------------------------
//
// Later in this epic, work can be computed on a remote worker node instead of
// on the API server: the node receives a claimed job, does the expensive part
// with no database access of its own, and POSTs a result back for the server
// to persist. Not every job type can work that way — a handler that reads
// three tables mid-computation, or that streams a file out of object storage,
// or that writes as it goes, is server-only by nature.
//
// The system's ONE source of truth for that distinction is the presence of
// the two optional members below:
//
//   - A handler carrying BOTH `nodeResultSchema` and `persistNodeResult` is
//     NODE-ELIGIBLE: its work can be computed remotely (the schema is how the
//     server validates the untrusted payload a node posts back) and its
//     result can then be written down (that is what `persistNodeResult` does).
//   - A handler carrying NEITHER is SERVER-ONLY. This is the default, and it
//     is what every handler is until someone deliberately adds both members.
//   - A handler carrying exactly ONE of the two is SERVER-ONLY, not a
//     half-eligible special case. A schema with no persist function describes
//     a payload nobody can store; a persist function with no schema would have
//     to trust an unvalidated body from a remote machine. Neither is a state
//     the node plane can safely act on, so both collapse to the safe answer.
//     `JobHandlerRegistry.serverOnlyTypes()` derives exactly this, and it is
//     what makes the later `system` worker mode ("run everything that CANNOT
//     go to a node") possible with no second list to maintain.
//
// REJECTED: a `readonly nodeEligible: boolean` flag alongside the members.
// A flag is a second statement of a fact the members already state, so it can
// disagree with them — `nodeEligible: true` on a handler with no
// `persistNodeResult` is a job dispatched to a node whose result the server
// then cannot store, and the failure surfaces on a remote machine at runtime
// rather than in review. Deriving eligibility from the members makes that
// wrong state unrepresentable: there is nothing to set inconsistently. See
// docs/specs/job-queue.md for the full argument.
//
// -----------------------------------------------------------------------------
// `persistNodeResult` DOES THE PERSIST HALF AND NOTHING ELSE
// -----------------------------------------------------------------------------
//
// This is a hard rule, not a style preference, and it is what keeps a remote
// node from needing database access. The split is:
//
//     node   →  compute the result  (no DB, no secrets, no app tables)
//     server →  validate it against `nodeResultSchema`, then
//               `persistNodeResult` writes it down
//
// So `persistNodeResult` MUST NOT recompute the work, re-download the input,
// call the provider again, or "fix up" a result it dislikes. It takes the
// already-validated value and writes it. The moment it does any of the other
// things, the node's computation stops being the source of the result — the
// server is doing the work twice, the node's answer is decorative, and the
// whole reason for the node plane (expensive work off the API server) is
// gone. If a result cannot be persisted without recomputation, the type is
// not node-eligible: drop both members and let it run server-side.
//
// The `result: unknown` parameter type is deliberate: `notify()`'s `data:
// unknown` makes the same trade. The value arrives from off-machine, so it is
// untrusted by construction, and `nodeResultSchema` is the only thing that
// may narrow it. Parse, then use the parse's output type.
//
// -----------------------------------------------------------------------------
// `deriveOutputKey` MOVES THE KEY CHOICE, IT DOES NOT SURRENDER IT (#348, epic #345)
// -----------------------------------------------------------------------------
//
// `NodeDataPlaneService.createUploadTarget` used to hard-code where every
// node-written output lands: `node-outputs/<jobId>/<uuid>`. That is exactly
// right for a checksum's scratch output — nothing outside the job ever names
// it — and exactly wrong for any type whose artifact has a REQUIRED,
// EXTERNALLY-REFERENCED location. A database backup's key is
// `buildBackupStorageKey(at, runId)` and its `database_backup_runs` row
// records `storage_key`/`bucket`/`format` so the archive stays locatable
// across a bucket rename; the same archive written to `node-outputs/…` is one
// the retention sweep, the download endpoint and the restore path cannot
// find. With one constant in the data plane, NO type whose output has a
// required location could ever be node-eligible.
//
// ⚠ THE SERVER STILL CHOOSES THE KEY. This member moves that choice from a
// constant in the data plane to the handler that OWNS the artifact — both of
// which are this server. The node's influence stays exactly zero: a
// caller-supplied `key` is still a 400 (`rejectCallerSuppliedFields`), the
// chosen key is still returned so the node can name it back in its result,
// and no `storage_objects` row is created at mint time. Nothing about the
// data plane's posture changes; only who inside the server answers "where".
//
// The consequence for the data plane is that `SAFE_STORAGE_KEY` stops being
// defensive code about a template it fully controls and becomes the real
// guard on a value a handler computed — which is why a failure there is a
// 500, not a 400: the fault is in a handler, not in anything a node sent.
//
// -----------------------------------------------------------------------------
// `nodeSecretBroker` — PRESENCE IS THE DECLARATION, AGAIN (#349, epic #345)
// -----------------------------------------------------------------------------
//
// The node plane's founding constraint is that a node holds NO credentials
// (`docs/specs/worker-nodes.md` §8), which is why it could only ever run pure
// compute over presigned bytes. Some work genuinely needs one — a `pg_dump`
// needs a database connection — so a handler may carry a BROKER: an object
// that mints a short-lived, job-scoped credential and can destroy it again.
//
// It follows the same rule as node eligibility above, and for the same reason.
// The broker's PRESENCE is the declaration; there is no `requiresSecret:
// 'postgres'` string and no central switch in the nodes module mapping such a
// string onto an implementation. That switch is exactly the central dispatch
// table this file exists to abolish, and it makes an inconsistent state
// representable — a type naming a secret nobody can mint — which is the same
// defect a `nodeEligible: boolean` flag has. Hanging the implementation itself
// off the handler leaves nothing to set inconsistently.
//
// `job-secret-broker.ts` carries the full argument, including the three
// rejected ways of getting a credential onto a node and why the material is
// never persisted in any form.
//
// REJECTED: a `readonly keyPrefix: string` on the handler. It covers a prefix
// and not the `buildBackupStorageKey(at, runId)` SHAPE, and — the part that
// kills it — it cannot create the artifact row the key's `runId` comes from.
// REJECTED: minting the key at claim time and shipping it in the assignment,
// for the same reason the spec already rejects folding signed URLs into the
// claim: a node claiming its whole `concurrency` at once would have the last
// job's key derived long before that job starts.
// =============================================================================

import { Job } from '@prisma/client';
import type { z } from 'zod';

import type { JobExecutionProfile } from './job-execution-profile';
import type { JobSecretBroker } from './job-secret-broker';

/**
 * DI token for job handlers.
 *
 * Present for symmetry with `OBJECT_PROCESSOR` and
 * `NOTIFICATION_CHANNEL_SENDERS`, and so a fork that prefers to collect
 * handlers with a `multi`-style provider array has a token to collect them
 * under. Note that the registration path this epic actually uses is
 * SELF-REGISTRATION from each handler's own `OnModuleInit` — see
 * `job-handler.registry.ts` for why, and `handlers/README.md` for the recipe.
 */
export const JOB_HANDLER = Symbol('JOB_HANDLER');

export interface JobHandler {
  /**
   * The `Job.type` value this handler is responsible for.
   *
   * The registry keys on this string and the worker dispatches on it, so it
   * must be unique across every handler in the process — a duplicate
   * overwrites, loudly (see `JobHandlerRegistry.register`). Use a dotted,
   * lowercase, product-neutral key (`'email.send'`, `'export.csv'`), and
   * treat it as PERMANENT once jobs of that type exist: rows outlive the
   * handler that produced them, and renaming the key orphans every historical
   * row and every pending job already queued under the old name.
   */
  readonly type: string;

  /**
   * Runs the job.
   *
   * THROW TO FAIL — the worker turns a rejection into `Job.lastError` plus a
   * retry (or a terminal `failed` status once the attempt budget is spent).
   * Returning normally means the work is done and durable; do not return
   * before the writes this job is responsible for have committed.
   *
   * Should be IDEMPOTENT wherever the underlying operation allows it. A job
   * can legitimately run more than once: a retry after a partial failure, or
   * a lease that expired because the executing process was killed mid-run and
   * another worker reclaimed it. The queue guarantees at-least-once, never
   * exactly-once.
   */
  process(job: Job): Promise<void>;

  /**
   * How this type is allowed to run, when the deployment-wide defaults are
   * wrong for it.
   *
   * OPTIONAL, AND OMITTING IT IS THE NORMAL ANSWER. A handler with no profile
   * runs on `JOBS_JOB_TIMEOUT_MS` and `JOBS_MAX_ATTEMPTS` exactly as every
   * handler did before profiles existed. Declare one only when this type is
   * genuinely unlike the rest of the queue — a job that legitimately runs for
   * hours, or one that must never be automatically retried.
   *
   * ⚠ TWO NUMBERS, AND THERE WILL ONLY EVER BE TWO. You may not declare a
   * lease length here, and you may not declare a renewal interval: those are
   * DERIVED from `maxRuntimeMs` (`resolveJobLeaseMs`,
   * `resolveRenewIntervalMs`) precisely because they are the values that can
   * DISAGREE with it. A lease shorter than the runtime ceiling is a job that
   * reaps itself into duplicate execution; a renewal interval at or above the
   * lease is a renewal that always arrives too late. Deriving them makes both
   * states unrepresentable — the same argument this file's header already
   * makes against a `nodeEligible` flag, applied to durations. See
   * `job-execution-profile.ts` for the full version, and do not add a third
   * field to that interface.
   */
  readonly profile?: JobExecutionProfile;

  /**
   * Validates the result a remote worker node posts back for this job type.
   *
   * PRESENT ONLY ON NODE-ELIGIBLE HANDLERS, and only ever together with
   * `persistNodeResult` — see the file header: both members or neither, and
   * exactly one of the two means server-only.
   *
   * The value it parses arrives from a machine the API server does not
   * control, so this schema is a trust boundary, not a convenience: it is the
   * only thing standing between an arbitrary remote body and
   * `persistNodeResult`'s writes.
   */
  readonly nodeResultSchema?: z.ZodType;

  /**
   * Writes down a node-computed result that `nodeResultSchema` has already
   * validated.
   *
   * PRESENT ONLY ON NODE-ELIGIBLE HANDLERS (see `nodeResultSchema`).
   *
   * PERSIST ONLY. No recomputation, no re-downloading the input, no second
   * call to whatever provider the node used — the file header explains why
   * that rule is what keeps a node from needing database access at all. If
   * this method cannot do its job without redoing the work, the type is not
   * node-eligible.
   *
   * Throwing here fails the job exactly as throwing from `process` does.
   */
  persistNodeResult?(job: Job, result: unknown): Promise<void>;

  /**
   * Where this type's node-written output must land, when
   * `node-outputs/<jobId>/<uuid>` is the wrong answer.
   *
   * OPTIONAL, AND OMITTING IT IS THE NORMAL ANSWER. A handler that does not
   * implement this gets the data plane's default key, unchanged — a fresh,
   * job-attributable, never-reused location under `node-outputs/`, which is
   * the right shape for any artifact nothing outside the job ever names.
   * Implement it only when the artifact's location is part of its contract:
   * a row somewhere records the key, a retention sweep lists a prefix, or a
   * download endpoint reconstructs it. See the file header for the full
   * argument and the two rejected alternatives.
   *
   * ⚠ THIS IS STILL THE SERVER CHOOSING. It runs in the API process, from the
   * handler that owns the artifact, with the `Job` row as its only input —
   * nothing from the node's request reaches it, and a node-supplied `key` is
   * refused with a 400 before this is ever called.
   *
   * ⚠ IT MUST BE IDEMPOTENT PER JOB, and that is this member's one hard
   * requirement. A node asks for an upload URL more than once as a matter of
   * course: a transfer that timed out, a response lost on the way back, a
   * process restarted while holding the lease. Every one of those calls must
   * yield THE SAME KEY. A derivation that mints something new each time —
   * inserting an artifact row, or interpolating `randomUUID()`/`Date.now()` —
   * produces a second artifact per retry, and the row the rest of the system
   * reads then points at bytes the node never finished writing. Derive from
   * values already fixed on the job, or re-read the artifact row this job
   * already created and return its recorded key. #351 makes that structural
   * for the database backup with a `@unique` `jobId` on its run row, so
   * "re-read by `jobId`, return the existing key" is enforced by the database
   * rather than by the handler remembering to.
   *
   * The returned key must satisfy the data plane's `SAFE_STORAGE_KEY`; one
   * that does not is refused server-side with a 500 and the node gets no URL
   * at all. Throwing here fails the request the same way — no URL is minted,
   * and the node's correct response is the same as for any other refusal.
   */
  deriveOutputKey?(job: Job): Promise<string>;

  /**
   * May a node run THIS type in THIS deployment, right now?
   *
   * OPTIONAL, AND OMITTING IT IS THE NORMAL ANSWER — a node-eligible type with
   * no gate is offered to nodes, which is what every type before #352 did.
   * Implement it only when a deployment must be able to say "not this
   * workload" about a type that is structurally perfectly capable of running
   * remotely.
   *
   * ⚠ IT IS A POLICY READ, NOT A DECLARATION, and that is why it is a METHOD
   * rather than a `readonly nodeOffloadEnabled: boolean`. Everything else on
   * this interface states a fact about the TYPE that is fixed at build time;
   * this one asks a question whose answer an administrator changes at 3pm on a
   * Tuesday. A boolean field would be read once at registration and be wrong
   * from then on. `NodesService.nodeEligibleTypes` awaits this at CLAIM time,
   * beside the two settings intersections it already performs, so a switch
   * flipped in the admin UI takes effect on the next claim and not at the next
   * deploy.
   *
   * ⚠ IT DOES NOT CHANGE NODE ELIGIBILITY. Eligibility is derived from
   * `nodeResultSchema` + `persistNodeResult` and stays derived from them: this
   * gate cannot make a server-only type runnable on a node, and a `false` here
   * does not remove the type from `serverOnlyTypes()`'s complement. It decides
   * only what THIS deployment OFFERS today — the same runtime intersection the
   * secret-broker filter performs, and the same reason it is not a registry
   * mutation.
   *
   * REJECTED: putting the deployment's answer in `NodesService` itself — a
   * `if (type === BACKUP_JOB_TYPE) …` reading the `databaseBackup` namespace.
   * That is the central dispatch table this file's header exists to abolish,
   * one arm long, and it makes the nodes module depend on a feature module's
   * settings shape. Asking the handler keeps the knowledge where the feature
   * is: `DatabaseBackupRunHandler` reads its own `databaseBackup
   * .nodeOffloadEnabled`, and a fork's handler reads whatever its own feature
   * calls the same idea.
   *
   * Throwing is not a way to say "no": it fails the whole claim, which is a
   * far bigger hammer than withholding one type. Report the settings read's
   * failure as `false` if it can fail at all.
   */
  nodeOffloadEnabled?(): Promise<boolean>;

  /**
   * Mints the short-lived credential a REMOTE executor of this type needs, and
   * destroys it again.
   *
   * OPTIONAL, AND OMITTING IT IS THE NORMAL ANSWER — almost every job type is
   * pure compute over presigned bytes and needs no credential at all. Its
   * PRESENCE is the declaration that this type does, exactly as the presence of
   * `nodeResultSchema` + `persistNodeResult` is the declaration that the type is
   * node-eligible; there is no `requiresSecret` string and no switch keyed on
   * one (see the file header, and `job-secret-broker.ts` for the whole
   * argument).
   *
   * ⚠ A BROKER IS NOT A PERMISSION TO USE ONE. Whether a node in THIS
   * deployment may hold a credential to THIS database is a trust-boundary
   * decision an administrator makes, not one a handler makes: it is the
   * `nodes.jobSecretBrokerEnabled` system setting, default OFF. With it off,
   * `POST /api/nodes/:id/jobs/:jobId/secret` refuses with a named reason AND
   * the type is filtered out of the node claim, so a node never even sees the
   * job. That filter is a runtime intersection, never a mutation of the
   * registry — see `NodesService.nodeEligibleTypes`.
   *
   * ⚠ NOTHING IT RETURNS MAY BE PERSISTED EXCEPT THE HANDLE. The material is
   * serialised into one HTTP response and dropped; `job_node_secrets` has no
   * column that could hold it. See `IssuedJobSecret`.
   */
  readonly nodeSecretBroker?: JobSecretBroker;
}
