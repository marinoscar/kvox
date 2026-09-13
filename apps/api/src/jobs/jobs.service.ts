// =============================================================================
// Job enqueue (issue #260, epic #254)
// =============================================================================
//
// The write half of the queue: the one place a `jobs` row is created, and the
// one place the active-dedup contract is honoured. The read half — claiming a
// row to run — is `job-claim.service.ts`, deliberately a separate service
// because the two have different callers (every feature enqueues; only a
// worker or the node control plane claims) and different failure modes.
//
// -----------------------------------------------------------------------------
// THE DATABASE DECIDES DEDUP, NOT A PRIOR `SELECT`
// -----------------------------------------------------------------------------
//
// `enqueue` inserts OPTIMISTICALLY and treats the resulting unique violation
// as "a duplicate is already in flight". There is no pre-flight
// "is there already an active job with this key?" query anywhere in this file,
// and adding one would be a regression rather than an optimisation.
//
// REJECTED: `findFirst`-then-`create`. It is a check-then-act race, and it is
// racy exactly when dedup matters. Two concurrent enqueues both run the
// `findFirst`, both see no active duplicate, and both insert — which is
// precisely the outcome a dedup key exists to prevent. Under real load (a
// webhook redelivered while the first delivery is still being handled, two
// replicas reacting to the same event, a user double-clicking) that window is
// not a rare edge case, it is the normal case. Only the database can make
// "is there already an active job with this key" atomic with the insert that
// would violate it, and `jobs_active_dedup_uniq_idx` — the partial UNIQUE
// index hand-written in
// `prisma/migrations/20260906120000_add_jobs/migration.sql` — is that
// atomicity. The `Job` model's own block comment in `schema.prisma` records
// the same rejection from the schema side.
//
// So the flow is: INSERT → catch P2002 on that specific index → re-read the
// active row and return it. The caller cannot tell whether it created the job
// or joined an existing one, which is the point: "this work is queued" is
// true either way.
//
// -----------------------------------------------------------------------------
// `skipDedup` IS FREE, BECAUSE POSTGRES TREATS EVERY NULL AS DISTINCT
// -----------------------------------------------------------------------------
//
// `skipDedup: true` does not disable a code path, take a different branch
// through the index, or need a second insert strategy. It simply leaves
// `dedup_key` NULL, and a NULL is never equal to another NULL for uniqueness
// purposes — so any number of NULL-keyed rows coexist under the same unique
// index. The index's predicate spells `dedup_key IS NOT NULL` out explicitly
// so that this is documented as relied upon rather than incidental.
//
// This is why the opt-out costs nothing: there is no "dedup off" mode, only a
// key that no other row can collide with.
//
// -----------------------------------------------------------------------------
// A DEDUP KEY IS REUSABLE ONCE ITS JOB SETTLES
// -----------------------------------------------------------------------------
//
// The unique index is filtered to `status IN ('pending','running')`, so a job
// reaching `succeeded` or `failed` drops out of the index's predicate and
// frees its key. Re-triggering the same logical work an hour later is
// therefore allowed; only work that is *still in flight* is collapsed. That
// filter is also what makes the re-read below able to fail — see
// `enqueue`'s own comments.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Job, JobReason, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { buildDedupKey } from './job-keys';

/**
 * The name of the partial unique index that enforces active dedup. Declared
 * in `prisma/migrations/20260906120000_add_jobs/migration.sql`; repeated here
 * because a P2002 has to be attributed to *this* constraint and not to some
 * other unique constraint that may exist on `jobs` in a fork.
 */
export const ACTIVE_DEDUP_INDEX_NAME = 'jobs_active_dedup_uniq_idx';

/** The physical column and the Prisma field the index is built over. */
const DEDUP_COLUMN_NAME = 'dedup_key';
const DEDUP_FIELD_NAME = 'dedupKey';

/**
 * How many times `enqueue` will re-attempt the insert when the conflicting
 * job settles out from under the re-read (see `enqueue`).
 *
 * BOUNDED, deliberately. An unbounded `while (true)` would be correct in
 * theory and a livelock in practice: a pathologically hot dedup key whose
 * jobs settle within microseconds could spin a request thread indefinitely.
 * Three attempts covers the real race — which needs a conflicting job to
 * finish inside the few milliseconds between the failed insert and the
 * re-read — and turns a pathological one into a visible error instead of a
 * hang.
 */
const ENQUEUE_MAX_ATTEMPTS = 3;

