// =============================================================================
// What a node may claim HERE, RIGHT NOW — one answer, two readers (#352, #345)
// =============================================================================
//
// `JobHandlerRegistry.serverOnlyTypes()` answers a STATIC question: does this
// handler carry the two members that make a type runnable off-box? That was
// the whole question until #352, and while it was, the two executors could
// partition the queue between them by each reading it directly — the node
// plane took its complement, the `system` worker mode took it verbatim.
//
// #352 broke that, and it is worth being precise about how, because the shape
// of the bug is more interesting than the bug:
//
//   `db.backup.run` is node-eligible STRUCTURALLY (it carries
//   `nodeResultSchema` + `persistNodeResult`), so `serverOnlyTypes()` stopped
//   containing it — permanently, for every deployment. But whether a node may
//   ACTUALLY claim it depends on three runtime gates
//   (`nodes.jobSecretBrokerEnabled`, the handler's own `nodeOffloadEnabled()`,
//   and the broker's `usable()` probe), all of which ship OFF or unproven. So
//   a deployment running `JOBS_WORKER_MODE=system` stopped claiming backups by
//   derivation, while no node was allowed to claim them either.
//
//   NOBODY RAN THE BACKUPS. Not a slow path, not a degraded one: none. The
//   recovery was an operator noticing an alert and adding the type to
//   `JOBS_SYSTEM_MODE_EXTRA_TYPES` — a workaround for a partition that had
//   silently developed a hole.
//
// -----------------------------------------------------------------------------
// THE FIX IS THE SAME ONE `resolveJobLeaseMs` MAKES ABOUT LEASES
// -----------------------------------------------------------------------------
//
// One function, both executors, opposite directions:
//
//   * `NodesService.nodeEligibleTypes()` → the set (what a node MAY claim).
//   * `JobWorker.systemModeEligibleTypes()` → its COMPLEMENT, plus the
//     operator's `JOBS_SYSTEM_MODE_EXTRA_TYPES`.
//
// The two are then a partition BY CONSTRUCTION rather than by two independent
// derivations that happen to agree today. The failure mode of two answers is
// the same here as it is for a lease and its renewal interval: work that
// neither side claims (a hole) or a value each side computes differently (a
// double claim). Deriving one from the other makes the hole unrepresentable.
//
// ⚠ WHY THIS LIVES IN `jobs/` AND NOT IN `nodes/`. The nodes module imports
// the jobs module (the registry, the claim, the lease, the terminal service);
// the reverse would be a cycle. `JobWorker` needs this answer, so the answer
// has to live on the side that does not import the other. That is also why the
// nodes' fail-closed reading of `jobSecretBrokerEnabled` is a function
// exported from here and CALLED by `NodeLifecycleService`, rather than a rule
// written down twice.
//
// ⚠ IT NEVER THROWS, AND ITS FAILURE DIRECTION IS DELIBERATE. A settings read
// that fails withholds the type from NODES — which, read through the
// complement, means the SERVER claims it. For the type this exists for that is
// exactly right: a database backup taken on the API server is a fine outcome,
// and a database backup nobody takes is the failure this whole file is about.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type { JobHandler } from './job-handler.interface';
import { JobHandlerRegistry } from './job-handler.registry';
import type { JobSecretBroker } from './job-secret-broker';

/**
 * Is a stored `nodes` policy's credential brokering on?
 *
 * ⚠ FAIL-CLOSED, AND ONLY A LITERAL `true` COUNTS (#349). A missing key, the
 * string `"true"`, the number `1` and an unreadable row are all "no", because
 * the safe answer to "may a machine this deployment may not own hold a
 * credential to this database?" is no.
 *
 * ONE DEFINITION, TWO CALLERS: this one, and `NodeLifecycleService.getPolicy`,
 * which is where the rule was written before it needed a second reader. A
 * second literal `=== true` somewhere is how "the fleet page says brokering is
 * off while the claim thinks it is on" starts.
 */
export function readJobSecretBrokerEnabled(
  policy: { jobSecretBrokerEnabled?: unknown } | null | undefined
): boolean {
  return policy?.jobSecretBrokerEnabled === true;
}

@Injectable()
export class NodeOffloadService {
  private readonly logger = new Logger(NodeOffloadService.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly settings: SystemSettingsService
  ) {}

