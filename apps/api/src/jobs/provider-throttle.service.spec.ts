// =============================================================================
// Unit tests for the provider throttle gate (issue #261, epic #254)
// =============================================================================
//
// TIME IS FAKED TWO WAYS HERE, on purpose.
//
// Most cases inject a fake `JobClock`, which makes "now" an integer this file
// controls and turns each cooldown assertion into an exact number. But an
// injected clock cannot prove that the SHIPPED clock actually waits — a fake
// whose `sleep` resolves immediately would pass every one of those cases even
// if `acquire` never awaited anything. So the last block runs the real
// `systemJobClock` under jest's fake timers and asserts that `acquire`
// genuinely does not resolve until the timers advance.
// =============================================================================

import { ConfigService } from '@nestjs/config';

import { JobClock } from './job-clock';
import { ProviderThrottleService } from './provider-throttle.service';

const NOW = 1_700_000_000_000;

/** A clock this file drives by hand. `sleep` advances it, as a real one would. */
function fakeClock(start = NOW) {
  let current = start;
  const slept: number[] = [];

  const clock: JobClock & {
    slept: number[];
    advance(ms: number): void;
  } = {
    now: () => current,
    sleep: async (ms: number) => {
      slept.push(ms);
      current += ms;
    },
    slept,
    advance: (ms: number) => {
      current += ms;
    },
  };

  return clock;
}

