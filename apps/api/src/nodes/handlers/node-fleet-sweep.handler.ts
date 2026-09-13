// =============================================================================
// `nodes.fleet.sweep` — the stale-node sweep as a queue job (issue #353, epic #345)
// =============================================================================
//
// THE BUG THIS HANDLER EXISTS TO PREVENT, stated as plainly as it can be: a
// node that crashes never says goodbye. `POST /nodes/:id/deregister` is a
// GRACEFUL shutdown — a cooperative process telling the control plane it is
// going away — and it is not how workers usually stop. An OOM kill, a segfault
// in a native dependency, a reclaimed spot instance, a closed laptop lid and a
// network partition all end the same way: the last thing the row ever hears is
// a heartbeat, and its `status` stays `online` forever.
//
// Two things go wrong when that happens, and the second is much worse than the
// first:
//
//   1. THE FLEET PAGE LIES. A green "online" chip sits above a three-week-old
//      heartbeat. An operator shown no data goes and looks; an operator shown a
//      confident green chip does not.
//
//   2. RETENTION IS SILENTLY VOIDED. `NodeFleetPruneHandler` selects
//      `status = \'offline\'`, so a row stuck at `online` can NEVER be reached by
//      it — `nodes.offlineRetentionDays` does nothing for exactly the failure
//      mode it exists for. Crashed nodes are the ones that accumulate;
//      gracefully deregistered ones are the ones that get cleaned up. Without
//      this sweep the prune is dead code, which is why the two are ordered and
//      why that ordering has a test of its own.
//
// -----------------------------------------------------------------------------
// WHAT #353 CHANGED, AND WHAT IT DELIBERATELY DID NOT
// -----------------------------------------------------------------------------
//
// The statement below is `NodeStaleOfflineTask.sweep`\'s, moved verbatim. WHAT
// CHANGED IS THE EXECUTOR: the ten-minute cron now only enqueues, and this
// handler runs on a worker slot, so a sweep that failed is a `jobs` row with a
// `lastError` and a retry rather than one log line on whichever process held
// the timer. Epic #345 decision 1 — every long-running activity is a job —
// applied to the last of the fleet\'s own housekeeping.
//
// The kill switch did NOT move. `NODE_STALE_OFFLINE_ENABLED` is a statement
// about whether THIS PROCESS maintains fleet liveness, so it is asked where the
// scheduling decision is made (`NodeStaleOfflineTask`) and not here: a sweep row
// that reached a worker was queued by a process that had already decided to
// sweep, and re-asking would let a fleet-sweep job queued by one replica be
// silently dropped by another.
//
// -----------------------------------------------------------------------------
// THE THRESHOLD IS A MULTIPLE OF THE STALE WINDOW, NOT A DURATION OF ITS OWN
// -----------------------------------------------------------------------------
//
// `cutoff = now - staleHeartbeatSeconds x offlineStaleMultiplier`.
//
// REJECTED: an independent `offlineAfterMinutes` setting. It reads like the
// simpler design — one number, one meaning, no arithmetic — and it creates TWO
// UNRELATED NOTIONS OF LIVENESS in a system that has to have exactly one. The
// UI\'s "stale" pill is `staleHeartbeatSeconds`; the database\'s `offline` status
// would be `offlineAfterMinutes`; nothing links them, and an administrator
// raising the heartbeat interval from 90s to 10 minutes (a perfectly reasonable
// thing to do for a fleet of laptops) would leave the offline threshold at
// whatever it was, silently marking every healthy node in the fleet offline.
// Expressed as a MULTIPLIER, "offline" is by construction some whole number of
// stale windows later than "stale", in the same units, and the two cannot be
// configured into contradicting each other.
//
// -----------------------------------------------------------------------------
// WHAT THE SWEEP MUST NOT TOUCH
// -----------------------------------------------------------------------------
//
// `disabled` IS NEVER AUTO-TRANSITIONED. It is an administrator\'s explicit
// intent — "this node may not claim, whatever it says about itself" — and it
// must survive the sweep. REJECTED: including it in the `in` list on the
// grounds that a disabled node that stopped heartbeating is also gone. The cost
// of being wrong is asymmetric and permanent: `offline` is a state a
// re-registering node CLEARS (see `NodesService.reattach`), so a disabled node
// swept to `offline` and then restarted comes back ONLINE AND ENABLED — the
// kill switch an operator threw would have been quietly undone by a timer.
// Nothing in the row records that it was ever disabled, so nobody would ever
// find out.
//
// `offline` is already terminal here, so it is not in the `in` list either:
// re-stamping a status a row already carries is a write that changes nothing
// and an update count that overstates what happened.
//
// -----------------------------------------------------------------------------
// ONE SET-BASED STATEMENT, AND NO OVERLAP GUARD
// -----------------------------------------------------------------------------
//
// The sweep is a single `updateManyAndReturn` whose `where` re-asserts
// everything it cares about, so it is idempotent and safe to run concurrently:
// two workers claiming two sweep rows at the same moment produce one winner and
// one empty array. That is why there is no advisory lock, no `isRunning` flag
// and no leader election here — the same reasoning `JobStuckResetTask` records
// for the lease reaper, and the reason this type needs no execution profile:
// re-running it is free.
//
// REJECTED: reading the candidate rows and updating them one at a time so each
// log line could name a node. A fleet is small enough that it would work, and
// it would replace an atomic statement with a read-then-write race for the sake
// of log prose. The names of the nodes that flipped are one query away on the
// fleet page, which is where somebody investigating is already looking.
//
// SERVER-ONLY BY DERIVATION: neither `nodeResultSchema` nor `persistNodeResult`
// (`job-handler.interface.ts`), which is also the only correct answer — the job
// IS an `UPDATE` against this application\'s own database, and there is nothing
// for a machine with no database access to compute. There is a second, sharper
// reason here: this is the sweep that decides a NODE is dead, so handing it to
// the fleet it polices would mean a fleet-wide outage is the one condition under
// which nothing notices a fleet-wide outage.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from '@prisma/client';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import type { NodeOfflineEmailData } from '../../email';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NodeLifecycleService } from '../node-lifecycle.service';

