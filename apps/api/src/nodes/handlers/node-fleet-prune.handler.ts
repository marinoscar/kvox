// =============================================================================
// `nodes.fleet.prune` — the offline-node prune as a queue job (issue #353, epic #345)
// =============================================================================
//
// Fleet inventory is not history. A `Job` row is a record of work that happened
// and is kept until the history purge decides otherwise; a `WorkerNode` row is a
// LIVE REGISTRATION — the machine it names is either still out there or it is
// not. A laptop that ran three jobs in April and was reimaged in May leaves a
// row that will never heartbeat again, and a fleet page that shows fifty of
// those is a fleet page nobody can read.
//
// So `nodes.offlineRetentionDays` forgets them. This handler is what makes that
// setting mean something. The three statements below are
// `NodeOfflinePruneTask.prune`\'s, moved verbatim; what #353 changed is the
// executor — the daily cron enqueues, a worker slot runs it, and a prune that
// failed is a `jobs` row with a `lastError` instead of one log line. The kill
// switch (`NODE_OFFLINE_PRUNE_ENABLED`) stayed with the scheduling decision, in
// the task; see `NodeFleetSweepHandler`\'s header for why it is not re-asked
// here.
//
// -----------------------------------------------------------------------------
// ⚠ THIS HANDLER IS DEAD CODE WITHOUT `NodeFleetSweepHandler`, AND THAT
// ORDERING IS THE POINT OF THE PAIR
// -----------------------------------------------------------------------------
//
// It selects `status = \'offline\'`. A crashed node never calls `deregister`, so
// nothing ever writes that status to its row — it sits at `online` forever, and
// this prune can NEVER reach it. Retention would then apply to exactly the nodes
// that do not need it (the gracefully shut down ones) and never to the ones that
// do (the crashed ones that actually accumulate).
//
// That is the failure this pair is designed around, and it is invisible from
// inside this file: the prune runs daily, logs "0 nodes pruned", and looks like
// a fleet with nothing to clean up. The sweep is what supplies this handler\'s
// input, and `test/nodes/node-fleet-lifecycle.db.spec.ts` asserts the two IN
// SEQUENCE — crash a node, sweep, prune, expect the row gone — rather than
// asserting each in isolation, because each in isolation passes with the bug
// present.
//
// REJECTED: pruning by age alone, ignoring `status` ("delete any node whose last
// heartbeat is older than retention"). It would make this handler work without
// the sweep, and it would delete a DISABLED node — an administrator\'s explicit
// intent, recorded nowhere else — and a `draining` node that is slowly finishing
// a long job. `status = \'offline\'` is what keeps deletion to rows that
// something has already concluded are gone.
//
// -----------------------------------------------------------------------------
// A NODE STILL HOLDING A `running` JOB IS NEVER DELETED
// -----------------------------------------------------------------------------
//
// `Job.claimedByNode` is `onDelete: SetNull`, so deleting a node cannot delete a
// job and cannot fail on a foreign key — the deletion is SAFE regardless. The
// exclusion is not about safety, it is about not lying: a `running` row whose
// `claimedByNodeId` was just nulled says "some executor is working on this, and
// we no longer know which one", which is strictly less information than "node X
// is working on this" and is the state the lease reaper\'s diagnostics read. Live
// queue state must never point at a row that just vanished underneath it.
//
// In practice this is a narrow window — a node has to be `offline`, past
// retention (30 days by default), AND holding a job whose lease has not been
// reaped — but it is exactly the window a partitioned node produces, and the
// cost of the exclusion is one indexed query. Such a node is skipped, not
// failed: the reaper settles or requeues the job on its own schedule, and the
// next daily tick deletes the node. Nothing has to be re-run by hand.
//
// REJECTED: deleting the node and letting `SetNull` do its thing, on the grounds
// that the reaper will requeue the orphaned job anyway. It does — but between
// the delete and the next reaper tick the job is a `running` row owned by
// nobody, which is indistinguishable from the corrupt state the reaper\'s
// "zombie" signal exists to clean up after. Do not manufacture the state a
// recovery path exists to recover from.
//
// REJECTED (the other direction): refusing to delete a node holding a job in ANY
// state. Every node that ever ran anything holds `succeeded` and `failed` rows
// forever, so the prune would never delete anything at all. Only `running` is
// live.
//
// -----------------------------------------------------------------------------
// THREE STATEMENTS, STILL WITH NO OVERLAP GUARD, AND NO PROFILE
// -----------------------------------------------------------------------------
//
// Unlike the sweep this is three statements — select candidates, ask which are
// busy, delete the rest — because the exclusion is a fact about a different
// table. It is still idempotent and still needs no overlap guard: the final
// `deleteMany` RE-ASSERTS the full candidate predicate (`status`, and the age),
// so a node that re-registered between the read and the delete is left alone,
// and two workers racing produce one delete and one no-op. That idempotence is
// also why no execution profile is declared: the deployment-wide timeout and
// attempt budget are exactly right for work that can be re-run for free.
//
// SERVER-ONLY BY DERIVATION: neither `nodeResultSchema` nor `persistNodeResult`.
// A node that could claim this job could delete its own fleet\'s records, which
// is the clearest possible case of work that does not belong off-machine.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { NodeLifecycleService } from '../node-lifecycle.service';

