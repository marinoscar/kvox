// =============================================================================
// The per-job secret broker: minting, and the two ways it is un-minted
// (issue #349, epic #345)
// =============================================================================
//
// `docs/specs/worker-nodes.md` §14 named this seam years before it existed:
// *"A fork that needs it adds it where the claim response is built, next to
// #269's presigned URLs, which is the same seam."* This is that fork, and this
// is that seam. #269 solved "a node with no storage credentials must move
// bytes"; this solves "a node with no credentials at all must run work that
// genuinely needs one" — a `pg_dump` needs a database connection, and no
// amount of presigning produces one.
//
// THE OWNER'S RULE, WHICH EVERY DECISION BELOW SERVES: a node never PERSISTS a
// job-scoped credential. It is obtained per job from the server, it is
// short-lived, it is memory-only, and it is revoked on settlement. A node that
// is switched off holds nothing; a node that is stolen holds, at worst, one
// credential for one job for the remainder of one lease.
//
// ⚠ #349 SHIPS THIS WITH NO BROKER REGISTERED ANYWHERE. That is deliberate and
// it is the reason this file is reviewable on its own: the mechanism, the
// endpoint, the table, both revocation paths and the opt-in exist, and nothing
// can issue anything until a concrete broker (#350's PostgreSQL one) is hung
// off a handler. Every path below that resolves a broker therefore has a
// "there isn't one" arm that is currently the ONLY arm anybody exercises.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A SEPARATE SERVICE FROM `NodesService`
// -----------------------------------------------------------------------------
//
// The same argument `NodeDataPlaneService`'s header makes, one axis over.
// `NodesService` is the control plane: the claim, the terminal state machine,
// the two guards. Secret brokering is a capability that most deployments never
// switch on, whose failure modes are entirely its own, and which is reached by
// exactly one route. Keeping it out of the control plane means a change here
// cannot be a change to how jobs are claimed or settled.
//
// What it does NOT do is reimplement the guard. `assertJobHeldByNode` is REUSED
// — claimed by THIS node, `running`, has a lease, lease unexpired — because a
// second copy would start identical and drift on the first fix applied to one
// side, and what it would let through here is worse than what it would let
// through in the data plane: a credential minted for a job somebody else now
// owns.
//
// -----------------------------------------------------------------------------
// THE ORDER OF THE CHECKS IS THE CONTRACT
// -----------------------------------------------------------------------------
//
//   1. `assertJobHeldByNode` — FIRST, always. Nothing is decided, resolved or
//      minted for a caller who cannot prove it holds this job under a live
//      lease. 409 (the existing `notHeldByNode` message) once the lease has
//      expired: another executor may own the job, and the node's correct
//      response is to drop the work.
//   2. THE BODY MUST BE EMPTY. Any field is a 400 naming it — a node may not
//      request a secret it was not assigned. See `dto/node-job-secret.dto.ts`.
//   3. THE DEPLOYMENT MUST HAVE SWITCHED THIS ON. 403 with a named reason
//      otherwise, and the same setting removes the type from the claim
//      entirely, so a correctly-behaving node never reaches this at all.
//   4. THE TYPE MUST DECLARE A BROKER. 404 otherwise: this job type does not
//      have a credential to give, which is a fact about the type and not a
//      transient condition.
//   5. THE BROKER MUST BE USABLE. 503 otherwise, carrying the broker's own
//      `reason` and `remedy`.
//
// Only then does anything get minted.
//
// -----------------------------------------------------------------------------
// ⚠ THE HANDLE IS WRITTEN DOWN BEFORE THE MATERIAL IS HANDED OVER
// -----------------------------------------------------------------------------
//
// `issue()` then persist, and a persist that fails REVOKES what it just could
// not record. The ordering is not fussiness: a grant that exists in PostgreSQL
// with no row in `job_node_secrets` is a live database credential that neither
// revocation path can ever find, because both of them work from handles this
// table holds. Its only bound would be its own expiry. So the failure of the
// cheap operation (an INSERT) must undo the expensive one (a role), not the
// other way round.
//
// -----------------------------------------------------------------------------
// REVOCATION IS TWO MECHANISMS, AND THEY ARE NOT REDUNDANT
// -----------------------------------------------------------------------------
//
// 1. `NodeSecretRevoker`, on `@OnEvent(JOB_SETTLED_EVENT)` — the fast path,
//    milliseconds after a job settles, never throws.
// 2. `NodeSecretSweepTask`, on its own cron, gated by
//    `NODE_SECRET_SWEEP_ENABLED` exactly as `JOBS_REAPER_ENABLED` gates the
//    reaper.
//
// The second is NOT belt-and-braces paranoia over the first, and this is the
// paragraph to read before deleting it. The event path STRUCTURALLY CANNOT
// cover three cases:
//
//   * A JOB SETTLED BY THE REAPER. `JobStuckService` requeues and fails
//     abandoned jobs with `updateMany`, which returns a count and not rows —
//     there is no `Job` to build a `JobSettledEvent` from, so NO EVENT IS
//     EMITTED AT ALL. This is precisely the case where a credential is most
//     likely to be outstanding: the executor died holding it.
//   * AN API REPLICA THAT DIED BETWEEN SETTLING AND REVOKING. The terminal
//     write committed, the emit ran, and the process was gone before
//     `broker.revoke` returned. Nothing retries an in-process listener.
//   * A `write-failed` TERMINAL OUTCOME. `safeTerminalUpdate` gives up after
//     two attempts, deliberately leaves the row for the reaper and returns
//     `null` — so `emitSettled` is never called, and the previous bullet
//     applies again one layer down.
//
// Under both, the credential's own `expiresAt` is the backstop — but an expiry
// is a bound on damage, not a cleanup: without the sweep, a deployment
// accumulates PostgreSQL roles nobody drops.
//
// The sweeper's predicate is deliberately THE EXACT COMPLEMENT of
// `assertJobHeldByNode`'s four conditions, plus the grant's own clock. A
// credential is legitimate exactly while the job it was minted for is still
// held, by the same node, under a live lease; anything else is an orphan. Two
// rules, written once (`stillHeld` below) rather than as a list of statuses
// somebody has to keep in step with the queue's state machine.
// =============================================================================

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Job, JobNodeSecret } from '@prisma/client';