/**
 * The handler key, and therefore the `Job.type` every fleet-sweep row carries.
 * PERMANENT — rows outlive handlers. Exported so `NodeStaleOfflineTask` asks
 * about the same string it queues.
 */
export const NODE_FLEET_SWEEP_TYPE = 'nodes.fleet.sweep';

@Injectable()
export class NodeFleetSweepHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(NodeFleetSweepHandler.name);

  readonly type = NODE_FLEET_SWEEP_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly lifecycle: NodeLifecycleService,
    private readonly config: ConfigService,
    // #288 (epic #254). `NodesModule` imports `NotificationsModule` for this
    // one method. The direction is one-way and acyclic: notifications reach
    // Prisma, email and settings, and none of those reaches nodes.
    private readonly notifications: NotificationsService
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Runs the sweep.
   *
   * THROWS TO FAIL — the cron this replaced swallowed its errors because a
   * throw out of a `@Cron` handler is an unhandled rejection; a handler has a
   * worker above it whose whole job is to turn a rejection into `lastError`
   * plus a retry, so swallowing here would report a sweep that did not happen
   * as a `succeeded` row.
   */
  async process(job: Job): Promise<void> {
    const transitioned = await this.sweep();

    // Only say something when something happened. A healthy fleet queues this
    // 144 times a day, and 144 lines of "0 nodes" is how a log stops being read
    // — the `jobs` row is the durable record either way.
    if (transitioned > 0) {
      this.logger.warn(
        `Fleet sweep ${job.id}: ${transitioned} worker node(s) stopped heartbeating ` +
          'and were marked offline'
      );
    } else {
      this.logger.debug(`Fleet sweep ${job.id}: every node is still heartbeating`);
    }
  }

  /**
   * Marks every node that has gone silent past the threshold `offline`, and
   * returns how many rows changed.
   *
   * The `OR` has two arms and BOTH are necessary:
   *
   *   1. `lastHeartbeatAt < cutoff` — the ordinary case. A node that was
   *      healthy and stopped.
   *
   *   2. `lastHeartbeatAt IS NULL AND registeredAt < cutoff` — THE NODE THAT
   *      NEVER HEARTBEATED. It registered (so it has a row, and it shows up on
   *      the fleet page as `online`) and never got as far as its first
   *      heartbeat: a bad credential, a firewall, a crash during startup. Arm
   *      1 cannot see it, because `NULL < cutoff` is NULL and never true in
   *      SQL, so without this arm such a row is stuck at `online` FOREVER —
   *      and, per the header, permanently invisible to retention. `registeredAt`
   *      is the substitute age and is always present.
   *
   * Exposed as its own method purely so a test can drive the statement
   * directly, without going through `process`.
   */
  async sweep(): Promise<number> {
    const policy = await this.lifecycle.getPolicy();

    // ONE `now` for the whole sweep, passed in rather than read inside the
    // cutoff helper, so every row in one tick is judged against the same
    // instant and a test can pin it.
    const now = new Date();
    const cutoff = this.lifecycle.staleCutoff(policy, now);

    // ⚠ `updateManyAndReturn`, NOT `updateMany` — AND IT IS STILL ONE STATEMENT.
    //
    // #288 needs to raise `nodes.node_offline` once per node that ACTUALLY
    // FLIPPED, naming it and saying when it was last heard from, and neither
    // the name nor "did this tick flip it?" is derivable from an `updateMany`
    // count. The header above rejects reading the candidates first and updating
    // them one at a time, and that rejection stands: it would replace an atomic
    // statement with a read-then-write race between replicas, and both replicas
    // would then have to guess which rows were theirs.
    //
    // `UPDATE ... RETURNING` has neither problem. The `where` still re-asserts
    // everything the sweep cares about, so it is still idempotent and still
    // safe to run concurrently — two replicas ticking together produce one
    // winner and one EMPTY ARRAY, rather than one winner and one no-op count.
    // That is exactly the "which rows did I change?" answer the notification
    // needs, and it is the reason the transition can stay a single statement.
    const transitioned = await this.prisma.workerNode.updateManyAndReturn({
      where: {
        // `disabled` and `offline` are deliberately absent — see the header.
        status: { in: ['online', 'draining'] },
        OR: [
          { lastHeartbeatAt: { lt: cutoff } },
          { lastHeartbeatAt: null, registeredAt: { lt: cutoff } },
        ],
      },
      data: { status: 'offline' },
      // Only what the message renders. A sweep is not a page.
      select: { id: true, name: true, lastHeartbeatAt: true },
    });

    // ⚠ AFTER THE WRITE HAS COMMITTED, AND OUTSIDE ANY TRANSACTION.
    //
    // The statement above is the sweep. Everything below is reporting, it is
    // fire-and-forget, and it must not be able to affect either — which is why
    // `notifyPermissionHolders` is called (never awaited for delivery, never
    // able to reject) and why the whole loop sits behind a `try` of its own. A
    // notifier that threw here would abort `sweep()` AFTER the rows had already
    // been flipped, and the caller would log "fleet sweep failed" about a sweep
    // that succeeded.
    this.announceOffline(transitioned, policy.staleHeartbeatSeconds * policy.offlineStaleMultiplier);

    return transitioned.length;
  }

  /**
   * Raise `nodes.node_offline` once per node this tick actually flipped.
   *
   * NEVER THROWS, and never delays the sweep. `notifyPermissionHolders` is the
   * DETACHED entry point: it schedules the audience query and every send and
   * returns, so a mail server having a bad day cannot slow a ten-minute cron or
   * hold a database connection while it does.
   *
   * ONE MESSAGE PER NODE, not one summarising the batch. The reader's next
   * action is per node ("is that one meant to be up?"), and a digest that says
   * "3 nodes went offline" makes them go and look up which three — which is the
   * work the notification was supposed to save.
   */
  private announceOffline(
    nodes: ReadonlyArray<{ id: string; name: string; lastHeartbeatAt: Date | null }>,
    staleAfterSeconds: number
  ): void {
    if (nodes.length === 0) return;

    const markedOfflineAt = new Date();
    const appUrl = this.appUrl();

    try {
      for (const node of nodes) {
        // ANNOTATED WITH THE TEMPLATE'S OWN TYPE ON PURPOSE:
        // `notifyPermissionHolders` takes `data: unknown`, so this annotation
        // is the ONLY place the payload's shape is checked at all.
        const payload: NodeOfflineEmailData = {
          nodeId: node.id,
          nodeName: node.name,
          lastHeartbeatAt: node.lastHeartbeatAt,
          markedOfflineAt,
          staleAfterMinutes: Math.max(1, Math.round(staleAfterSeconds / 60)),
          appUrl,
        };

        // THE AUDIENCE IS `nodes:read` — the exact string
        // `nodes-admin.controller.ts` enforces, so the people told about a dead
        // node are by construction the people the API would let look at it.
        // ⚠ `.catch()` DESPITE THE DISPATCHER CONTRACTING NEVER TO REJECT.
        // That contract belongs to `NotificationsService`, not here, and an
        // unhandled rejection inside a `@Cron` tick has no caller to surface
        // it — it becomes a process-level `unhandledRejection` attributed to a
        // sweep that succeeded. The `try/catch` around this loop cannot see a
        // rejected promise; only this can.
        void this.notifications
          .notifyPermissionHolders(
            'nodes.node_offline',
            PERMISSIONS.NODES_READ,
            payload
          )
          .catch((error: unknown) => {
            this.logger.error(
              `Dispatching 'nodes.node_offline' for ${node.id} rejected, which ` +
                `the dispatcher contracts never to do: ` +
                `${error instanceof Error ? error.message : String(error)}`
            );
          });
      }
    } catch (error) {
      this.logger.error(
        `Could not raise 'nodes.node_offline'; the ${nodes.length} node(s) are ` +
          `still marked offline: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * The application root, trailing slashes trimmed, or `undefined`.
   *
   * Same shape as `UsersService.appUrl()`. `undefined` rather than a guess: the
   * template omits its CTA entirely rather than rendering a button that goes
   * nowhere.
   */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }
}
