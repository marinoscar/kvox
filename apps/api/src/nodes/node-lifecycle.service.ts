// =============================================================================
// Fleet lifecycle: one notion of liveness, shared by everything (issue #270,
// epic #254)
// =============================================================================
//
// `deregister` is a GRACEFUL SHUTDOWN, and graceful shutdowns are not how
// workers usually stop. A node that is OOM-killed, that segfaults in a native
// dependency, that is a spot instance reclaimed mid-job, or that is simply on
// the wrong side of a network partition never calls it. Nothing else writes
// to that row either — a node has no database access — so its `status` sits
// at `online` forever, and the admin fleet page renders a green "online" chip
// above a three-week-old heartbeat. That is WORSE than showing no status at
// all: an operator who can see there is no data goes and looks; an operator
// shown a confident green chip does not.
//
// This file is the answer to "what does this fleet actually look like right
// now", and it is deliberately SMALL: a policy read that cannot throw, and a
// pure function that turns a row plus a clock into a health verdict. The two
// crons and the admin plane all go through it, which is the entire point —
// see below.
//
// -----------------------------------------------------------------------------
// THE FAILURE THIS FILE'S EXISTENCE PREVENTS: TWO NOTIONS OF LIVENESS
// -----------------------------------------------------------------------------
//
// There are three consumers of "is this node alive":
//
//   1. `NodeStaleOfflineTask` — flips a silent node's STATUS to `offline`.
//   2. `NodeOfflinePruneTask` — deletes `offline` rows past retention.
//   3. `NodesAdminService` — renders a health verdict on the fleet page.
//
// If (1) and (3) computed the window separately, the page would show a "stale"
// pill for a node the sweep still counts as fine, or the reverse — and which
// one an operator believed would depend on which screen they happened to be
// looking at. So the window is read ONCE, here, and the verdict is computed by
// ONE function, here.
//
// The same argument is what makes `offlineStaleMultiplier` a MULTIPLIER rather
// than an independent "declare a node offline after N minutes" setting. See
// `NodeStaleOfflineTask`'s header: a second duration is a second definition of
// liveness, and the two can be configured into contradicting each other by an
// administrator who has no way to know they are related.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A SERVICE AND NOT A FUNCTION IN EACH TASK
// -----------------------------------------------------------------------------
//
// REJECTED: each cron reading `SystemSettingsService` itself. It is one line
// per task, and it is how the fallback behaviour diverges: the first task to
// be given a `try`/`catch` gets one, the second does not, and a settings read
// that failed then stops the prune while the sweep carries on — which is
// precisely the ordering that silently voids retention (again, see
// `NodeOfflinePruneTask`). One accessor, one fallback, one log line.
//
// REJECTED: caching the policy in memory. The values are read at most 145
// times a day between the two crons; a cache would buy nothing and would mean
// an administrator changing the stale window has to guess how long until it
// takes effect.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { SystemNodesValue } from '../common/schemas/settings.schema';
import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { readJobSecretBrokerEnabled } from '../jobs/node-offload.service';

/**
 * The derived liveness verdict for one node.
 *
 * DERIVED, never stored. There is no `health` column and there must not be
 * one: a stored verdict is a value that is correct at write time and rots
 * silently thereafter, which is the exact bug this issue exists to prevent,
 * reintroduced one layer up. `status` is operator/administrative state;
 * `health` is a function of the clock, computed at read time.
 */
export type NodeHealth = 'healthy' | 'stale' | 'offline';

/** The subset of a `WorkerNode` row a health verdict is a function of. */
export interface NodeHealthInput {
  status: string;
  lastHeartbeatAt: Date | null;
}

/**
 * `offline` when the status already says so, `healthy` when the last heartbeat
 * is inside the stale window, `stale` otherwise.
 *
 * THE ORDER OF THE THREE BRANCHES IS THE WHOLE DEFINITION, so it is worth
 * spelling out what each one means:
 *
 *   - `offline` FIRST, from `status`. Either the node said so (`deregister`,
 *     a graceful shutdown) or the stale sweep concluded it. Recomputing a
 *     verdict from the heartbeat for a row that is already `offline` would let
 *     a node that was gracefully deregistered five seconds ago render as
 *     `healthy`, which is a straight contradiction of the chip beside it.
 *
 *   - `healthy` when `now - lastHeartbeatAt < staleHeartbeatSeconds`. Note it
 *     is `lastHeartbeatAt` and NOT `status`: a node whose row says `online` is
 *     making a claim about itself that only the heartbeat can corroborate.
 *
 *   - `stale` for everything else, INCLUDING `lastHeartbeatAt === null`. A
 *     node that registered and never phoned home is not healthy — it is a
 *     process that started and never got as far as its first heartbeat, which
 *     is a real and common failure (a bad credential, a firewall, a crash in
 *     startup). Reading `null` as healthy is how such a node hides.
 *
 * `disabled` and `draining` are deliberately NOT special-cased. Both are
 * operator intent about what a node may CLAIM, and neither says anything about
 * whether the process is still running: a disabled node that is still
 * heartbeating is disabled AND healthy, and an operator re-enabling it wants
 * to know that before they do. The two facts are rendered as two fields
 * (`status` and `health`) precisely so they cannot overwrite each other.
 *
 * PURE, and takes `now` explicitly, so the fleet page and the crons can be
 * pinned to one instant in a test rather than racing the wall clock.
 */