/**
 * Everything a caller may say about a job it wants run.
 *
 * `type` and `reason` are required because the row cannot exist without them;
 * everything else has a database default or is genuinely optional.
 */
export interface EnqueueJobInput {
  /**
   * The handler key a worker dispatches on (`JobHandler.type`). A plain
   * string on purpose — a new handler costs zero migrations.
   */
  type: string;

  /** Why this job exists (`upload` | `rerun` | `backfill`). */
  reason: JobReason;

  /**
   * What the job is about. Both null (or omitted) means a global/system job
   * with no subject; see `buildDedupKey` for how the pair folds into the key.
   */
  subjectType?: string | null;
  subjectId?: string | null;

  /**
   * Handler-defined input, opaque to the queue.
   *
   * Carry IDENTIFIERS, not copies of data. The job may run minutes later, so
   * a row named in the payload should be re-read at run time rather than
   * carried inside a payload that has gone stale.
   */
  payload?: Prisma.InputJsonValue | null;

  /** Ascending = more urgent. Defaults to the column default (`0`). */
  priority?: number;

  /**
   * Earliest time this job may be claimed. Omitted/null means "eligible
   * immediately" — the claim query reads `scheduled_for IS NULL OR
   * scheduled_for <= now()`.
   */
  scheduledFor?: Date | null;

  /**
   * Opt out of dedup entirely by leaving `dedup_key` NULL.
   *
   * Use it when several jobs of the same type against the same subject are
   * legitimately distinct work (per-item exports, deliberate re-runs queued
   * back to back). See the file header for why this costs nothing.
   */
  skipDedup?: boolean;
}

/**
 * Whether `error` is a unique-constraint violation on the ACTIVE-DEDUP index
 * specifically — as opposed to any other P2002 the `jobs` table (or a fork's
 * additions to it) might raise.
 *
 * THIS DISCRIMINATION IS LOAD-BEARING. Treating every P2002 as "already
 * queued" would make `enqueue` return some unrelated row, or `null`-ish
 * nonsense, for a genuine constraint bug — the exact class of error that must
 * stay loud. Anything this function does not positively recognise propagates
 * untouched.
 *
 * Two metadata shapes are inspected because Prisma reports the violation
 * differently depending on how the client is talking to Postgres:
 *
 *   - Driver adapter (`@prisma/adapter-pg`, which `PrismaService` uses):
 *     `meta.driverAdapterError.cause` carries `constraint.fields`
 *     (`['dedup_key']`) and `originalMessage`, which names the index.
 *   - Classic query engine: `meta.target`, either the column list or the
 *     index name.
 *
 * Both are checked rather than one, so switching adapters — or a Prisma
 * upgrade moving the detail around — degrades to "the P2002 propagates",
 * never to "an unrelated conflict is silently swallowed".
 */
export function isActiveDedupConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const names = new Set([ACTIVE_DEDUP_INDEX_NAME, DEDUP_COLUMN_NAME, DEDUP_FIELD_NAME]);

  const meta = (error.meta ?? {}) as Record<string, unknown>;

  // Shape 1: driver adapter.
  const adapterError = meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined;
  const cause = adapterError?.cause;

  if (cause) {
    const constraint = cause.constraint as { fields?: unknown; index?: unknown } | undefined;

    if (
      Array.isArray(constraint?.fields) &&
      constraint.fields.some((field) => names.has(String(field)))
    ) {
      return true;
    }

    if (typeof constraint?.index === 'string' && constraint.index === ACTIVE_DEDUP_INDEX_NAME) {
      return true;
    }

    if (
      typeof cause.originalMessage === 'string' &&
      cause.originalMessage.includes(ACTIVE_DEDUP_INDEX_NAME)
    ) {
      return true;
    }
  }

  // Shape 2: classic query engine.
  const target = meta.target;

  if (typeof target === 'string') {
    return names.has(target);
  }

  if (Array.isArray(target)) {
    return target.some((entry) => names.has(String(entry)));
  }

  return false;
}

/**
 * The `dedup_key` an enqueue of `input` participates under, or `null`.
 *
 * NULL for `skipDedup`, which is what makes the opt-out free — see the file
 * header. THE ONLY PLACE the queue decides WHETHER a job participates in
 * dedup; `buildDedupKey` decides only what the key looks like. Factored out
 * of `enqueue` so `enqueueWithin` cannot answer that question differently:
 * two entry points computing "does this job dedup?" separately is precisely
 * how one of them ends up inserting a NULL key that the index then declines
 * to defend.
 */
