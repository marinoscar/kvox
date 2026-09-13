// =============================================================================
// Unit tests for per-type execution profiles (issue #346, epic #345)
// =============================================================================
//
// TWO THINGS ARE WORTH ASSERTING HERE, and they are not the arithmetic.
//
//   1. THAT A TYPE WITH NO PROFILE IS UNCHANGED. Every resolver below has a
//      "no profile" path, and that path is the one every existing deployment
//      is on. It is asserted against the shipped numbers rather than against
//      whatever the profiled branch happens to produce, because the point is
//      that the two branches are independent — a change to the profiled one
//      must not be able to move the unprofiled one.
//
//   2. THAT AN UNUSABLE PROFILE DEGRADES RATHER THAN PROPAGATES. These
//      functions sit on the claim path: a `NaN` here becomes an unwritable
//      `lease_expires_at`, a `setTimeout(NaN)` that fires immediately, and an
//      attempt comparison that is false for every row. A fork's typo must cost
//      one warning, not the queue.
//
// The "server and node derive the same lease" property is asserted here too,
// and this is the right place for it: it is true BECAUSE both sides call
// `buildClaimLeases`, so the assertion belongs to that function rather than to
// either caller. `job.worker.spec.ts` and `nodes.service.spec.ts` each check
// their own side reaches it.
// =============================================================================

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  JobExecutionProfile,
  buildClaimLeases,
  resetJobProfileWarnings,
  resolveJobProfile,
  resolveMaxAttempts,
  resolveRenewIntervalMs,
} from './job-execution-profile';
import { JobHandler } from './job-handler.interface';
import { JobHandlerRegistry } from './job-handler.registry';

/** The shipped defaults, spelled out rather than imported — see `DEFAULT_CONFIG`. */
const SHIPPED_TIMEOUT_MS = 600_000;
const SHIPPED_MAX_ATTEMPTS = 3;
const LEASE_GRACE_MS = 60_000;
const UNBOUNDED_LEASE_MS = 3_600_000;

function stubConfig(values: Record<string, unknown> = {}): ConfigService {
  const merged: Record<string, unknown> = {
    'jobs.jobTimeoutMs': SHIPPED_TIMEOUT_MS,
    'jobs.maxAttempts': SHIPPED_MAX_ATTEMPTS,
    ...values,
  };

  return { get: (key: string) => merged[key] } as unknown as ConfigService;
}

/** A `ConfigService` that knows nothing — the directly-constructed test double. */
const emptyConfig = { get: () => undefined } as unknown as ConfigService;

function handler(type: string, profile?: JobExecutionProfile): JobHandler {
  return { type, profile, process: async () => undefined };
}

function registryOf(...handlers: JobHandler[]): JobHandlerRegistry {
  const registry = new JobHandlerRegistry();

  for (const entry of handlers) {
    registry.register(entry);
  }

  return registry;
}