export function deriveNodeHealth(
  node: NodeHealthInput,
  staleHeartbeatSeconds: number,
  now: Date = new Date()
): NodeHealth {
  if (node.status === 'offline') {
    return 'offline';
  }

  if (!node.lastHeartbeatAt) {
    return 'stale';
  }

  const staleAfter = now.getTime() - staleHeartbeatSeconds * 1000;

  return node.lastHeartbeatAt.getTime() > staleAfter ? 'healthy' : 'stale';
}

@Injectable()
export class NodeLifecycleService {
  private readonly logger = new Logger(NodeLifecycleService.name);

  constructor(private readonly systemSettings: SystemSettingsService) {}

  /**
   * The fleet policy, from the `nodes` system-settings namespace.
   *
   * READ THROUGH THE NARROW SETTINGS ACCESSOR (`getNodesPolicy`), not with a
   * `system_settings` query of its own — the same rule
   * `JobStuckService.getStuckThresholdMinutes()` follows, and for the same
   * reason: a second read path is how "the sweep uses a different window than
   * the fleet page shows" starts.
   *
   * NEVER THROWS. Two of the three callers are cron ticks with nobody to
   * report to, and a settings read that failed is not a reason to stop
   * sweeping — it is a reason to sweep on the shipped defaults, loudly.
   * Each field is validated INDEPENDENTLY rather than the block being
   * accepted or rejected whole: a stored row that somehow carries a good
   * `staleHeartbeatSeconds` and a garbage `offlineRetentionDays` should keep
   * the good half, because falling back on both would silently change the
   * threshold an operator is watching.
   */
  async getPolicy(): Promise<SystemNodesValue> {
    const defaults = DEFAULT_SYSTEM_SETTINGS.nodes;

    try {
      const policy = await this.systemSettings.getNodesPolicy();

      return {
        staleHeartbeatSeconds: positive(policy?.staleHeartbeatSeconds, defaults.staleHeartbeatSeconds),
        offlineStaleMultiplier: positive(policy?.offlineStaleMultiplier, defaults.offlineStaleMultiplier),
        offlineRetentionDays: positive(policy?.offlineRetentionDays, defaults.offlineRetentionDays),
        // ⚠ FAIL-CLOSED, UNLIKE ITS THREE NEIGHBOURS (#349, epic #345). The
        // other three degrade to the SHIPPED value, because sweeping on the
        // default window beats not sweeping. This one degrades to `false`,
        // because the safe answer to "may a node hold a credential to this
        // database?" when the stored setting is unreadable is no. Only a
        // literal `true` enables it; anything else — a missing key, a string
        // `"true"`, a number — is off.
        //
        // ⚠ THE RULE ITSELF MOVED TO `jobs/node-offload.service.ts` (#352) and
        // is CALLED here rather than repeated. `NodeOffloadService` needs the
        // same answer and cannot import this file (nodes imports jobs; the
        // reverse is a cycle), and two literal `=== true` checks are how "the
        // fleet page says brokering is off while the claim thinks it is on"
        // starts.
        jobSecretBrokerEnabled: readJobSecretBrokerEnabled(policy),
      };
    } catch (error) {
      this.logger.warn(
        `Could not read the nodes system settings; falling back to the shipped fleet policy ` +
          `(stale ${defaults.staleHeartbeatSeconds}s x${defaults.offlineStaleMultiplier}, ` +
          `retention ${defaults.offlineRetentionDays}d): ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      return { ...defaults };
    }
  }

  /**
   * The instant before which a heartbeat means "this node is gone", from
   * `staleHeartbeatSeconds x offlineStaleMultiplier`.
   *
   * Derived here rather than in the sweep so that the number the sweep acts on
   * and the number the fleet page explains are computed once. See
   * `NodeStaleOfflineTask` for why this is a multiple of the stale window and
   * not a setting of its own.
   */
  staleCutoff(policy: SystemNodesValue, now: Date): Date {
    return new Date(
      now.getTime() - policy.staleHeartbeatSeconds * policy.offlineStaleMultiplier * 1000
    );
  }

  /** The instant before which an `offline` node's record has outlived its retention. */
  retentionCutoff(policy: SystemNodesValue, now: Date): Date {
    return new Date(now.getTime() - policy.offlineRetentionDays * 24 * 60 * 60 * 1000);
  }
}

/**
 * A stored number, or the shipped default when it is missing, non-finite or
 * not positive.
 *
 * `NaN` is the case that matters: every comparison against it is false, so a
 * `NaN` window would produce a cutoff of `Invalid Date` and an `updateMany`
 * that silently matches NOTHING — a sweep that runs 144 times a day and does
 * nothing, with no error anywhere. Falling back to the default keeps the
 * fleet honest on a damaged settings row.
 */
function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