function resolveDedupKey(input: EnqueueJobInput): string | null {
  return input.skipDedup
    ? null
    : buildDedupKey(input.type, input.subjectType, input.subjectId);
}

/**
 * The row both enqueue paths insert.
 *
 * ONE BUILDER, TWO CALLERS, for the same reason `buildDedupKey` is one
 * function with two readers: `enqueue` and `enqueueWithin` differ ONLY in
 * which client executes the insert and in what they do with a conflict. A
 * second literal here would let the two paths drift on `priority`,
 * `scheduledFor` or the `payload` coalesce — a divergence that shows up as
 * "the same work behaves differently depending on which caller queued it",
 * which is the hardest kind of queue bug to see.
 */
function buildJobCreateData(
  input: EnqueueJobInput,
  dedupKey: string | null
): Prisma.JobCreateInput {
  return {
    type: input.type,
    reason: input.reason,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    dedupKey,
    // `undefined` means "let the column default apply" in Prisma, which is
    // what we want for both of these: `priority` defaults to 0, and a NULL
    // `scheduled_for` is what makes a job eligible immediately.
    priority: input.priority ?? undefined,
    scheduledFor: input.scheduledFor ?? undefined,
    payload: input.payload === undefined || input.payload === null ? undefined : input.payload,
  };
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Queues a job, collapsing it into the one already in flight for the same
   * dedup key when there is one.
   *
   * Returns the row the caller should consider "their" job — either the row
   * this call inserted, or the ACTIVE row that beat it to the key. The caller
   * is not told which, and should not branch on it: the postcondition is "a
   * job for this work is queued", and that is true in both cases.
   *
   * ⚠ WHAT THE RETURNED ROW IS, WHEN DEDUP COLLAPSED THE CALL. It is the
   * EXISTING job, so its `reason`, `priority`, `payload` and `scheduledFor`
   * are the *first* caller's, not this one's. That is the definition of
   * dedup, not an oversight: the work is already queued, and a second
   * request to do the same work is not a reason to reconfigure the job that
   * is about to do it (or, worse, to mutate a row a worker may already have
   * claimed). A caller that genuinely needs its own row wants
   * `skipDedup: true`.
   */
  async enqueue(input: EnqueueJobInput): Promise<Job> {
    const dedupKey = resolveDedupKey(input);
    const data = buildJobCreateData(input, dedupKey);

    let lastConflict: unknown;

    for (let attempt = 1; attempt <= ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.job.create({ data });
      } catch (error) {
        // Any conflict that is NOT this index's is somebody else's problem
        // and must stay loud.
        if (!isActiveDedupConflict(error)) {
          throw error;
        }

        lastConflict = error;

        // The index says an ACTIVE job holds this key. Go and read it.
        const existing = await this.findActiveByDedupKey(dedupKey as string);

        if (existing) {
          this.logger.debug(
            `Job of type "${input.type}" deduplicated onto existing ` +
              `${existing.status} job ${existing.id} (key "${dedupKey}")`
          );
          return existing;
        }

        // ⚠ THE RE-READ CAN LOSE ITS OWN RACE, AND THIS IS THE EXPLICIT
        // HANDLING OF THAT.
        //
        // Between the INSERT failing and this SELECT running, the job that
        // held the key can reach `succeeded` or `failed` — at which point it
        // drops out of the partial index's predicate, the key is free again,
        // and there is no active row left to return. Nothing is wrong; the
        // world simply moved on between two statements.
        //
        // REJECTED: returning the settled row anyway (widening the re-read to
        // any status). The caller asked for work to be QUEUED, and handing
        // back a job that already finished would report success for work that
        // will never run — the worst possible answer, and unrecoverable by
        // the caller because it cannot tell that row apart from one that is
        // about to execute.
        //
        // REJECTED: throwing the P2002 to the caller. The condition it
        // describes ("a duplicate is in flight") is no longer true by the
        // time we would report it.
        //
        // So: LOOP AND INSERT AGAIN. The key is free now, so the retry
        // normally succeeds outright; if it collides again, the next
        // iteration's re-read finds whichever job took the key. Bounded by
        // ENQUEUE_MAX_ATTEMPTS so a pathologically hot key becomes a visible
        // error rather than a spin.
        this.logger.debug(
          `Dedup key "${dedupKey}" was released between the conflicting ` +
            `insert and the re-read; retrying enqueue ` +
            `(attempt ${attempt}/${ENQUEUE_MAX_ATTEMPTS})`
        );
      }
    }

    this.logger.warn(
      `Failed to enqueue job of type "${input.type}" after ` +
        `${ENQUEUE_MAX_ATTEMPTS} attempts: the dedup key "${dedupKey}" kept ` +
        `being taken and released between the insert and the re-read`
    );

    throw lastConflict;
  }

  /**
   * Inserts a job INSIDE A TRANSACTION THE CALLER ALREADY OWNS, letting a
   * dedup conflict PROPAGATE instead of collapsing onto the job in flight.
   *
   * -------------------------------------------------------------------------
   * WHY THIS EXISTS AT ALL, GIVEN `enqueue` DIRECTLY ABOVE IT
   * -------------------------------------------------------------------------
   *
   * `enqueue` is the right answer for every caller whose job row is the only
   * row it writes. It is the WRONG answer for a caller that must create a
   * `jobs` row AND a row in its own table as one atomic act — the shape
   * `db.backup.run` needs (epic #345, issue #351), where a
   * `database_backup_runs` row is written `pending` in the same commit as the
   * job that will execute it. Two separate statements there admit two failures
   * that this template cannot pay for, and the backup runner's own header
   * spells out why each is unacceptable.
   *
   * ⚠ IT DOES NOT RETRY, AND IT DOES NOT SWALLOW THE P2002. Both are forced,
   * not stylistic. Postgres ABORTS A TRANSACTION at the first failed
   * statement: every subsequent statement on that connection raises
   * `25P02 current transaction is aborted` until the transaction ends. So
   * `enqueue`'s catch-the-conflict-and-re-read loop is not merely unnecessary
   * here — IT CANNOT WORK, because the re-read would run on a connection that
   * has already given up. (Prisma exposes no SAVEPOINT, which is the only
   * thing that would make partial recovery inside a transaction possible.)
   *
   * The contract is therefore: the conflict rolls the CALLER'S whole
   * transaction back — which is exactly what a caller wants, since its own
   * row must not exist for a job that was never created — and the caller
   * resolves the conflict AFTER the transaction has ended, with
   * {@link isActiveDedupConflict} and a fresh read. `queueBackup` in
   * `db-backup-runner.service.ts` is the worked example.
   *
   * @throws the raw Prisma `P2002` when an active job already holds the same
   * dedup key. Callers must classify it with {@link isActiveDedupConflict}
   * rather than assuming every failure here is a duplicate.
   */
  async enqueueWithin(tx: Prisma.TransactionClient, input: EnqueueJobInput): Promise<Job> {
    return tx.job.create({ data: buildJobCreateData(input, resolveDedupKey(input)) });
  }

  /**
   * The ACTIVE (`pending` or `running`) job holding `dedupKey`, or `null`.
   *
   * The status filter mirrors `jobs_active_dedup_uniq_idx`'s predicate
   * exactly, and that is the whole contract: this reads back precisely the
   * set of rows the index was defending. Widening it would return jobs the
   * index does not consider duplicates, which is how "already queued" starts
   * meaning "was queued once, some time ago".
   */
  private findActiveByDedupKey(dedupKey: string): Promise<Job | null> {
    return this.prisma.job.findFirst({
      where: { dedupKey, status: { in: ['pending', 'running'] } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Records WHICH downstream provider (and which model/version of it)
   * actually ran a job.
   *
   * BEST EFFORT — THIS METHOD NEVER THROWS. `providerKey` / `modelVersion`
   * are audit columns, written once near completion and never read by the
   * claim query or by any scheduling decision (the `Job` model's own comment
   * says as much). A failure to write them therefore has exactly one correct
   * consequence: a log line. Letting it propagate would let an audit write
   * fail a job whose real work already succeeded — turning a missing
   * annotation into a retry of work that does not need retrying, which is
   * strictly worse than the missing annotation.
   *
   * The commonest failure is entirely benign and expected: the job row was
   * purged by queue hygiene (#263) before this ran, so the update matches
   * nothing (`P2025`).
   */
  async recordProvider(
    jobId: string,
    providerKey: string | null,
    modelVersion: string | null
  ): Promise<void> {
    try {
      await this.prisma.job.update({
        where: { id: jobId },
        data: { providerKey, modelVersion },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to record provider audit for job ${jobId} ` +
          `(providerKey "${providerKey}", modelVersion "${modelVersion}"): ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