import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import type { JobSecretBroker } from '../jobs/job-secret-broker';
import { PrismaService } from '../prisma/prisma.service';
import { NodeJobSecretRequestDto, NodeJobSecretResponseDto } from './dto/node-job-secret.dto';
import { NodeLifecycleService } from './node-lifecycle.service';
import { NodesService } from './nodes.service';

/**
 * How many unrevoked grants one sweep looks at.
 *
 * Bounded so a deployment that somehow accumulated thousands of orphans does
 * not spend one cron tick issuing thousands of `DROP ROLE`s inside a single
 * promise chain — the next tick continues, oldest first. In a healthy
 * deployment this number is never reached, because the settle-event path has
 * already revoked almost everything before the sweep runs.
 */
/**
 * How far past the job's lease a credential is asked to stay valid, in
 * milliseconds — a CLOCK-SKEW ALLOWANCE, and not a grace period on the node's
 * authorization.
 *
 * ⚠ THE TWO DEADLINES ARE EVALUATED BY DIFFERENT CLOCKS, AND THAT IS THE WHOLE
 * REASON THIS NUMBER EXISTS. The lease is computed and enforced here, on this
 * process's clock; a credential's expiry is enforced by the BACKEND that issued
 * it — PostgreSQL checks `VALID UNTIL` against the database server's own clock
 * at authentication time. A credential set to expire at exactly the lease
 * deadline therefore dies EARLY on any deployment whose database clock runs
 * even slightly ahead, and it dies part-way through the work rather than
 * before it: an authentication failure in the middle of a multi-hour dump,
 * which is both the most expensive place to fail and the hardest to attribute.
 *
 * Sixty seconds is far beyond any plausible NTP skew and far below anything an
 * attacker could use. It does not extend a node's authority: the node is
 * renewing its lease continuously while it works (#347), the settle listener
 * revokes on the terminal write, and the sweeper's predicate is the hold
 * guard's complement — so the practical lifetime of a credential remains
 * "until the node stops", plus a minute during which nothing will accept the
 * job as held anyway.
 *
 * ⚠ IT LIVES HERE, AND NOT IN ANY BROKER, ON PURPOSE. `JobSecretBroker.issue`
 * is contracted to honour `until` EXACTLY — "a broker may grant LESS ... it
 * must not grant more" — and a broker that quietly added its own overhang would
 * make that sentence false for the first implementation that shipped, which is
 * how a contract stops being load-bearing. Worse, every future broker would
 * then pick its own unspecified overhang. How long a credential should live is
 * one decision, and this is the one funnel every broker is reached through, so
 * it is taken once, here, and every broker gets the allowance for free.
 *
 * `IssuedJobSecret.expiresAt` still reports what the broker actually managed to
 * set, so the sweeper's own `row.expiresAt > now` check sees the truth rather
 * than the request.
 */
