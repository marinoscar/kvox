// =============================================================================
// Unit tests for the fleet's one notion of liveness (issue #270, epic #254)
// =============================================================================
//
// Two things are proven here, and both are about a SINGLE definition being
// used everywhere rather than about arithmetic:
//
//   1. `deriveNodeHealth` — the verdict the fleet page renders. The case that
//      matters most is the node that NEVER heartbeated: `null` is not
//      "healthy, no news is good news", it is a process that never got as far
//      as its first ping.
//   2. `getPolicy` cannot throw and cannot return a nonsense window. A `NaN`
//      threshold would produce a cutoff of `Invalid Date`, every comparison
//      against which is false — an `updateMany` that silently matches nothing,
//      144 times a day, with no error anywhere.
// =============================================================================

import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import { deriveNodeHealth, NodeLifecycleService } from './node-lifecycle.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';

const NOW = new Date('2026-09-01T12:00:00.000Z');

/** `secondsAgo` before the pinned `NOW`. */
function ago(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function makeService(getNodesPolicy: jest.Mock) {
  const settings = { getNodesPolicy } as unknown as SystemSettingsService;

  return new NodeLifecycleService(settings);
}

describe('deriveNodeHealth', () => {
  it('is healthy while the last heartbeat is inside the stale window', () => {
    expect(deriveNodeHealth({ status: 'online', lastHeartbeatAt: ago(30) }, 90, NOW)).toBe('healthy');
  });

  it('is stale once the last heartbeat falls outside it', () => {
    expect(deriveNodeHealth({ status: 'online', lastHeartbeatAt: ago(120) }, 90, NOW)).toBe('stale');
  });

  it('is stale for a node that has never heartbeated', () => {
    // THE CASE THAT HIDES. A node that registered and never sent a ping — a
    // bad credential, a firewall, a crash during startup — has `null` here.
    // Reading `null` as healthy makes the one node that definitely never
    // worked the one node that always looks fine.
    expect(deriveNodeHealth({ status: 'online', lastHeartbeatAt: null }, 90, NOW)).toBe('stale');
  });

  it('reports offline from the status, whatever the heartbeat says', () => {
    // A node that gracefully deregistered five seconds ago. Recomputing from
    // the heartbeat would render `healthy` beside an `offline` chip.
    expect(deriveNodeHealth({ status: 'offline', lastHeartbeatAt: ago(5) }, 90, NOW)).toBe('offline');
  });

  it('keeps disabled and draining nodes on the heartbeat verdict', () => {
    // `status` is what a node may CLAIM; `health` is whether the process is
    // still there. A disabled node that is still heartbeating is both, and an
    // operator about to re-enable it wants to know that.
    expect(deriveNodeHealth({ status: 'disabled', lastHeartbeatAt: ago(10) }, 90, NOW)).toBe('healthy');
    expect(deriveNodeHealth({ status: 'disabled', lastHeartbeatAt: ago(900) }, 90, NOW)).toBe('stale');
    expect(deriveNodeHealth({ status: 'draining', lastHeartbeatAt: ago(10) }, 90, NOW)).toBe('healthy');
  });
});

describe('NodeLifecycleService', () => {
  const defaults = DEFAULT_SYSTEM_SETTINGS.nodes;

  it('reads the policy through the narrow settings accessor', async () => {
    const getNodesPolicy = jest.fn().mockResolvedValue({
      staleHeartbeatSeconds: 30,
      offlineStaleMultiplier: 10,
      offlineRetentionDays: 5,
    });

    await expect(makeService(getNodesPolicy).getPolicy()).resolves.toEqual({
      staleHeartbeatSeconds: 30,
      offlineStaleMultiplier: 10,
      offlineRetentionDays: 5,
      // Absent from the stored block above, and the answer is `false` (#349).
      jobSecretBrokerEnabled: false,
    });
    expect(getNodesPolicy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the shipped policy when the settings read throws', async () => {
    // Called from a cron tick with nobody to report to: a failed settings read
    // is a reason to sweep on the defaults, loudly, not a reason to stop.
    const getNodesPolicy = jest.fn().mockRejectedValue(new Error('connection reset'));

    await expect(makeService(getNodesPolicy).getPolicy()).resolves.toEqual(defaults);
  });

  it('replaces only the damaged field of a partly nonsensical policy', async () => {
    // A `NaN` window makes every comparison false, so the cutoff is
    // `Invalid Date` and the sweep silently matches nothing. Falling back on
    // the whole block instead would move a threshold an operator is watching.
    const getNodesPolicy = jest.fn().mockResolvedValue({
      staleHeartbeatSeconds: 45,
      offlineStaleMultiplier: Number.NaN,
      offlineRetentionDays: 0,
    });

    await expect(makeService(getNodesPolicy).getPolicy()).resolves.toEqual({
      staleHeartbeatSeconds: 45,
      offlineStaleMultiplier: defaults.offlineStaleMultiplier,
      offlineRetentionDays: defaults.offlineRetentionDays,
      jobSecretBrokerEnabled: false,
    });
  });

  // ===========================================================================
  // jobSecretBrokerEnabled — the one field that FAILS CLOSED (#349, epic #345)
  // ===========================================================================

  it.each([
    ['the key is absent', {}],
    ['it is the string "true"', { jobSecretBrokerEnabled: 'true' }],
    ['it is the number 1', { jobSecretBrokerEnabled: 1 }],
    ['it is null', { jobSecretBrokerEnabled: null }],
    ['it is explicitly false', { jobSecretBrokerEnabled: false }],
  ])('reads jobSecretBrokerEnabled as false when %s', async (_label, stored) => {
    // The three numeric fields degrade to the SHIPPED value, because sweeping
    // on the default window beats not sweeping. This one degrades to `false`,
    // because the safe answer to "may a node hold a credential to this
    // database?" when the stored value is not a literal `true` is no.
    const getNodesPolicy = jest.fn().mockResolvedValue({
      ...DEFAULT_SYSTEM_SETTINGS.nodes,
      ...stored,
    });

    await expect(makeService(getNodesPolicy).getPolicy()).resolves.toMatchObject({
      jobSecretBrokerEnabled: false,
    });
  });

  it('reads jobSecretBrokerEnabled as true only for a literal true', async () => {
    const getNodesPolicy = jest.fn().mockResolvedValue({
      ...DEFAULT_SYSTEM_SETTINGS.nodes,
      jobSecretBrokerEnabled: true,
    });

    await expect(makeService(getNodesPolicy).getPolicy()).resolves.toMatchObject({
      jobSecretBrokerEnabled: true,
    });
  });

  it('falls back to brokering OFF when the settings read throws', async () => {
    // The fail-closed direction where it matters most: an unreadable settings
    // row must not be the reason a fleet gains database credentials.
    const getNodesPolicy = jest.fn().mockRejectedValue(new Error('connection reset'));

    await expect(makeService(getNodesPolicy).getPolicy()).resolves.toMatchObject({
      jobSecretBrokerEnabled: false,
    });
  });

  it('derives the offline cutoff as a multiple of the stale window', async () => {
    // The whole reason `offlineStaleMultiplier` is a multiplier: "offline" is
    // by construction some whole number of stale windows later than "stale",
    // in the same units, so the two cannot contradict each other.
    const service = makeService(jest.fn());
    const policy = {
      staleHeartbeatSeconds: 90,
      offlineStaleMultiplier: 4,
      offlineRetentionDays: 30,
      jobSecretBrokerEnabled: false,
    };

    expect(service.staleCutoff(policy, NOW)).toEqual(ago(360));
    expect(service.retentionCutoff(policy, NOW)).toEqual(ago(30 * 24 * 60 * 60));
  });
});
