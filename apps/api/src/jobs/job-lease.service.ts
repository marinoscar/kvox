// =============================================================================
// Lease renewal — one implementation, both executors (issue #347, epic #345)
// =============================================================================
//
// A claim is a PROMISE WITH AN EXPIRY. `job-claim.service.ts` stamps
// `lease_expires_at` in the claiming UPDATE, and `job-stuck.service.ts` reads
// that column to decide an executor died. Between those two facts sits the
// obligation nothing in this queue met until now: whoever holds the row must
// keep pushing the expiry out for as long as it is still working, or the
// reaper is entitled to hand the same job to somebody else.
//
// Before this file there was exactly ONE renewer in the codebase —
// `NodesService.renewLease`, reachable only over HTTP by a remote worker node.
// The in-process worker, which is the executor a single-container deployment
// actually runs, wrote a lease at claim time and then never touched the row
// again. Every handler that ran longer than `jobs.stuckThresholdMinutes`
// (default 30) was therefore reaped mid-run and started a SECOND TIME,
// concurrently, on work the first attempt was still doing. For a database
// backup that means two `pg_dump`s streaming into one storage key, both
// exiting 0, and an archive that cannot be restored with no error anywhere.
//
// -----------------------------------------------------------------------------
// WHY THE GUARD IS A `where` CLAUSE AND NOT AN `if`
// -----------------------------------------------------------------------------
//
// `heldLeaseWhere` below is the whole safety argument, and it has to be part
// of the WRITE rather than a check preceding it. A renewer that read the row,
// satisfied itself that it still owned the lease, and then issued an
// `update({ where: { id } })` would have a window — small, real, and widest
// on exactly the loaded machine where this matters — in which the reaper
// requeues the row and another executor claims it between the read and the
// write. A renewal landing inside that window pushes out a lease belonging to
// SOMEBODY ELSE, keeping the reaper away from a job the original worker is no
// longer authoritative for. `updateMany` with the ownership conditions makes
// the check and the write one statement; a count of zero is the answer "the
// state moved", and it is the only honest one.
//
// -----------------------------------------------------------------------------
// ⚠ WHY THIS IS ONE FILE AND NOT TWO METHODS THAT LOOK ALIKE
// -----------------------------------------------------------------------------
//
// The rule "a lease that has ALREADY EXPIRED may not be renewed, because
// another executor may now own the row" is a claim about the queue's
// invariants, not about HTTP or about worker pools. Written twice it drifts
// exactly once, in one direction, silently: someone relaxes the
// `leaseExpiresAt: { gt: now }` predicate on one side to stop a flaky node
// losing jobs, and from then on that side can resurrect a lease on a row the
// reaper has already given away — two live executors, one row, no error.
//
// This is the same argument `resolveJobLeaseMs` makes for lease DERIVATION
// ("one function, one number, both executors"), applied to lease EXTENSION.
// The node control plane calls `renewUntil`; the in-process worker calls
// `renew`; both reach `heldLeaseWhere`.
//
// REJECTED: putting `renew` on `JobClaimService`. Claiming and renewing look
// adjacent and are not: the claim is a competitive statement (`FOR UPDATE
// SKIP LOCKED` over candidate rows, charging an attempt) and a renewal is an
// uncontested single-row update that must charge nothing. Folding them would
// give the one method in the queue that increments `attempts` a second job.
//
// REJECTED: renewing from `JobTerminalService`. That service is the
// CHOKEPOINT FOR FINISHING a job; a renewal is the opposite claim ("still
// going"), and mixing them would put the settle path and the keep-alive path
// behind one door for no shared code at all.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * The rows a renewal may legitimately touch: this job, still `running`, with
 * a lease that has NOT yet expired, held by the executor doing the asking.
 *
 * ⚠ `leaseExpiresAt: { gt: now }` IS THE LOAD-BEARING CLAUSE, and the one a
 * future reader will be tempted to relax. Once the lease has passed, the
 * reaper is entitled to requeue the row and another executor is entitled to
 * claim it — so a renewal arriving late is not "a little slow", it is a claim
 * about ownership that may already be false. Refusing it is what stops a
 * straggler from stealing a lease back from whoever legitimately holds it
 * now. A `NULL` lease is excluded by the same comparison (`NULL > now` is
 * NULL, never true), which is correct for a different reason: a row with no
 * lease was never leased to anybody, so there is nothing to EXTEND.
 *
 * `nodeId` is deliberately THREE-VALUED, and the distinction is not
 * decoration:
 *
 *   - a node id — the node plane: only that node may renew.
 *   - `null` — the in-process worker: only a row claimed by no node may be
 *     renewed. If the reaper requeued this row and a NODE took it, the
 *     worker's renewals stop landing, which is exactly right.
 *   - `undefined` — no ownership constraint at all. No production caller
 *     passes this today; it exists so a fork's own executor (a second server
 *     process with a claim path of its own) is not forced to lie about which
 *     node holds a row in order to renew it.
 *
 * ⚠ WHAT THIS PREDICATE CANNOT DISTINGUISH, stated plainly rather than left
 * for somebody to discover: two SERVER processes. If replica A's job is
 * reaped and replica B claims it, both see `claimedByNodeId: null` and a live
 * lease, so A's next renewal succeeds and extends B's lease. Closing that
 * would need a per-claim token column on `jobs` — a schema change and a
 * migration, deliberately out of scope here. It is strictly better than the
 * status quo (where A never renews at all and B is guaranteed to be reaped
 * too), and the queue's at-least-once contract already covers the outcome.
 */
export function heldLeaseWhere(jobId: string, nodeId?: string | null): Prisma.JobWhereInput {
  return {
    id: jobId,
    status: 'running',
    leaseExpiresAt: { gt: new Date() },
    ...(nodeId !== undefined ? { claimedByNodeId: nodeId } : {}),
  };
}

@Injectable()
export class JobLeaseService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pushes the lease on `jobId` out by `leaseMs` from now.
   *
   * Returns `true` when the row was still held and the write landed, `false`
   * when it was not — reaped, settled, or taken by another executor. FALSE IS
   * NOT AN ERROR AND MUST NOT THROW: both callers are on a keep-alive path
   * with real work in flight, and the correct response to "you no longer own
   * this row" is to stop renewing and say so, not to fail the work that is
   * still running. (The node plane converts the `false` into a 409 of its
   * own, because there a remote caller is waiting for an answer.)
   */
  async renew(jobId: string, leaseMs: number, nodeId?: string | null): Promise<boolean> {
    return this.renewUntil(jobId, new Date(Date.now() + leaseMs), nodeId);
  }

  /**
   * The same renewal, expressed as an ABSOLUTE instant.
   *
   * EXISTS FOR ONE CALLER AND ONE REASON: `NodesService.renewLease` must
   * report the new `leaseExpiresAt` back to the node in its response body, and
   * a node that was told one instant while the row carries another (computed
   * a few milliseconds later inside `renew`) would schedule its next renewal
   * against a deadline that is not the one the reaper reads. The worker has no
   * such obligation — it only needs to know whether it still holds the row —
   * so it takes the duration form above. Both are the same statement.
   */
  async renewUntil(
    jobId: string,
    leaseExpiresAt: Date,
    nodeId?: string | null
  ): Promise<boolean> {
    const { count } = await this.prisma.job.updateMany({
      where: heldLeaseWhere(jobId, nodeId),
      data: { leaseExpiresAt },
    });

    // `id` is the primary key, so this is 0 or 1 and never more. Comparing to
    // 1 rather than `> 0` says so.
    return count === 1;
  }
}