export const SECRET_CLOCK_SKEW_ALLOWANCE_MS = 60_000;

const SWEEP_BATCH_SIZE = 200;

/** What one sweep did, for the cron's log line. */
export interface NodeSecretSweepResult {
  /** Grants examined this tick. */
  examined: number;
  /** Grants successfully revoked and marked. */
  revoked: number;
  /** Grants that should have been revoked and could not be (logged, retried next tick). */
  failed: number;
}

@Injectable()
export class NodeSecretBrokerService {
  private readonly logger = new Logger(NodeSecretBrokerService.name);

  constructor(
    private readonly prisma: PrismaService,
    // REUSED, never reimplemented: `assertJobHeldByNode` is the only reason
    // this route is safe. See the file header.
    private readonly nodes: NodesService,
    // The registry, for one question: does this job's type declare a broker?
    // Injected rather than imported so the answer comes from the handlers
    // actually registered in THIS process — the same source the claim reads.
    private readonly registry: JobHandlerRegistry,
    // The narrow `nodes` settings accessor, for `jobSecretBrokerEnabled`. The
    // same accessor the two fleet crons read their thresholds through, so
    // "may a node hold a credential here" has exactly one read path.
    private readonly lifecycle: NodeLifecycleService
  ) {}

  // ===========================================================================
  // Issuing
  // ===========================================================================