describe('job execution profiles', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    // The warn-once latch is MODULE level, so it survives between cases. Left
    // un-reset, "warns exactly once" would pass vacuously for every case after
    // the first.
    resetJobProfileWarnings();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // resolveJobProfile — the single validation point
  // ---------------------------------------------------------------------------

  describe('resolveJobProfile', () => {
    it('returns undefined for a handler that declares none, silently', () => {
      // The overwhelmingly common case, and it must not warn: not declaring a
      // profile is the correct answer for almost every job type.
      expect(resolveJobProfile(handler('plain.type'))).toBeUndefined();
      expect(resolveJobProfile(undefined)).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns a usable profile unchanged', () => {
      const profile = { maxRuntimeMs: 21_600_000, maxAttempts: 1 };

      expect(resolveJobProfile(handler('db.backup', profile))).toBe(profile);
      expect(warn).not.toHaveBeenCalled();
    });

    it('accepts maxRuntimeMs of 0, which means NO ceiling', () => {
      // The same meaning `JOBS_JOB_TIMEOUT_MS=0` has. Zero is a legitimate
      // value, not a missing one, so the floor for this field is 0 and not 1.
      const profile = { maxRuntimeMs: 0, maxAttempts: 2 };

      expect(resolveJobProfile(handler('unbounded.type', profile))).toBe(profile);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ['a negative ceiling', { maxRuntimeMs: -1, maxAttempts: 3 }],
      ['a NaN ceiling', { maxRuntimeMs: Number.NaN, maxAttempts: 3 }],
      ['an infinite ceiling', { maxRuntimeMs: Number.POSITIVE_INFINITY, maxAttempts: 3 }],
      ['a zero attempt budget', { maxRuntimeMs: 1_000, maxAttempts: 0 }],
      ['a negative attempt budget', { maxRuntimeMs: 1_000, maxAttempts: -2 }],
      ['a NaN attempt budget', { maxRuntimeMs: 1_000, maxAttempts: Number.NaN }],
      [
        'fields of the wrong type entirely',
        { maxRuntimeMs: '10s', maxAttempts: null } as unknown as JobExecutionProfile,
      ],
    ])('drops a profile with %s, and warns naming the type', (_label, profile) => {
      expect(resolveJobProfile(handler('bad.type', profile as JobExecutionProfile))).toBeUndefined();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('bad.type');
    });

    it('drops the profile WHOLE, not field by field', () => {
      // The two numbers are one declaration. Honouring the budget an author
      // mistyped while inventing a ceiling they never chose is a stranger
      // state than putting the type back on the deployment defaults.
      const half = { maxRuntimeMs: Number.NaN, maxAttempts: 1 };
      const bad = handler('half.bad', half);

      expect(resolveJobProfile(bad)).toBeUndefined();
      expect(resolveMaxAttempts(stubConfig(), bad)).toBe(SHIPPED_MAX_ATTEMPTS);
    });

    it('warns ONCE per type, however many times it is read', () => {
      // These run on every claim and every settle: an unlatched warning is
      // several lines a second, forever, burying the one line that matters.
      const bad = handler('noisy.type', { maxRuntimeMs: -5, maxAttempts: 3 });

      for (let index = 0; index < 25; index += 1) {
        resolveJobProfile(bad);
      }

      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveMaxAttempts — read by BOTH give-up paths
  // ---------------------------------------------------------------------------

  describe('resolveMaxAttempts', () => {
    it('uses the deployment-wide budget when no profile applies', () => {
      expect(resolveMaxAttempts(stubConfig(), handler('plain.type'))).toBe(SHIPPED_MAX_ATTEMPTS);
      expect(resolveMaxAttempts(stubConfig({ 'jobs.maxAttempts': 7 }), undefined)).toBe(7);
    });

    it('prefers the profile over the deployment-wide budget', () => {
      const once = handler('never.retry', { maxRuntimeMs: 1_000, maxAttempts: 1 });

      expect(resolveMaxAttempts(stubConfig({ 'jobs.maxAttempts': 9 }), once)).toBe(1);
    });

    it('degrades to the shipped default rather than to NaN on an empty config', () => {
      // A stub `ConfigService` returning `undefined` must not produce `NaN`,
      // which would make every `attempts` comparison false and silently
      // disable the reaper's give-up phase.
      expect(resolveMaxAttempts(emptyConfig, undefined)).toBe(SHIPPED_MAX_ATTEMPTS);
      expect(resolveMaxAttempts(emptyConfig, handler('plain.type'))).toBe(SHIPPED_MAX_ATTEMPTS);
    });

    it('degrades to the deployment budget when the profile is unusable', () => {
      const bad = handler('bad.type', { maxRuntimeMs: 1_000, maxAttempts: 0 });

      expect(resolveMaxAttempts(stubConfig({ 'jobs.maxAttempts': 4 }), bad)).toBe(4);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveRenewIntervalMs — derived, never declared
  // ---------------------------------------------------------------------------

  describe('resolveRenewIntervalMs', () => {
    it('is a third of the lease, leaving room for two missed renewals', () => {
      expect(resolveRenewIntervalMs(90_000)).toBe(30_000);
    });

    it('is always strictly shorter than any lease this system can produce', () => {
      // THE PROPERTY THAT MATTERS. An interval at or above the lease is a
      // renewal that always arrives after the lease has already expired — the
      // node does the work, sends the renewals, and loses the job anyway.
      //
      // "any lease this system can produce" is the honest bound rather than
      // "any number": the 5s FLOOR would exceed a lease under 15s, and
      // `resolveJobLeaseMs` cannot return one — every lease it produces is
      // either a ceiling plus `LEASE_GRACE_MS` (so at least 60s) or the
      // unbounded hour. The cases below span that whole range, including both
      // ends of the clamp.
      for (const leaseMs of [60_000, 90_000, 180_001, 660_000, 3_600_000, 21_660_000]) {
        expect(resolveRenewIntervalMs(leaseMs)).toBeLessThan(leaseMs);
      }
    });

    it('clamps a very short lease up to the floor, and a very long one down to the ceiling', () => {
      expect(resolveRenewIntervalMs(3_000)).toBe(5_000);
      expect(resolveRenewIntervalMs(21_660_000)).toBe(60_000);
    });

    it('degrades a nonsense lease to the FLOOR, not the ceiling', () => {
      // Renewing too often costs a few requests; renewing too rarely loses the
      // job. When the input is meaningless the cheap mistake is the right one.
      for (const nonsense of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
        expect(resolveRenewIntervalMs(nonsense)).toBe(5_000);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // buildClaimLeases — one lease per eligible type, for BOTH claimers
  // ---------------------------------------------------------------------------

  describe('buildClaimLeases', () => {
    it('gives an unprofiled type the deployment-wide lease, exactly as before', () => {
      const registry = registryOf(handler('plain.type'));

      expect(buildClaimLeases(stubConfig(), registry, ['plain.type'])).toEqual([
        { type: 'plain.type', leaseMs: SHIPPED_TIMEOUT_MS + LEASE_GRACE_MS },
      ]);
    });

    it('derives a profiled type’s lease from its own ceiling, plus the same grace', () => {
      const registry = registryOf(handler('slow.type', { maxRuntimeMs: 21_600_000, maxAttempts: 1 }));

      expect(buildClaimLeases(stubConfig(), registry, ['slow.type'])).toEqual([
        { type: 'slow.type', leaseMs: 21_600_000 + LEASE_GRACE_MS },
      ]);
    });

    it('gives a profile of maxRuntimeMs 0 the unbounded lease', () => {
      const registry = registryOf(handler('forever.type', { maxRuntimeMs: 0, maxAttempts: 2 }));

      expect(buildClaimLeases(stubConfig(), registry, ['forever.type'])).toEqual([
        { type: 'forever.type', leaseMs: UNBOUNDED_LEASE_MS },
      ]);
    });

    it('emits ONE ENTRY PER ELIGIBLE TYPE, in order, for a heterogeneous claim', () => {
      // The case that made per-row leases necessary: a node claims across
      // several types in one statement, and each row needs its own lease.
      const registry = registryOf(
        handler('fast.type', { maxRuntimeMs: 30_000, maxAttempts: 3 }),
        handler('slow.type', { maxRuntimeMs: 7_200_000, maxAttempts: 1 }),
        handler('plain.type')
      );

      expect(
        buildClaimLeases(stubConfig(), registry, ['fast.type', 'slow.type', 'plain.type'])
      ).toEqual([
        { type: 'fast.type', leaseMs: 90_000 },
        { type: 'slow.type', leaseMs: 7_260_000 },
        { type: 'plain.type', leaseMs: 660_000 },
      ]);
    });

    it('covers a type with no registered handler with the deployment-wide lease', () => {
      // A `jobs` row can name a type this process does not register. It has no
      // profile to consult, and the claim must still carry a lease for it.
      expect(buildClaimLeases(stubConfig(), new JobHandlerRegistry(), ['gone.type'])).toEqual([
        { type: 'gone.type', leaseMs: SHIPPED_TIMEOUT_MS + LEASE_GRACE_MS },
      ]);
    });

    it('gives the server and a node the IDENTICAL lease for the same type', () => {
      // This is a property of the function, not of either caller: the reason
      // both sides agree is that there is only one derivation. Two claimers
      // with the same registry and the same config must be unable to disagree.
      const registry = registryOf(
        handler('slow.type', { maxRuntimeMs: 3_600_000, maxAttempts: 1 }),
        handler('plain.type')
      );
      const config = stubConfig();

      const asServer = buildClaimLeases(config, registry, ['slow.type', 'plain.type']);
      const asNode = buildClaimLeases(config, registry, ['slow.type', 'plain.type']);

      expect(asNode).toEqual(asServer);
      expect(asServer).toEqual([
        { type: 'slow.type', leaseMs: 3_660_000 },
        { type: 'plain.type', leaseMs: 660_000 },
      ]);
    });

    it('never produces a NaN lease, whatever the config and the profile say', () => {
      // A `NaN` here reaches Postgres as an unwritable `lease_expires_at` and
      // fails the whole claim, not just this type.
      const registry = registryOf(
        handler('bad.type', { maxRuntimeMs: Number.NaN, maxAttempts: 3 }),
        handler('plain.type')
      );

      for (const { leaseMs } of buildClaimLeases(emptyConfig, registry, [
        'bad.type',
        'plain.type',
      ])) {
        expect(Number.isFinite(leaseMs)).toBe(true);
        expect(leaseMs).toBeGreaterThan(0);
      }
    });

    it('returns [] for no eligible types, without inventing an entry', () => {
      expect(buildClaimLeases(stubConfig(), new JobHandlerRegistry(), [])).toEqual([]);
    });
  });
});
