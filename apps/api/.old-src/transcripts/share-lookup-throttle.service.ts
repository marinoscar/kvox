// =============================================================================
// ShareLookupThrottleService (issue #29, epic #19, spec §6.3)
// =============================================================================
//
// ⚠ THERE IS NO RATE-LIMITING PRECEDENT IN THIS REPOSITORY TO REUSE, and this
// file is the note explaining what was checked before writing a new one.
// `@nestjs/throttler` is not a dependency; Helmet and the CORS policy are the
// only request-level middleware; and the three things that *look* like rate
// limiters are all about something else:
//
//   • `jobs/provider-throttle.service.ts` shares ONE outbound bucket across a
//     worker pool so a vendor is not hammered — it gates calls this process
//     MAKES, not calls it RECEIVES, and it delays rather than refuses.
//   • `jobs/rate-limit.error.ts` / `job-terminal.service.ts` classify a 429 a
//     PROVIDER returned to us and defer the job.
//   • The device-authorization poll interval is a hint in a response body, not
//     an enforced limit.
//
// So this is deliberately the simplest correct thing, and its limits are
// stated rather than implied.
//
// -----------------------------------------------------------------------------
// WHY THE SHARE LOOKUP NEEDS ONE AT ALL
// -----------------------------------------------------------------------------
//
// `POST /api/transcripts/:id/shares` is an EMAIL ORACLE. It answers "is there
// an active account at this address?" — a generic 404 when there is not, a
// created share when there is. That is exactly the shape of an account
// enumerator, and the generic message is only half the defence: identical
// wording does not stop somebody working through a list of ten thousand
// addresses and reading the STATUS CODE. Bounding the rate is the other half,
// and §6.3 names it explicitly.
//
// -----------------------------------------------------------------------------
// PER OWNER, NOT PER IP, AND THE COUNTER ONLY MOVES ON A MISS
// -----------------------------------------------------------------------------
//
// The bucket is keyed on the AUTHENTICATED CALLER, because that is who the
// oracle answers to: an attacker behind a thousand addresses is still one
// account, and an office behind one NAT is many. Every request here has been
// through `JwtAuthGuard`, so the key always exists.
//
// And a SUCCESSFUL share does not spend budget. Sharing a transcript with
// eight colleagues in a row is the feature working; it is the run of misses
// that is the enumeration. Charging only failures means the limit is invisible
// to every honest user and immediate for the attack it exists to stop.
//
// -----------------------------------------------------------------------------
// ⚠ IN-PROCESS, WHICH IS A REAL LIMIT AND NOT A HIDDEN ONE
// -----------------------------------------------------------------------------
//
// The window lives in this process's memory, so N replicas behind a load
// balancer permit N times the budget and a restart forgets everything. That is
// an acceptable trade for a control whose job is to turn "ten thousand
// addresses in a minute" into "ten thousand addresses in a week", and it is
// the honest shape for a codebase with no shared cache: a Postgres-backed
// counter would put a write on the hot path of every failed lookup, and a
// Redis-backed one would add infrastructure this deployment does not have.
// If a shared limiter is ever wanted, this service is the seam to replace —
// nothing outside it knows how the counting is done.
// =============================================================================

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/** Failed lookups one account may make inside {@link WINDOW_MS}. */
export const SHARE_LOOKUP_MAX_MISSES = 10;

/** How long the miss counter is remembered. */
export const WINDOW_MS = 10 * 60 * 1000;

/** Never let the map grow without bound if something pathological happens. */
const MAX_TRACKED_ACCOUNTS = 10_000;

/** The message a throttled caller gets. Says what to do, not what was counted. */
export const SHARE_LOOKUP_THROTTLED_MESSAGE =
  'Too many share attempts for addresses with no account. Please wait a few minutes and try again.';

interface Window {
  misses: number;
  /** When this window was opened; it expires {@link WINDOW_MS} after. */
  startedAt: number;
}

@Injectable()
export class ShareLookupThrottleService {
  private readonly windows = new Map<string, Window>();

  /**
   * Throw `429` if this account has already burned its budget of misses.
   *
   * Called BEFORE the lookup, so a throttled caller never reaches the query at
   * all — a limiter that ran afterwards would still answer the question it
   * exists to stop being asked.
   */
  assertAllowed(userId: string, now = Date.now()): void {
    const window = this.current(userId, now);

    if (window && window.misses >= SHARE_LOOKUP_MAX_MISSES) {
      const retryAfterMs = window.startedAt + WINDOW_MS - now;

      throw new HttpException(
        {
          // No `code` key: `HttpExceptionFilter` derives `code` from the
          // status (429 -> `TOO_MANY_REQUESTS`) and deliberately ignores one
          // on the payload, so supplying it would be dead weight.
          message: SHARE_LOOKUP_THROTTLED_MESSAGE,
          details: { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Charge one miss.
   *
   * ⚠ THE WINDOW IS FIXED, NOT SLIDING: it starts at the first miss and is
   * forgotten whole. A sliding window would need the timestamp of every miss,
   * and the difference between the two — an attacker regaining the full budget
   * at a boundary instead of gradually — does not matter for a control whose
   * purpose is to make bulk enumeration take weeks.
   */
  recordMiss(userId: string, now = Date.now()): void {
    const window = this.current(userId, now);

    if (window) {
      window.misses += 1;

      return;
    }

    if (this.windows.size >= MAX_TRACKED_ACCOUNTS) this.evictExpired(now);

    this.windows.set(userId, { misses: 1, startedAt: now });
  }

  /** Forget this account's misses. Exists for tests and for a future reset path. */
  reset(userId: string): void {
    this.windows.delete(userId);
  }

  /** The live window for this account, dropping it if it has expired. */
  private current(userId: string, now: number): Window | undefined {
    const window = this.windows.get(userId);

    if (!window) return undefined;

    if (now - window.startedAt >= WINDOW_MS) {
      this.windows.delete(userId);

      return undefined;
    }

    return window;
  }

  /** Drop every expired window; if none are, drop the oldest to make room. */
  private evictExpired(now: number): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;

    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= WINDOW_MS) {
        this.windows.delete(key);

        continue;
      }

      if (window.startedAt < oldestAt) {
        oldestAt = window.startedAt;
        oldestKey = key;
      }
    }

    if (this.windows.size >= MAX_TRACKED_ACCOUNTS && oldestKey) {
      this.windows.delete(oldestKey);
    }
  }
}
