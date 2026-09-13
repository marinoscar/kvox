// =============================================================================
// The cooperative per-provider throttle gate (issue #261, epic #254)
// =============================================================================
//
// THE PROBLEM THIS SOLVES, precisely: at concurrency > 1, one 429 teaches
// exactly one worker slot that the provider is throttling us. The other slots
// know nothing, so they each go and discover it independently — sending more
// requests to a provider that has just told us to stop, collecting more 429s,
// and burning each of those jobs' rate-limit budget to learn a fact the first
// slot already knew. With eight slots that is eight round trips to be told
// the same thing eight times, and the provider sees a burst at exactly the
// moment it asked for quiet.
//
// So the discovery is SHARED. One job's 429 trips a per-provider cooldown,
// and every sibling job of the same provider waits it out before making its
// call. That is the whole service.
//
// -----------------------------------------------------------------------------
// COOPERATIVE, AND ONLY WITHIN ONE PROCESS
// -----------------------------------------------------------------------------
//
// This is an in-memory, best-effort courtesy, NOT a distributed rate limiter,
// and the distinction is deliberate rather than a shortcoming to be fixed
// later:
//
//   - It is IN-MEMORY, so a second replica has its own gate and does not see
//     this one's cooldown. That is acceptable because the gate is an
//     optimisation, not a correctness property: the thing that actually keeps
//     a throttled job from failing permanently is the deferral in
//     `JobTerminalService` (durable, in the `jobs` row, visible to every
//     replica). If the gate is wrong, some requests are wasted; if the
//     deferral were wrong, jobs would fail.
//   - REJECTED: a database- or Redis-backed shared gate. It would put a
//     network round trip in front of every job, for every provider, on every
//     tick — permanently, to improve behaviour during an outage — and it
//     would add a hard dependency (Redis) this template does not otherwise
//     have. The durable half of the mechanism is already shared through the
//     `jobs` table, because `scheduled_for` is shared state: a deferred job
//     is invisible to EVERY replica's claim query, not just this one's.
//
// -----------------------------------------------------------------------------
// MAPPING JOB TYPES TO PROVIDER KEYS IS A FORK'S JOB
// -----------------------------------------------------------------------------
//
// This framework ships no job type that talks to an external provider, so out
// of the box `resolveKey` returns `null` for everything and the gate is a
// zero-cost no-op: no map lookup result to act on, no `await`, no timer. A
// fork declares its own mapping by calling `registerProviderKey` from the
// handler's own `onModuleInit`, right beside the `registry.register(this)`
// call that makes the handler exist at all:
//
//     onModuleInit() {
//       this.registry.register(this);
//       this.throttle.registerProviderKey(this.type, 'acme-vision');
//     }
//
// SEVERAL JOB TYPES SHOULD SHARE ONE KEY when they share one quota — that is
// the entire reason the key is not just the job type. Three handlers hitting
// the same vendor account are one bucket, and mapping all three to
// `'acme-vision'` is what makes a 429 on any of them back off the other two.
// Conversely, two handlers hitting two different vendors must NOT share a
// key, or one vendor's outage silently stalls work that had nothing to do
// with it.
//
// Self-registration rather than a central table, for the same reason
// `JobHandlerRegistry` uses it: a fork adds a job type by writing one class,
// and a mapping that lives in a shared file is one more place that class has
// to reach into.
// =============================================================================

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JobClock, JOB_CLOCK, systemJobClock } from './job-clock';

/** Per-provider cooldown state. Absent from the map means "not throttled". */
interface ProviderCooldown {
  /** Epoch ms before which callers for this provider should hold off. */
  until: number;

  /**
   * How many times this provider has tripped the gate WITHOUT an intervening
   * success. Not a budget (that is per-job, in `jobs.rate_limit_hits`) — it
   * is here so logs can tell "one blip" from "this provider has been
   * throttling us for the last twenty minutes".
   */
  consecutiveTrips: number;
}

@Injectable()
export class ProviderThrottleService {
  private readonly logger = new Logger(ProviderThrottleService.name);

  private readonly clock: JobClock;

  /** `Job.type` → provider key. See the file header; empty by default. */
  private readonly providerKeys = new Map<string, string>();

  /** Provider key → cooldown. Entries are deleted, never left as zeros. */
  private readonly cooldowns = new Map<string, ProviderCooldown>();

  constructor(
    private readonly config: ConfigService,
    // OPTIONAL and unprovided in `JobsModule` — production always gets the
    // real clock, and only a test that constructs this service directly can
    // supply another. See `job-clock.ts`.
    @Optional() @Inject(JOB_CLOCK) clock?: JobClock
  ) {
    this.clock = clock ?? systemJobClock;
  }

  /**
   * Declares that jobs of `jobType` draw on the quota identified by
   * `providerKey`. Idempotent; a later call replaces an earlier one, which is
   * what lets a fork override a mapping the same way it can override a
   * handler.
   */
  registerProviderKey(jobType: string, providerKey: string): void {
    this.providerKeys.set(jobType, providerKey);
  }

