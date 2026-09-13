// =============================================================================
// Rate-limit classification (issue #261, epic #254)
// =============================================================================
//
// THE QUEUE HAS TWO GENUINELY DIFFERENT KINDS OF FAILURE, and this file is
// how it tells them apart.
//
//   - A BUG (a null dereference, a malformed payload, a permission error)
//     should burn through a small attempt budget quickly and land in `failed`
//     where a human can see it. Retrying it is nearly free and nearly
//     pointless; retrying it fifty times is spam.
//   - A PROVIDER RATE LIMIT is not a failure of the work at all. Nothing is
//     wrong with the job, the payload, or the code; we simply asked too often.
//     It should back off for MINUTES, and it must NOT consume the attempt
//     budget — otherwise a long backfill against a throttling provider
//     exhausts three attempts in the first minute and fails permanently for a
//     reason that was never its fault.
//
// The whole rest of the terminal path depends on getting that discrimination
// right, so it lives in one testable place rather than inline in a `catch`.
//
// -----------------------------------------------------------------------------
// TWO WAYS IN, ON PURPOSE
// -----------------------------------------------------------------------------
//
// `RateLimitError` is for a handler that KNOWS: it read the provider's
// response itself and can say so explicitly, with the exact `retryAfterMs`
// the provider named. `classifyRateLimit` is for everything else — an error
// object thrown by an SDK that has its own shape and no idea this queue
// exists. Handlers should not have to wrap every SDK, and SDK errors should
// not have to be pre-classified, so both work.
//
// A remote worker node is a THIRD way in and deliberately does NOT live here:
// it cannot throw a typed error across HTTP, so it reports the same
// conclusion as flags (`{ rateLimited: true, retryAfterMs }`) and
// `JobTerminalService.completeFailed` gives those flags the identical
// treatment. See that file for the classification ORDER.
// =============================================================================

/**
 * Thrown by a handler that has positively identified a provider rate limit.
 *
 * Carries the provider's own `Retry-After` when there was one; the deferral
 * treats it as a FLOOR on the computed backoff, never as an override (see
 * `backoff.util.ts`).
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'RateLimitError';

    // ⚠ REQUIRED, NOT CEREMONIAL. Extending a built-in (`Error`) breaks
    // `instanceof` when the class is downlevelled: the emitted constructor
    // calls `Error.call(this)`, which returns a fresh `Error` and leaves
    // `this`'s prototype chain pointing at `Error.prototype` rather than
    // `RateLimitError.prototype`. The symptom is the worst possible one for
    // this file — `err instanceof RateLimitError` quietly returns `false`,
    // every provider throttle is classified as an ordinary bug, and long
    // backfills fail permanently on a transient condition. Restoring the
    // prototype explicitly makes the check work under every target.
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/** What `classifyRateLimit` concluded about an arbitrary thrown value. */
export interface RateLimitClassification {
  /** Whether this error means "back off", as opposed to "this is broken". */
  rateLimited: boolean;

  /**
   * The provider's requested delay in milliseconds, when it named one.
   * `null` means "no opinion" — the caller uses pure backoff.
   */
  retryAfterMs: number | null;
}

const NOT_RATE_LIMITED: RateLimitClassification = { rateLimited: false, retryAfterMs: null };

/**
 * HTTP statuses that mean "you are being throttled".
 *
 *   429 — Too Many Requests. The unambiguous one.
 *   503 — Service Unavailable. Overload. Retrying immediately makes it worse;
 *         it is a capacity signal, not a defect in the request, so it belongs
 *         on the back-off-and-do-not-charge-an-attempt path.
 *   529 — a non-standard "overloaded" status several API providers return in
 *         preference to 503. Same meaning, same treatment.
 *
 * DELIBERATELY NOT HERE: 500 and 502. They are genuine faults rather than
 * capacity signals, and treating them as rate limits would let a permanently
 * broken provider hold jobs in deferral against the (much larger) rate-limit
 * budget instead of failing them where somebody notices.
 */
const RATE_LIMIT_STATUSES = new Set([429, 503, 529]);

/**
 * Provider error NAMES that mean throttling with no HTTP status attached.
 *
 * AWS SDK clients frequently surface a throttle as a named error whose status
 * is 400 — so a status-only classifier reads "client error, this request is
 * malformed, fail it permanently" for what is really "slow down". These names
 * are the documented retryable-throttling set shared across AWS services;
 * matching them is what keeps an S3 `SlowDown` or a DynamoDB
 * `ProvisionedThroughputExceededException` on the deferral path.
 *
 * Compared case-insensitively, because SDKs are inconsistent about whether
 * the name arrives on `name`, `code`, or `__type` (which is often
 * fully-qualified, e.g. `com.amazonaws...#ThrottlingException`).
 */
const THROTTLE_ERROR_NAMES = new Set(
  [
    'ThrottlingException',
    'Throttling',
    'ThrottledException',
    'RequestThrottled',
    'RequestThrottledException',
    'TooManyRequestsException',
    'RequestLimitExceeded',
    'SlowDown',
    'PriorRequestNotComplete',
    'EC2ThrottledException',
    'TransactionInProgressException',
    'ProvisionedThroughputExceededException',
    'LimitExceededException',
    'BandwidthLimitExceeded',
  ].map((name) => name.toLowerCase())
);