  /**
   * The one credential for the job this node is holding — minted, or the
   * existing grant extended.
   *
   * ⚠ RE-CALLABLE WHILE THE LEASE IS LIVE, AND THAT IS A REQUIREMENT RATHER
   * THAN A TOLERANCE. A node asks again as a matter of course: a process
   * restarted while still holding the lease, a response lost on the way back,
   * a retry of the same job by the same node. Every one of those calls lands on
   * THE SAME GRANT — `@@unique([jobId, kind])` makes a second row
   * unrepresentable, and `JobSecretBroker.issue` is contracted to extend rather
   * than mint. ONE CREDENTIAL PER JOB, EVER; a broker that minted per call
   * would leak one role per restart into the very database it is protecting,
   * and revocation — which knows exactly one handle — would clean up exactly
   * one of them.
   *
   * The credential's validity is the JOB'S LEASE EXPIRY, plus
   * {@link SECRET_CLOCK_SKEW_ALLOWANCE_MS}. Not a duration configured by a
   * broker, not one the node asked for: the node is already renewing that lease
   * (#347), so the credential rides a clock that is maintained for other
   * reasons and that stops the instant the node stops. A second clock could
   * only disagree with it, and the disagreement would be silent. The allowance
   * is not a second clock either — it is a tolerance on the fact that the
   * credential's deadline is enforced by the BACKEND's clock and the lease by
   * ours; see the constant for why it is taken here rather than by each broker.
   */
  async issueForJob(
    userId: string,
    nodeId: string,
    jobId: string,
    dto: NodeJobSecretRequestDto
  ): Promise<NodeJobSecretResponseDto> {
    // 1. The guard, FIRST. Nothing below runs for a caller who cannot prove it
    //    holds this job under a live lease.
    const job = await this.nodes.assertJobHeldByNode(userId, nodeId, jobId);

    // 2. A node may not request a secret it was not assigned.
    this.rejectCallerSuppliedFields(job, dto);

    // 3. Has this deployment decided its fleet is inside the trust boundary?
    await this.assertBrokerEnabled(job, nodeId);

    // 4. Does this type have a credential to give at all?
    const broker = this.brokerForType(job.type);

    if (!broker) {
      // 404 rather than 400 or 403: this is a fact about the job's TYPE, not
      // about the request and not about authorisation. The node's correct
      // response is to run the job without a credential — a node asking for
      // one it does not need is a node built against a different server
      // version, and the message says so rather than implying it was refused.
      throw new NotFoundException({
        message:
          `Job type "${job.type}" declares no secret broker, so there is no credential to ` +
          `issue for job ${job.id}. Run the work without one; this will not change on a retry.`,
        details: { jobId: job.id, type: job.type, reason: 'no_broker_for_type' },
      });
    }

    // 5. Could the broker mint anything, in this deployment, right now?
    await this.assertUsable(job, broker);

    // The credential's clock IS the lease, plus the clock-skew allowance above
    // — the one place in this system that decides how long a job credential
    // lives. `assertJobHeldByNode` proved `leaseExpiresAt` is non-null and in
    // the future, so the non-null assertion here is discharged by the guard
    // rather than assumed.
    const until = new Date(
      (job.leaseExpiresAt as Date).getTime() + SECRET_CLOCK_SKEW_ALLOWANCE_MS
    );

    const issued = await broker.issue(job, until);

    // ⚠ RECORD THE HANDLE BEFORE HANDING THE MATERIAL OVER, and undo the grant
    // if the record cannot be written. See the file header: a grant with no row
    // is a live credential neither revocation path can find.
    try {
      await this.prisma.jobNodeSecret.upsert({
        where: { jobId_kind: { jobId: job.id, kind: broker.kind } },
        // `revokedAt: null` on update, deliberately: the broker has just
        // (re-)granted, so a row a racing sweeper marked revoked a moment ago
        // is live again, and leaving the stale mark would make the next sweep
        // skip a grant that exists.
        update: {
          nodeId,
          handle: issued.handle,
          expiresAt: issued.expiresAt,
          revokedAt: null,
        },
        create: {
          jobId: job.id,
          nodeId,
          kind: broker.kind,
          handle: issued.handle,
          expiresAt: issued.expiresAt,
        },
      });
    } catch (error) {
      await this.revokeQuietly(broker, issued.handle, job.id);

      this.logger.error(
        `Could not record the ${broker.kind} grant for job ${job.id}; the credential was ` +
          `revoked again rather than left unrecorded: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      throw new InternalServerErrorException({
        message:
          `The credential for job ${job.id} could not be recorded and has been revoked. ` +
          `Retry; if this persists, the job cannot run on a node in this deployment.`,
        details: { jobId: job.id, kind: broker.kind, reason: 'grant_not_recorded' },
      });
    }

    // ⚠ THE MATERIAL IS NOT IN THIS LOG LINE, AND MUST NEVER BE. Not at
    // `debug`, not on an error path, not "temporarily". The handle, the kind
    // and the job are everything an operator needs to trace a grant; the
    // material is what makes it usable. `S3StorageProvider` holds the same rule
    // for signed URLs from its side, and `LoggingInterceptor` records method,
    // url and duration only — never a response body.
    this.logger.log(
      `Issued a ${broker.kind} credential (handle ${issued.handle}) to node ${nodeId} for ` +
        `job ${job.id} (${job.type}), expiring ${issued.expiresAt.toISOString()}`
    );

    return {
      kind: broker.kind,
      expiresAt: issued.expiresAt.toISOString(),
      material: issued.material,
    };
  }

  // ===========================================================================
  // Revocation — path 1, the settle event
  // ===========================================================================

  /**
   * Destroy every live grant for a job that has just settled.
   *
   * THE FAST PATH. Called from `NodeSecretRevoker` milliseconds after the
   * terminal write, so in the overwhelming majority of cases the credential is
   * gone long before anything else notices the job finished.
   *
   * NEVER THROWS — every failure is logged and left for the sweeper, which is
   * exactly what the unrevoked row is for. The caller runs inside
   * `EventEmitter2`'s synchronous dispatch, where a rejection would surface as
   * an `unhandledRejection` with a stack pointing at a worker that did nothing
   * wrong.
   *
   * Returns how many grants it revoked, for the caller's log line.
   */
  async revokeForJob(jobId: string): Promise<number> {
    const rows = await this.prisma.jobNodeSecret.findMany({
      where: { jobId, revokedAt: null },
    });

    let revoked = 0;

    for (const row of rows) {
      if (await this.revokeGrant(row, 'settle')) {
        revoked += 1;
      }
    }

    return revoked;
  }

  /**
   * Whether a job type could have a grant outstanding at all.
   *
   * A MAP LOOKUP, and it is what keeps the settle listener off the database for
   * the ~100% of settles in a deployment where no type declares a broker. If
   * nothing in this process can mint a `job_node_secrets` row for this type,
   * nothing in this process needs to look for one. The sweeper is the backstop
   * for the one case this misses — a fork that REMOVED a broker while grants of
   * its kind were still live — and that case is a deployment change, not a
   * per-job event.
   */
  couldHoldGrant(type: string): boolean {
    return this.brokerForType(type) !== undefined;
  }

  // ===========================================================================
  // Revocation — path 2, the sweeper
  // ===========================================================================

  /**
   * Revoke every grant whose job is no longer held by the node it was minted
   * for.
   *
   * SEE THE FILE HEADER FOR WHY THIS IS NOT REDUNDANT with the settle listener:
   * three real cases emit no event at all, and one of them — a job reaped after
   * its executor died — is precisely the case where an outstanding credential is
   * most likely.
   *
   * THE PREDICATE IS THE COMPLEMENT OF THE HOLD GUARD (`stillHeld` below), not a
   * list of job statuses. A list would have to be kept in step with the queue's
   * state machine by hand, and the failure of forgetting an arm is a credential
   * that is never revoked — invisible until somebody audits roles.
   *
   * NEVER THROWS for one bad grant: a broker that cannot be reached leaves its
   * row unrevoked, which is exactly the state that makes the next tick retry it.
   */
  async sweep(now: Date = new Date()): Promise<NodeSecretSweepResult> {
    const rows = await this.prisma.jobNodeSecret.findMany({
      where: { revokedAt: null },
      // Oldest expiry first, so the most overdue grants are dealt with first
      // when a batch is not enough — and it reads straight off
      // `job_node_secrets_expires_at_idx`.
      orderBy: { expiresAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
    });

    if (rows.length === 0) {
      return { examined: 0, revoked: 0, failed: 0 };
    }

    // ONE QUERY FOR THE JOBS, not one per grant. A job row that is GONE (the
    // history purge deleted it) is not an error here: it is the strongest
    // possible evidence that the grant is an orphan, and `stillHeld` treats a
    // missing job exactly that way.
    const jobs = await this.prisma.job.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.jobId))] } },
      select: { id: true, status: true, claimedByNodeId: true, leaseExpiresAt: true },
    });

    const byId = new Map(jobs.map((job) => [job.id, job]));

    let revoked = 0;
    let failed = 0;

    for (const row of rows) {
      if (this.stillHeld(row, byId.get(row.jobId), now)) {
        continue;
      }

      if (await this.revokeGrant(row, 'sweep')) {
        revoked += 1;
      } else {
        failed += 1;
      }
    }

    return { examined: rows.length, revoked, failed };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * Whether a grant is still legitimate — the EXACT complement of what the
   * sweeper revokes.
   *
   * The four job conditions are `assertJobHeldByNode`'s four, stated once more
   * because this is the only other place in the system that has to answer the
   * same question without an HTTP request in hand. The fifth condition is the
   * grant's own clock: a credential past its `expiresAt` no longer works
   * anyway, so leaving its role in place buys nothing and costs a role.
   */
  private stillHeld(
    row: JobNodeSecret,
    job: { status: string; claimedByNodeId: string | null; leaseExpiresAt: Date | null } | undefined,
    now: Date
  ): boolean {
    if (!job) {
      return false;
    }

    return (
      job.status === 'running' &&
      job.claimedByNodeId === row.nodeId &&
      job.leaseExpiresAt !== null &&
      job.leaseExpiresAt > now &&
      row.expiresAt > now
    );
  }

  /**
   * Revoke one grant and mark the row, or log why not.
   *
   * ⚠ THE MARK IS AN `updateMany` GUARDED ON `revokedAt: null`, not an
   * `update`. Both revocation paths can be acting on the same row at the same
   * instant — a job settling while a sweep is mid-batch is not exotic — and
   * this makes the race produce one winner and one no-op rather than two
   * writers disagreeing about when the grant ended.
   *
   * THE BROKER CALL COMES FIRST AND THE MARK SECOND. If the order were
   * reversed, a `revoke` that threw would leave a row marked revoked and a
   * credential that still works, which is the one state nothing would ever
   * clean up — the sweeper only looks at unmarked rows. Failing before the mark
   * leaves the row exactly as the next tick needs to find it.
   */
  private async revokeGrant(row: JobNodeSecret, source: 'settle' | 'sweep'): Promise<boolean> {
    const broker = this.brokerForKind(row.kind);

    if (!broker) {
      // A grant whose minting broker is no longer registered in this process:
      // a fork removed it, or a rolling deploy is mid-flight. Nothing here can
      // destroy it, so say so loudly and leave the row unrevoked — the grant's
      // own expiry is what bounds it, and an operator reading this line is the
      // only one who can do better.
      this.logger.error(
        `No registered broker of kind "${row.kind}" can revoke handle ${row.handle} for ` +
          `job ${row.jobId} (${source}). The grant will lapse on its own at ` +
          `${row.expiresAt.toISOString()}; revoke it by hand if that is too late.`
      );

      return false;
    }

    try {
      await broker.revoke(row.handle);
    } catch (error) {
      this.logger.error(
        `Revoking the ${row.kind} grant (handle ${row.handle}) for job ${row.jobId} failed ` +
          `(${source}); leaving the row unrevoked so the sweep retries it: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      return false;
    }

    try {
      await this.prisma.jobNodeSecret.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch (error) {
      // The credential IS gone — the broker said so. Only the bookkeeping
      // failed, so this is a warning and not an error, and the next sweep will
      // call `revoke` again on a handle that no longer exists. That is why
      // `JobSecretBroker.revoke` is contracted to treat "already revoked" as
      // success.
      this.logger.warn(
        `Revoked the ${row.kind} grant for job ${row.jobId} but could not mark the row: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.logger.log(
      `Revoked the ${row.kind} credential (handle ${row.handle}) for job ${row.jobId} (${source})`
    );

    return true;
  }

  /** Best-effort revoke used to undo a grant this server failed to record. */
  private async revokeQuietly(
    broker: JobSecretBroker,
    handle: string,
    jobId: string
  ): Promise<void> {
    try {
      await broker.revoke(handle);
    } catch (error) {
      this.logger.error(
        `⚠ ORPHANED GRANT: could not record the ${broker.kind} credential for job ${jobId} ` +
          `AND could not revoke it again (handle ${handle}). Nothing in this system can find ` +
          `it now; revoke it by hand: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** The broker a job type declares, if it declares one. */
  private brokerForType(type: string): JobSecretBroker | undefined {
    return this.registry.get(type)?.nodeSecretBroker;
  }

  /**
   * The registered broker that mints grants of `kind`.
   *
   * ⚠ RESOLVED BY `kind`, NOT BY THE JOB'S `type`, AND THAT IS DELIBERATE. The
   * sweeper meets rows whose `jobs` row has already been deleted by the history
   * purge — retention on job history has nothing to do with a grant's lifetime
   * — and a lookup that needed the job's type could not revoke those at all.
   * `kind` is recorded on the row precisely so a grant stays revocable after
   * everything else about its job is gone.
   *
   * Two brokers declaring the same `kind` is a fork's configuration error, not
   * a supported arrangement: they would be two different authorities behind one
   * name, and revoking through the wrong one silently does nothing. It is
   * logged and the first registration wins, which is the same "loud, last
   * writer takes it" posture `JobHandlerRegistry.register` takes for a
   * duplicate type.
   */
  private brokerForKind(kind: string): JobSecretBroker | undefined {
    const matches = this.registry
      .types()
      .map((type) => this.registry.get(type)?.nodeSecretBroker)
      .filter((broker): broker is JobSecretBroker => broker?.kind === kind);

    if (matches.length > 1) {
      this.logger.error(
        `${matches.length} registered handlers declare a secret broker of kind "${kind}". ` +
          `A kind names ONE minting authority — revoking through the wrong one silently ` +
          `does nothing. Using the first; give the brokers distinct kinds.`
      );
    }

    return matches[0];
  }

  /**
   * 403 unless an administrator has switched brokering on for this deployment.
   *
   * ⚠ THIS IS A SECOND FENCE, NOT THE ONLY ONE. The same setting removes every
   * broker-carrying type from `NodesService.nodeEligibleTypes`, so a node in a
   * deployment with this off never claims such a job and never reaches this
   * check. That is the fence that matters operationally; this one exists
   * because a node can be holding a job claimed BEFORE an administrator turned
   * the setting off, and the answer to "may I have the credential now" must be
   * no from the instant the switch moves rather than from the next claim.
   *
   * A NAMED REASON, in `details`, because "403" on its own sends a node
   * operator to look at permissions — and their credential is fine. The thing
   * that is wrong is a system setting they may not even be able to see.
   */
  private async assertBrokerEnabled(job: Job, nodeId: string): Promise<void> {
    const policy = await this.lifecycle.getPolicy();

    if (policy.jobSecretBrokerEnabled) {
      return;
    }

    this.logger.warn(
      `Node ${nodeId} asked for a credential for job ${job.id} (${job.type}) while ` +
        `nodes.jobSecretBrokerEnabled is off. Refused.`
    );

    throw new ForbiddenException({
      message:
        `This deployment does not issue per-job credentials to worker nodes. An administrator ` +
        `must enable the "nodes.jobSecretBrokerEnabled" system setting before a node may hold ` +
        `a credential for job ${job.id}. Report this job as failed; it cannot run here.`,
      details: {
        jobId: job.id,
        type: job.type,
        reason: 'job_secret_broker_disabled',
        setting: 'nodes.jobSecretBrokerEnabled',
      },
    });
  }

  /**
   * 503 unless the broker says it can mint right now.
   *
   * WHY 503 AND NOT 422, which is what the data plane answers for an
   * unresolvable input. The distinction is whether a retry can EVER help, and
   * here it can: the ordinary `usable()` failure is a privilege the deployment's
   * database user does not hold (managed PostgreSQL denying `CREATEROLE` is the
   * standard case), and an administrator granting it makes the very same job
   * succeed with nothing about the job having changed. `422` would tell the node
   * "this can never work — fail the job", which is false, and a node that
   * believed it would burn the whole attempt budget in the minute before
   * somebody fixed the grant. `503` says "not now", which is the truth.
   *
   * The broker's `remedy` is carried through untouched. It is the part a person
   * pastes into a terminal, and burying it in a server log while the node sees a
   * bare 503 is how a fixable refusal becomes an outage nobody can explain.
   */
  private async assertUsable(job: Job, broker: JobSecretBroker): Promise<void> {
    const usability = await broker.usable();

    if (usability.ok) {
      return;
    }

    this.logger.error(
      `The ${broker.kind} secret broker cannot mint a credential for job ${job.id}: ` +
        `${usability.reason} — ${usability.remedy}`
    );

    throw new ServiceUnavailableException({
      message:
        `The ${broker.kind} credential broker is not usable in this deployment: ` +
        `${usability.reason}`,
      details: {
        jobId: job.id,
        kind: broker.kind,
        reason: 'broker_unusable',
        cause: usability.reason,
        remedy: usability.remedy,
        // Said explicitly because it is the one thing a node cannot work out for
        // itself: unlike a 422, this one CAN come right without the job changing.
        retryable: true,
      },
    });
  }

  /**
   * Refuses any field at all — this body has no permitted fields.
   *
   * The same net `NodeDataPlaneService.rejectCallerSuppliedFields` casts, with
   * an empty allowlist, because a node may not request a secret it was not
   * assigned: a `kind`, a `scope`, a `database` or a `ttl` here would each be a
   * node choosing part of a credential's shape, and every one of those is the
   * server's choice derived from the job it is holding.
   *
   * REFUSED RATHER THAN IGNORED, for the reason the upload route already
   * records: ignoring means the node's author never learns their field had no
   * effect, and the bug is found days later by a person instead of minutes later
   * by a machine. It costs a correct client exactly nothing — no legitimate node
   * ever sends anything here.
   */
  private rejectCallerSuppliedFields(job: Job, dto: NodeJobSecretRequestDto): void {
    const offending = Object.keys(dto ?? {});

    if (offending.length === 0) {
      return;
    }

    this.logger.warn(
      `Node secret request for job ${job.id} carried field(s) it may not set: ` +
        `[${offending.join(', ')}]. Refused.`
    );

    throw new BadRequestException({
      message:
        `This request carried field(s) a node may not set: ${offending.join(', ')}. ` +
        `A node may not request a secret it was not assigned — the kind, the scope and the ` +
        `lifetime of a job credential are all derived by the server from the job being held. ` +
        `Send an empty body.`,
      details: { jobId: job.id, rejectedFields: offending, permittedFields: [] },
    });
  }
}