/**
 * The handler key, and therefore the `Job.type` every fleet-prune row carries.
 * PERMANENT — rows outlive handlers. Exported so `NodeOfflinePruneTask` asks
 * about the same string it queues.
 */
export const NODE_FLEET_PRUNE_TYPE = 'nodes.fleet.prune';

/** What one prune did, split by what stopped a candidate from being deleted. */
export interface PruneOfflineNodesResult {
  /** Node rows removed. */
  deleted: number;

  /** Candidates left in place because they still hold a `running` job. */
  skippedBusy: number;
}

/**
 * The `where` identifying an `offline` node whose record has outlived
 * retention, as a pure function of the cutoff.
 *
 * The `OR` mirrors the stale sweep\'s arm for arm, and it has to: a node that
 * never heartbeated is aged by `registeredAt` there, so ageing it by
 * `lastHeartbeatAt` here would sweep it to `offline` and then never delete it
 * (`NULL < cutoff` is NULL, never true). The two predicates are two halves of
 * one lifecycle, and a change to one is a change to both.
 *
 * Exported so the delete can re-assert exactly what the select matched, without
 * a second hand-written copy that can drift from it.
 */
export function prunableOfflineNodeWhere(cutoff: Date): Prisma.WorkerNodeWhereInput {
  return {
    status: 'offline',
    OR: [
      { lastHeartbeatAt: { lt: cutoff } },
      { lastHeartbeatAt: null, registeredAt: { lt: cutoff } },
    ],
  };
}

/** A type guard, so `claimedByNodeId`\'s `string | null` narrows to `string`. */
function isNonNull(value: string | null): value is string {
  return value !== null;
}

@Injectable()
export class NodeFleetPruneHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(NodeFleetPruneHandler.name);

  readonly type = NODE_FLEET_PRUNE_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly lifecycle: NodeLifecycleService
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Runs the prune.
   *
   * THROWS TO FAIL — see `NodeFleetSweepHandler.process` for why a handler must
   * not swallow what the cron it replaced had to.
   */
  async process(job: Job): Promise<void> {
    const { deleted, skippedBusy } = await this.prune();

    if (deleted > 0 || skippedBusy > 0) {
      this.logger.log(
        `Fleet prune ${job.id}: ${deleted} offline worker node(s) forgotten, ` +
          `${skippedBusy} kept because they still hold a running job`
      );
    } else {
      this.logger.debug(`Fleet prune ${job.id}: no offline node is past its retention`);
    }
  }

  /**
   * Deletes every `offline` node past retention that is not still holding a
   * `running` job.
   *
   * Exposed as its own method so a test can drive it directly, without going
   * through `process`.
   */
  async prune(): Promise<PruneOfflineNodesResult> {
    const policy = await this.lifecycle.getPolicy();

    // ONE `now` for the whole prune, so the select and the delete's
    // re-assertion cannot disagree about the cutoff.
    const now = new Date();
    const cutoff = this.lifecycle.retentionCutoff(policy, now);
    const where = prunableOfflineNodeWhere(cutoff);

    const candidates = await this.prisma.workerNode.findMany({
      where,
      // Ids only. The row is about to be deleted; nothing here needs its
      // capabilities blob.
      select: { id: true },
    });

    if (candidates.length === 0) {
      return { deleted: 0, skippedBusy: 0 };
    }

    const candidateIds = candidates.map((node) => node.id);

    // ONE query for the whole candidate set, not one per node: `distinct`
    // makes this "which of these nodes is busy", which is the question, rather
    // than "list every running job", which could be large.
    const busy = await this.prisma.job.findMany({
      where: { status: 'running', claimedByNodeId: { in: candidateIds } },
      select: { claimedByNodeId: true },
      distinct: ['claimedByNodeId'],
    });

    const busyIds = new Set(busy.map((job) => job.claimedByNodeId).filter(isNonNull));
    const deletable = candidateIds.filter((id) => !busyIds.has(id));

    if (deletable.length === 0) {
      return { deleted: 0, skippedBusy: busyIds.size };
    }

    // The candidate predicate is RE-ASSERTED alongside the ids rather than
    // deleting by id alone: between the select above and this write a node may
    // have re-registered (which clears `offline` and stamps a fresh
    // heartbeat), and deleting it then would destroy a live registration a
    // worker is actively using. Re-asserting makes that case a no-op instead.
    const { count } = await this.prisma.workerNode.deleteMany({
      where: { ...where, id: { in: deletable } },
    });

    return { deleted: count, skippedBusy: busyIds.size };
  }
}