/** Every place a status code is realistically found on a thrown provider error. */
function readStatus(err: Record<string, unknown>): number | null {
  const response = err.response as Record<string, unknown> | undefined;
  const metadata = err.$metadata as Record<string, unknown> | undefined;

  const candidates = [
    err.status,
    err.statusCode,
    response?.status,
    response?.statusCode,
    metadata?.httpStatusCode,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Every place a throttle NAME is realistically found. */
function readNames(err: Record<string, unknown>): string[] {
  const names: string[] = [];

  for (const key of ['name', 'code', '__type', 'errorType'] as const) {
    const value = err[key];

    if (typeof value === 'string' && value.length > 0) {
      // `__type` is often `com.amazonaws.dynamodb#ThrottlingException`;
      // take the last path-ish segment as well as the whole string.
      const tail = value.split(/[#/.:]/).pop();

      names.push(value.toLowerCase());

      if (tail && tail !== value) {
        names.push(tail.toLowerCase());
      }
    }
  }

  return names;
}

/** Reads `retry-after` out of whatever header container the SDK used. */
function readRetryAfterHeader(err: Record<string, unknown>): string | null {
  const response = err.response as Record<string, unknown> | undefined;

  const containers = [
    err.headers,
    response?.headers,
    (err.$response as Record<string, unknown> | undefined)?.headers,
  ];

  for (const container of containers) {
    if (!container) {
      continue;
    }

    // A `fetch` Headers instance: case-insensitive `get`.
    const getter = (container as { get?: unknown }).get;

    if (typeof getter === 'function') {
      const value = (getter as (name: string) => unknown).call(container, 'retry-after');

      if (typeof value === 'string') {
        return value;
      }

      continue;
    }

    // A plain object. Node lowercases incoming header names; other clients do
    // not, so match case-insensitively rather than guessing.
    for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
      if (key.toLowerCase() === 'retry-after' && (typeof value === 'string' || typeof value === 'number')) {
        return String(value);
      }
    }
  }

  return null;
}

/**
 * Parses an HTTP `Retry-After` header value into milliseconds.
 *
 * RFC 9110 allows exactly two forms and this accepts both, because providers
 * genuinely use both:
 *
 *   - `Retry-After: 120`      — delta-seconds → 120000
 *   - `Retry-After: Wed, 21 Oct 2015 07:28:00 GMT` — an HTTP-date, converted
 *     to a delay RELATIVE TO `now` (which is a parameter so tests can pin it,
 *     and so a caller that already has a clock does not disagree with this
 *     function about what time it is).
 *
 * Returns `null` for absent, empty, unparseable, or nonsensical input —
 * INCLUDING a date already in the past, which is not an error but does not
 * describe a wait. `null` means "no opinion", and the caller falls back to
 * pure backoff; it never means zero, because a provider that said nothing
 * must not be read as a provider that said "retry immediately".
 *
 * A negative delta-seconds is also `null` for the same reason. A fractional
 * value (`0.5`) is rejected too: the grammar is DIGIT-only, so a fractional
 * value means the header is not what we think it is, and guessing at a
 * malformed header is how a 500ms wait gets read as a 500-second one.
 */
export function parseRetryAfterMs(
  header: string | number | null | undefined,
  now: number = Date.now()
): number | null {
  if (header === null || header === undefined) {
    return null;
  }

  const raw = String(header).trim();

  if (raw.length === 0) {
    return null;
  }

  // Form 1: delta-seconds. Anchored and digit-only, deliberately — `parseInt`
  // would happily read `30 minutes` as 30 and `1e3` as 1.
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);

    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  // Form 2: HTTP-date.
  const timestamp = Date.parse(raw);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  const delta = timestamp - now;

  // A date at or before `now` describes no wait at all. See the doc comment:
  // that is "no opinion", not "zero".
  return delta > 0 ? delta : null;
}

/**
 * Decides whether an arbitrary thrown value is a provider rate limit, and
 * extracts any `Retry-After` it carried.
 *
 * TOTAL AND NEVER THROWS. It is called from inside a failure path, on a value
 * that is `unknown` by construction (anything can be thrown in JavaScript),
 * so anything it does not positively recognise — a string, `null`, a plain
 * `Error`, an SDK shape nobody anticipated — is simply "not a rate limit".
 * The cost of a false negative is one wasted attempt; the cost of throwing
 * here would be losing the failure handling entirely.
 */
export function classifyRateLimit(
  err: unknown,
  now: number = Date.now()
): RateLimitClassification {
  // The explicit signal always wins, and carries its own delay.
  if (err instanceof RateLimitError) {
    return { rateLimited: true, retryAfterMs: err.retryAfterMs ?? null };
  }

  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) {
    return NOT_RATE_LIMITED;
  }

  const candidate = err as Record<string, unknown>;

  // ⚠ THE try/catch IS WHAT MAKES THE "NEVER THROWS" PROMISE TRUE, and it is
  // not theoretical: every read below touches a property on an object that
  // came from somewhere else, and a property can be a GETTER. Several SDKs
  // and proxy/mock libraries define lazily-computed or deliberately
  // exploding accessors, and an exception raised while classifying a failure
  // would escape the failure handler itself — losing the retry, the
  // deferral, and the `lastError` for a job whose only real problem was that
  // something upstream threw an unusual object. Degrading to "not a rate
  // limit" costs at most one attempt.
  try {
    const status = readStatus(candidate);
    const byStatus = status !== null && RATE_LIMIT_STATUSES.has(status);

    const byName = readNames(candidate).some((name) => THROTTLE_ERROR_NAMES.has(name));

    if (!byStatus && !byName) {
      return NOT_RATE_LIMITED;
    }

    return {
      rateLimited: true,
      retryAfterMs: parseRetryAfterMs(readRetryAfterHeader(candidate), now),
    };
  } catch {
    return NOT_RATE_LIMITED;
  }
}
