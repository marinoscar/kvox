// =============================================================================
// NodeSecretRevoker — the fast half of revocation (issue #349, epic #345)
// =============================================================================
//
// ONE LISTENER, and it exists so that a per-job credential is destroyed
// MILLISECONDS after the job it belonged to settles, rather than at the next
// sweep or, worse, at its own expiry. Modelled directly on
// `notifications/ops/job-failure-notifier.ts`, whose header carries the full
// argument for the shape; the parts that are the same are the parts that are
// load-bearing, so they are restated briefly here rather than cross-referenced
// and forgotten.
//
// -----------------------------------------------------------------------------
// 1. WHY A LISTENER AND NOT A CALL INSIDE `JobTerminalService`
// -----------------------------------------------------------------------------
//
// The direct call is shorter and is wrong for two reasons. It would make
// `JobsModule` — the module every feature enqueues through — depend on the
// nodes module, which already depends on `JobsModule`: a cycle Nest reports at
// boot and that somebody then "fixes" with `forwardRef`, making it invisible
// rather than absent. And `JobTerminalService` is the terminal CHOKEPOINT,
// whose `safeTerminalUpdate` swallows database failures on purpose because an
// exception escaping it strands a worker slot for the life of the process;
// hanging an outbound side effect off it makes the queue's most
// safety-critical method also the place a revocation bug lands.
//
// `jobs/events/job-settled.event.ts` exists precisely so a listener can be a
// bystander. This is that listener, registered on the NODES side of the seam,
// where the credential's owner lives.
//
// -----------------------------------------------------------------------------
// 2. `EventEmitter2` DISPATCHES SYNCHRONOUSLY — SO THIS MUST NOT BLOCK OR THROW
// -----------------------------------------------------------------------------
//
// `emitSettled` calls `emit` inline, inside the worker's completion path, so
// whatever happens here happens BEFORE the worker frees its slot. The handler
// therefore returns synchronously in every case, wraps its whole body in
// try/catch, and `.catch()`es the detached promise — the last of those because
// an unhandled rejection raised inside a synchronous emitter dispatch surfaces
// with a stack pointing at a worker that did nothing wrong, and a `try/catch`
// cannot see a rejected promise.
//
// It is deliberately NOT registered with `{ async: true }`: that makes the
// emitter await the handler, which is the opposite of what a terminal path
// needs.
//
// -----------------------------------------------------------------------------
// 3. NO STATUS FILTER — UNLIKE THE NOTIFIER
// -----------------------------------------------------------------------------
//
// `JobFailureNotifier` filters on `status === 'failed'` because only a give-up
// is news. A credential is not news; it is a capability, and a job that
// SUCCEEDED has exactly as much business still holding one as a job that
// failed: none. So every settle revokes.
//
// What does not reach this listener at all is an ordinary retry or a
// rate-limit deferral: both write `status: 'pending'` and never call
// `emitSettled`. THAT IS CORRECT, not a gap. A retry runs the same job again,
// the node asks again, and `issue` extends the SAME grant (one credential per
// job, ever) — revoking between attempts would destroy and recreate a role on
// every lap for no benefit. The grant's expiry still bounds it, and if the
// retry is claimed by a different executor the sweeper's hold predicate
// notices immediately.
//
// -----------------------------------------------------------------------------
// 4. THE REGISTRY SHORT-CIRCUIT, AND WHY IT IS NOT A CACHE
// -----------------------------------------------------------------------------
//
// `couldHoldGrant(type)` is a Map lookup against the handler registry, and it
// is what keeps this listener off the database entirely in the ~100% of
// deployments where no type declares a broker. It is not an optimisation of a
// correctness check — if nothing in this process can mint a grant for this
// type, this process wrote no row to find. The one case it misses is a fork
// that REMOVED a broker while grants of its kind were still live, which is a
// deployment change rather than a per-job event, and which the sweeper covers.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  JOB_SETTLED_EVENT,
  type JobSettledEvent,
} from '../../jobs/events/job-settled.event';
import { NodeSecretBrokerService } from '../node-secret-broker.service';

@Injectable()
export class NodeSecretRevoker {
  private readonly logger = new Logger(NodeSecretRevoker.name);

  constructor(private readonly broker: NodeSecretBrokerService) {}

  /**
   * A job settled. Destroy any credential it was holding.
   *
   * RETURNS SYNCHRONOUSLY IN EVERY CASE. See section 2 of the header: this runs
   * inside the worker's completion path, so nothing here may be awaited and
   * nothing here may throw.
   */
  @OnEvent(JOB_SETTLED_EVENT)
  handleJobSettled(event: JobSettledEvent): void {
    try {
      // Section 4: no registered broker for this type means no row to look for.
      if (!this.broker.couldHoldGrant(event.type)) return;

      const jobId = event.jobId;

      // DETACHED, and never awaited — the worker must not wait on a `DROP
      // ROLE`. `.catch()` despite `revokeForJob` contracting not to reject:
      // that guarantee belongs to the service, and an unhandled rejection here
      // is the one failure this listener's whole shape exists to make
      // impossible.
      void this.broker
        .revokeForJob(jobId)
        .then((revoked) => {
          if (revoked > 0) {
            this.logger.log(
              `Revoked ${revoked} per-job credential(s) for settled job ${jobId}`
            );
          }
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Revoking credentials for settled job ${jobId} rejected, which the broker ` +
              `service contracts never to do; the sweeper will retry: ` +
              `${error instanceof Error ? error.message : String(error)}`
          );
        });
    } catch (error) {
      // Belt and braces over `emitSettled`'s own catch. Revocation must never
      // be able to affect a terminal row or a worker slot — and the sweeper is
      // exactly the backstop for a grant this path dropped.
      this.logger.error(
        `Could not start credential revocation for settled job ${event.jobId}; the job's ` +
          `terminal row is unaffected and the sweeper will pick it up: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