  /**
   * The provider quota `jobType` draws on, or `null` when it draws on none.
   *
   * `null` is the DEFAULT and the common case — a job that writes a report,
   * resizes an image, or purges a table has no external provider to be
   * throttled by, and the gate must cost it nothing at all.
   */
  resolveKey(jobType: string): string | null {
    return this.providerKeys.get(jobType) ?? null;
  }

  /** Whether `jobType`'s provider is currently in a cooldown window. */
  isCoolingDown(jobType: string): boolean {
    return this.remainingMs(jobType) > 0;
  }

  /**
   * Milliseconds left on `jobType`'s provider cooldown; `0` when there is
   * none (including when the type has no provider at all).
   *
   * Expired entries are dropped as they are observed rather than by a sweep:
   * the map is keyed by provider, so it is bounded by the number of providers
   * a deployment talks to — single digits — and a timer to tidy a handful of
   * entries would cost more than it saves.
   */
  remainingMs(jobType: string): number {
    const key = this.resolveKey(jobType);

    if (key === null) {
      return 0;
    }

    const cooldown = this.cooldowns.get(key);

    if (!cooldown) {
      return 0;
    }

    const remaining = cooldown.until - this.clock.now();

    if (remaining <= 0) {
      this.cooldowns.delete(key);
      return 0;
    }

    return remaining;
  }

  /**
   * Waits out any cooldown on `jobType`'s provider, then returns how long it
   * actually waited (`0` when it did not wait at all).
   *
   * Call this immediately BEFORE doing the provider work, not before claiming
   * the job: waiting here holds a worker slot, and holding a slot for a job
   * that is about to run is honest, whereas holding one before deciding what
   * to run wastes it.
   *
   * ⚠ CAPPED at `JOBS_RATELIMIT_MAX_MS`. A worker slot is a scarce, finite
   * resource, and an unbounded wait here would let one provider's long
   * cooldown pin every slot in the pool — starving jobs that have nothing to
   * do with that provider, which is the exact opposite of what this gate is
   * for. Past the cap the job simply proceeds and, if the provider is still
   * throttling, takes the durable deferral instead. That is the correct place
   * for a long wait: in the row, where it costs nothing, rather than in a
   * slot.
   */
  async acquire(jobType: string): Promise<number> {
    const remaining = this.remainingMs(jobType);

    if (remaining <= 0) {
      return 0;
    }

    const waitMs = Math.min(remaining, this.maxCooldownMs());

    this.logger.debug(
      `Holding job type "${jobType}" for ${waitMs}ms: provider ` +
        `"${this.resolveKey(jobType)}" is cooling down`
    );

    await this.clock.sleep(waitMs);

    return waitMs;
  }

  /**
   * Records that `jobType`'s provider just throttled us, backing off every
   * sibling job of the same provider for `delayMs`.
   *
   * The caller supplies the delay because the caller already computed it for
   * the job's own `scheduled_for` (`JobTerminalService`), and the gate and
   * the row must not disagree about how long the provider asked for.
   *
   * EXTENDS, NEVER SHORTENS. Two jobs tripping the same provider seconds
   * apart produce two delays; taking the later of the two means a small
   * second delay cannot cut short a long first one. A provider that said
   * "come back in fifteen minutes" is not overruled by a sibling whose own
   * backoff happened to be shorter.
   *
   * A no-op for a type with no provider key.
   */
  trip(jobType: string, delayMs: number): void {
    const key = this.resolveKey(jobType);

    if (key === null) {
      return;
    }

    const existing = this.cooldowns.get(key);
    const until = Math.max(existing?.until ?? 0, this.clock.now() + Math.max(0, delayMs));
    const consecutiveTrips = (existing?.consecutiveTrips ?? 0) + 1;

    this.cooldowns.set(key, { until, consecutiveTrips });

    this.logger.warn(
      `Provider "${key}" throttled (trip ${consecutiveTrips} in a row); ` +
        `holding job types mapped to it for ${Math.max(0, until - this.clock.now())}ms`
    );
  }

  /**
   * Records that `jobType`'s provider just served a request successfully,
   * clearing any cooldown on it.
   *
   * CLEARING ON SUCCESS IS THE POINT. A trip sets a worst-case wait based on
   * what we knew at the moment of the 429; a success is direct evidence that
   * the limit has lifted, and it is strictly more recent information. Without
   * this, a fifteen-minute cooldown set by one unlucky job would keep
   * throttling siblings for fifteen minutes after the provider recovered.
   *
   * Deleting the entry also resets `consecutiveTrips`, which is what makes
   * that counter mean "in a row".
   */
  recordSuccess(jobType: string): void {
    const key = this.resolveKey(jobType);

    if (key === null) {
      return;
    }

    if (this.cooldowns.delete(key)) {
      this.logger.debug(`Provider "${key}" served a request; cooldown cleared`);
    }
  }

  /** `JOBS_RATELIMIT_MAX_MS` — see `acquire` for what it caps and why. */
  private maxCooldownMs(): number {
    return this.config.get<number>('jobs.rateLimitMaxMs') ?? 900_000;
  }
}