  /**
   * The registered types a node may claim in THIS deployment, right now.
   *
   * DERIVED FROM THE REGISTRY, never from a list here: a type is
   * node-eligible exactly when its handler carries BOTH `nodeResultSchema`
   * and `persistNodeResult`, and `serverOnlyTypes()` is already the
   * authoritative complement of that (see `job-handler.interface.ts`'s
   * header). Computing the base as "everything minus server-only" rather than
   * re-testing the two members means this file cannot disagree with the
   * registry about what node-eligible MEANS.
   *
   * ⚠ THE THREE GATES ARE A RUNTIME INTERSECTION, NEVER A MUTATION OF THE
   * REGISTRY. A type whose handler carries a `nodeSecretBroker` is
   * node-eligible — permanently, structurally, because its handler says so —
   * and this method does not change that fact, it declines to OFFER the type.
   * The tempting shortcut (unregistering the handler, or a `nodeEligible =
   * false` flag) would make "can this type run on a node" depend on a runtime
   * setting, which is exactly the disagreement `job-handler.interface.ts`
   * spends a section making unrepresentable. A deployment's policy and a
   * type's capability are different facts, and they are intersected HERE, at
   * the moment of the claim, where the intersection is visible.
   *
   * ⚠ CHEAPEST GATE FIRST, AND THE ORDER IS LOAD-BEARING FOR COST, NOT FOR
   * OUTCOME:
   *
   *   1. `nodes.jobSecretBrokerEnabled` — one narrow settings read for the
   *      whole call, and free thereafter.
   *   2. `handler.nodeOffloadEnabled()` — the feature's own policy, read from
   *      wherever that feature keeps it.
   *   3. `broker.usable()` — the ONLY gate that opens a connection to
   *      anything. It runs last, for the types that survived the two
   *      decisions a deployment has already made, so a deployment with
   *      offload off never probes a database it has decided not to use.
   *
   * NOT CACHED, deliberately: a cache is how "the administrator switched
   * brokering off" takes effect at some unspecified later time. The settings
   * read is one indexed lookup, and `PgJobRoleBroker.usable` keeps its own
   * ~60s probe cache, so the per-claim cost is a query and a cached boolean.
   */
  async offeredTypes(): Promise<string[]> {
    const serverOnly = new Set(this.registry.serverOnlyTypes());
    const eligible = this.registry.types().filter((type) => !serverOnly.has(type));

    const brokerEnabled = await this.brokerEnabled();
    const offered: string[] = [];

    for (const type of eligible) {
      const handler = this.registry.get(type);

      if (handler === undefined) continue;

      if (handler.nodeSecretBroker !== undefined && !brokerEnabled) {
        this.logger.debug(
          `Withholding "${type}" from the node plane: it needs a per-job credential and ` +
            `nodes.jobSecretBrokerEnabled is off.`
        );

        continue;
      }

      if (!(await this.offloadAllowed(type, handler))) continue;

      if (
        handler.nodeSecretBroker !== undefined &&
        !(await this.brokerUsable(type, handler.nodeSecretBroker))
      ) {
        continue;
      }

      offered.push(type);
    }

    return offered;
  }

  /**
   * The complement: every registered type NO node may claim here right now.
   *
   * THIS is what `system` worker mode means — "run what the fleet cannot" —
   * and expressing it as the complement of {@link offeredTypes} rather than as
   * `serverOnlyTypes()` is the whole point of this service. See the file
   * header for the hole the static answer left.
   *
   * Note what it is a complement OF: `registry.types()`, this process's
   * registered handlers. A type this process cannot run is not in either set,
   * because claiming a type with no handler here fails those jobs permanently
   * (`JobWorker.runJob`).
   */
  async serverOnlyRightNow(): Promise<string[]> {
    const offered = new Set(await this.offeredTypes());

    return this.registry.types().filter((type) => !offered.has(type));
  }

  /**
   * `nodes.jobSecretBrokerEnabled`, or `false` if it cannot be read.
   *
   * A failure here means the node plane is offered nothing that needs a
   * credential — and, through the complement, the server claims it. See the
   * file header on why that direction is the safe one.
   */
  private async brokerEnabled(): Promise<boolean> {
    try {
      return readJobSecretBrokerEnabled(await this.settings.getNodesPolicy());
    } catch (error) {
      this.logger.warn(
        `Could not read nodes.jobSecretBrokerEnabled; withholding every type that needs a ` +
          `per-job credential from the node plane (the in-process worker still claims them): ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      return false;
    }
  }

  /**
   * `handler.nodeOffloadEnabled()`, defaulting to YES when the member is absent.
   *
   * The default is what keeps this additive: every node-eligible type written
   * before #352 carries no gate and is offered exactly as it always was. A
   * throw is treated as "no" — one type withheld beats a claim that fails, and
   * the node is very likely holding unrelated work.
   */
  private async offloadAllowed(type: string, handler: JobHandler): Promise<boolean> {
    if (handler.nodeOffloadEnabled === undefined) return true;

    try {
      if (await handler.nodeOffloadEnabled()) return true;

      this.logger.debug(
        `Withholding "${type}" from the node plane: this deployment has not enabled node ` +
          `offload for it.`
      );

      return false;
    } catch (error) {
      this.logger.warn(
        `Withholding "${type}" from the node plane: its offload gate threw — ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      return false;
    }
  }

  /**
   * `broker.usable()`, reduced to a boolean and unable to fail a claim.
   *
   * The failure it prevents is specific and expensive: without it a node
   * claims the job, asks for its credential, gets a 503 and defers — burning a
   * claim and a lease cycle EVERY POLL on a deployment that simply cannot mint
   * roles (managed PostgreSQL denying `CREATEROLE` is the ordinary case; see
   * `docs/runbooks/node-job-secrets.md`).
   *
   * ⚠ A THROWN PROBE IS "NO", NOT AN ERROR. `usable()` is contracted to be
   * cheap and side-effect-free, but it talks to a database, and a connection
   * refused while a node is claiming must withhold ONE TYPE rather than fail
   * the whole claim.
   */
  private async brokerUsable(type: string, broker: JobSecretBroker): Promise<boolean> {
    try {
      const verdict = await broker.usable();

      if (verdict.ok) return true;

      this.logger.debug(
        `Withholding "${type}" from the node plane: its ${broker.kind} credential broker ` +
          `is not usable here — ${verdict.reason} (${verdict.remedy})`
      );

      return false;
    } catch (error) {
      this.logger.warn(
        `Withholding "${type}" from the node plane: probing its ${broker.kind} credential ` +
          `broker threw — ${error instanceof Error ? error.message : String(error)}`
      );

      return false;
    }
  }
}