const config = (values: Record<string, unknown> = {}) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('ProviderThrottleService', () => {
  let clock: ReturnType<typeof fakeClock>;
  let service: ProviderThrottleService;

  beforeEach(() => {
    clock = fakeClock();
    service = new ProviderThrottleService(config({ 'jobs.rateLimitMaxMs': 900_000 }), clock);
  });

  describe('a job type with no provider — the zero-cost no-op', () => {
    it('resolves to no key, so nothing is throttled and nothing waits', async () => {
      // This is the DEFAULT for every type this framework ships: no external
      // provider, so the gate must cost nothing at all.
      expect(service.resolveKey('report.build')).toBeNull();
      expect(service.isCoolingDown('report.build')).toBe(false);

      service.trip('report.build', 60_000);

      expect(service.isCoolingDown('report.build')).toBe(false);
      await expect(service.acquire('report.build')).resolves.toBe(0);
      expect(clock.slept).toEqual([]);
    });

    it('recordSuccess on an unmapped type is a no-op', () => {
      expect(() => service.recordSuccess('report.build')).not.toThrow();
    });
  });

  describe('sibling back-off', () => {
    beforeEach(() => {
      // Two types sharing ONE quota, and a third on a different vendor. The
      // shared key is the entire reason the gate is not keyed by job type.
      service.registerProviderKey('vision.describe', 'acme-vision');
      service.registerProviderKey('vision.tag', 'acme-vision');
      service.registerProviderKey('speech.transcribe', 'other-vendor');
    });

    it('delays a sibling job of the same provider', async () => {
      service.trip('vision.describe', 30_000);

      expect(service.isCoolingDown('vision.tag')).toBe(true);

      // The sibling waits out the remainder rather than discovering the 429
      // for itself.
      await expect(service.acquire('vision.tag')).resolves.toBe(30_000);
      expect(clock.slept).toEqual([30_000]);
    });

    it('does NOT delay a job of an unrelated provider', async () => {
      service.trip('vision.describe', 30_000);

      expect(service.isCoolingDown('speech.transcribe')).toBe(false);
      await expect(service.acquire('speech.transcribe')).resolves.toBe(0);
      expect(clock.slept).toEqual([]);
    });

    it('waits only the REMAINING cooldown, not the whole of it', async () => {
      service.trip('vision.describe', 30_000);
      clock.advance(20_000);

      await expect(service.acquire('vision.tag')).resolves.toBe(10_000);
    });

    it('stops delaying once the cooldown elapses', async () => {
      service.trip('vision.describe', 30_000);
      clock.advance(30_001);

      expect(service.isCoolingDown('vision.tag')).toBe(false);
      await expect(service.acquire('vision.tag')).resolves.toBe(0);
    });
  });

  describe('trip', () => {
    beforeEach(() => {
      service.registerProviderKey('vision.describe', 'acme-vision');
      service.registerProviderKey('vision.tag', 'acme-vision');
    });

    it('extends a cooldown but never shortens one', async () => {
      service.trip('vision.describe', 300_000);
      service.trip('vision.tag', 5_000);

      // A sibling's short backoff must not cut short a provider's long one.
      await expect(service.acquire('vision.tag')).resolves.toBe(300_000);
    });

    it('extends when the newer delay is longer', async () => {
      service.trip('vision.describe', 5_000);
      service.trip('vision.tag', 300_000);

      await expect(service.acquire('vision.describe')).resolves.toBe(300_000);
    });

    it('treats a negative delay as zero rather than as time travel', () => {
      service.trip('vision.describe', -60_000);

      expect(service.isCoolingDown('vision.describe')).toBe(false);
    });
  });

  describe('recordSuccess', () => {
    beforeEach(() => {
      service.registerProviderKey('vision.describe', 'acme-vision');
      service.registerProviderKey('vision.tag', 'acme-vision');
    });

    it('clears the cooldown for every sibling — a success is newer evidence', async () => {
      service.trip('vision.describe', 900_000);
      expect(service.isCoolingDown('vision.tag')).toBe(true);

      service.recordSuccess('vision.describe');

      expect(service.isCoolingDown('vision.tag')).toBe(false);
      await expect(service.acquire('vision.tag')).resolves.toBe(0);
    });
  });

  describe('the acquire cap', () => {
    it('never holds a worker slot longer than JOBS_RATELIMIT_MAX_MS', async () => {
      const capped = new ProviderThrottleService(
        config({ 'jobs.rateLimitMaxMs': 10_000 }),
        clock
      );

      capped.registerProviderKey('vision.describe', 'acme-vision');
      // A provider asking for an hour must not pin the slot for an hour; the
      // long wait belongs in `scheduled_for`, not in a slot.
      capped.trip('vision.describe', 3_600_000);

      await expect(capped.acquire('vision.describe')).resolves.toBe(10_000);
    });

    it('falls back to the shipped default when the setting is missing', async () => {
      const defaulted = new ProviderThrottleService(config({}), clock);

      defaulted.registerProviderKey('vision.describe', 'acme-vision');
      defaulted.trip('vision.describe', 3_600_000);

      await expect(defaulted.acquire('vision.describe')).resolves.toBe(900_000);
    });
  });

  describe('registerProviderKey', () => {
    it('lets a later registration override an earlier one', () => {
      service.registerProviderKey('vision.describe', 'acme-vision');
      service.registerProviderKey('vision.describe', 'replacement-vendor');

      expect(service.resolveKey('vision.describe')).toBe('replacement-vendor');
    });
  });

  describe('with the REAL clock, under fake timers', () => {
    // Proves the thing an injected clock cannot: that `acquire` actually
    // suspends. A `sleep` that resolved immediately would satisfy every case
    // above.
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not resolve until the cooldown has really elapsed', async () => {
      const real = new ProviderThrottleService(config({ 'jobs.rateLimitMaxMs': 900_000 }));

      real.registerProviderKey('vision.describe', 'acme-vision');
      real.registerProviderKey('vision.tag', 'acme-vision');
      real.trip('vision.describe', 30_000);

      let resolved = false;
      const pending = real.acquire('vision.tag').then((waited) => {
        resolved = true;
        return waited;
      });

      await jest.advanceTimersByTimeAsync(29_000);
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe(30_000);
      expect(resolved).toBe(true);
    });

    it('returns immediately when there is no cooldown', async () => {
      const real = new ProviderThrottleService(config({}));

      real.registerProviderKey('vision.describe', 'acme-vision');

      await expect(real.acquire('vision.describe')).resolves.toBe(0);
    });
  });
});
