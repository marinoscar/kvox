import type { ApiClient } from './api-client.js';
import { CLI_NAME } from './branding.js';
import { ApiError, CliError, EXIT, type ExitCode } from './errors.js';

// =============================================================================
// RFC 8628 device-authorization polling  (issue #142, epic #110)
// =============================================================================
//
// This module is the state machine and NOTHING ELSE: no prompting, no browser,
// no terminal output, no config writing. It takes an ApiClient and a device
// code and returns a credential or throws a classified failure. That
// separation is what lets #145's ink TUI drive the identical flow — and it is
// what lets every outcome below be tested without a socket, a clock, or a
// terminal.
//
// -----------------------------------------------------------------------------
// WHY THE FOUR OUTCOMES ARE NOT ONE "login failed"
// -----------------------------------------------------------------------------
// RFC 8628 §3.5 defines the poll response as a set of distinct errors, and
// they map to four DIFFERENT THINGS THE USER MUST DO:
//
//   authorization_pending  do nothing. This is the normal case and it is the
//                          overwhelming majority of every poll response in a
//                          successful login. Reporting it as a failure makes
//                          the command unusable.
//   slow_down              WE must poll less often. Ignoring it is not a
//                          cosmetic bug: the server is rate-limiting, and a
//                          client that keeps hammering at the old interval can
//                          be throttled or blocked outright — so the fix is to
//                          WIDEN the interval, not to retry sooner.
//   expired_token          the code timed out. Run `login` again. Silently
//                          restarting the flow here would be wrong: a new code
//                          means a new user code, and the one on the user's
//                          screen would stop working with no explanation.
//   access_denied          the user pressed Deny. Say so and STOP. Retrying
//                          re-prompts a person who just said no.
//
// And a fifth, which the RFC does not cover because it is below the protocol:
// a NETWORK FAILURE. A dropped WiFi connection during the wait must not read
// as "you denied the request". NetworkError from the api-client already
// carries that distinction; this module simply must not swallow it.
// -----------------------------------------------------------------------------
// ⚠ KNOWN SERVER-SIDE DEFECT — READ BEFORE CHANGING `classifyPollFailure`
// -----------------------------------------------------------------------------
// As of this writing the API DOES NOT PUT THESE CODES ON THE WIRE.
// `DeviceAuthService.pollForToken` throws
// `BadRequestException({ error, error_description })`, but the global
// `HttpExceptionFilter` (apps/api/src/common/filters/http-exception.filter.ts)
// only copies `message`, `code` and `details` out of an exception's response
// body. `{ error, error_description }` has no `message`, so the filter falls
// through to its default and every one of the four outcomes reaches a client
// as the byte-identical:
//
//     { "statusCode": 400, "code": "BAD_REQUEST",
//       "message": "An unexpected error occurred", ... }
//
// The RFC code is destroyed by the server before it is ever sent. No client
// can distinguish the four, and no amount of parsing on this side recovers
// information that was discarded upstream. That is an API bug, it needs its
// own issue, and it must be fixed for #142's success criterion 3 to hold.
//
// The classifier below is written against the CORRECT wire format so it starts
// working the moment the filter preserves `error` — and `UNCLASSIFIED_*`
// documents exactly what the CLI does in the meantime, and what it costs.
// =============================================================================

/** The RFC 8628 §3.5 error codes this client acts on. */
export const DEVICE_POLL_ERROR_CODES = [
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
  // Not in the "pending" family: RFC 6749 §5.2. This API raises it (as a 401)
  // for an unknown device code and for one that has already been redeemed.
  'invalid_grant',
] as const;

export type DevicePollErrorCode = (typeof DEVICE_POLL_ERROR_CODES)[number];

/** What one poll meant. Exhaustive on purpose — see `pollOnce`'s switch. */
export type DevicePollSignal =
  | { kind: 'approved'; credential: DeviceCredential }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'invalid_grant'; message: string }
  /** A response this client could not map to any RFC code. See the block above. */
  | { kind: 'unclassified'; status: number; message: string };

/** `POST /api/auth/device/code`, unwrapped from the response envelope. */
export interface DeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Lifetime of the code pair, seconds. */
  expiresIn: number;
  /** Minimum seconds between polls, per the server. HONOUR THIS. */
  interval: number;
}

/**
 * The credential a successful poll returns.
 *
 * Mirrors `DeviceTokenResponseDto`. The PAT-only fields are optional here for
 * the same reason they are optional there: the session branch does not send
 * them, and `credentialType` — present and equal to `'pat'`, absent otherwise
 * — is the documented discriminator. Branching on `refreshToken === undefined`
 * instead would be an accidental signal, as that DTO's own comment explains.
 */
export interface DeviceCredential {
  accessToken: string;
  /** Always `'Bearer'`, for both credential kinds. How to present, not what. */
  tokenType: string;
  expiresIn: number;
  credentialType: 'pat' | undefined;
  /** Absolute ISO-8601 expiry. PAT only — and the field #143 persists. */
  expiresAt: string | undefined;
  tokenId: string | undefined;
  tokenName: string | undefined;
}

/** Why a device login ended without a credential. */
export type DeviceLoginFailureReason =
  | 'denied'
  | 'expired'
  | 'invalid_grant'
  | 'cancelled'
  | 'unclassified';

/**
 * A device login that ended without a credential, carrying WHICH of the
 * distinct outcomes it was.
 *
 * The `reason` is on the error rather than only in the message so the TUI
 * (#145) can render four different screens from the same thrown value that
 * the plain command turns into four different sentences. A caller that
 * pattern-matches on message text would break the first time the wording is
 * improved.
 *
 * THE EXIT CODES SPLIT ON WHETHER RETRYING IS SANE, which is the distinction
 * errors.ts draws for EXIT.AUTH ("the one failure a script can automate: run
 * login again"):
 *   - `expired` and `cancelled` → AUTH. Re-running the flow is exactly right;
 *     nothing was decided, the clock just ran out.
 *   - `denied` → API. A human said no. A script that retries on this is
 *     re-prompting someone who already refused, and that is harassment by
 *     automation, not resilience.
 *   - `invalid_grant` / `unclassified` → API. The server refused or answered
 *     something we do not understand; a retry loop would not help.
 */
export class DeviceLoginError extends CliError {
  readonly reason: DeviceLoginFailureReason;

  constructor(reason: DeviceLoginFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }

  get exitCode(): ExitCode {
    return this.reason === 'expired' || this.reason === 'cancelled' ? EXIT.AUTH : EXIT.API;
  }
}

// -----------------------------------------------------------------------------
// Tuning
// -----------------------------------------------------------------------------

/**
 * Seconds added to the interval on every `slow_down`.
 *
 * Five, because RFC 8628 §3.5 says five: "the client MUST increase the
 * interval by 5 seconds". Additive, not exponential — the server has already
 * told us the right order of magnitude via `interval`, so backing off
 * geometrically would overshoot into "the code expires while we are asleep".
 */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

/**
 * Ceiling on the interval.
 *
 * A server that answers `slow_down` unconditionally — a misconfigured rate
 * limiter, a shared cache key — would otherwise widen the interval without
 * bound until the device code expires during a single sleep, and the user
 * would watch a code that is already dead. Capping means we keep polling often
 * enough to observe the approval, and the deadline check ends the flow with
 * the honest "expired" message rather than a hang.
 */
export const MAX_POLL_INTERVAL_SECONDS = 60;

/**
 * Padding added to every sleep, milliseconds.
 *
 * NOT superstition. This API's rate limiter (`DeviceAuthService.pollForToken`)
 * compares `now - lastPoll < pollInterval * 1000` — a STRICT less-than against
 * the SAME configured value it advertises as `interval`. A client that sleeps
 * exactly `interval` therefore sits precisely on the boundary, and any
 * rounding in `setTimeout`, any scheduler jitter, or a timer that fires a
 * millisecond early lands on the wrong side of it and earns a `slow_down` on
 * every single poll. We would then widen the interval repeatedly for a
 * condition that was our own timing, not the server's load. A quarter of a
 * second is invisible to a human waiting on a browser approval and puts us
 * unambiguously past the comparison.
 */
export const POLL_MARGIN_MS = 250;

/**
 * How an unclassifiable 4xx from the poll endpoint is treated.
 *
 * `'pending'`, and it is a WORKAROUND for the server defect documented at the
 * top of this file, not a design choice. Stated plainly, with its cost:
 *
 *   - Choosing `'fatal'` would be the honest reading of an unknown response,
 *     and against the current API it makes `login` impossible: every poll
 *     before approval is an unclassifiable 400, so the command would die
 *     one interval into a flow that was working perfectly.
 *   - Choosing `'pending'` keeps login functional end to end today (epic #110
 *     success criterion 1) and degrades ONLY the outcomes we cannot see: with
 *     the filter as it stands, a denial and an expiry are indistinguishable
 *     from waiting, so both surface as the local deadline elapsing — "the code
 *     expired, run login again" — instead of "you denied it". That is a wrong
 *     message on two paths, versus a broken command on all of them.
 *
 * The exposure is BOUNDED, which is what makes it acceptable at all: the loop
 * stops at the device code's own `expiresIn` regardless, so the worst case is
 * a wait of the code's lifetime, not a hang. `onUnclassified` fires once so
 * the user is told the CLI is flying blind rather than silently guessing.
 *
 * DELETE THIS AND SET IT FATAL once the API preserves `error` — the classifier
 * needs no other change.
 */
export const UNCLASSIFIED_POLL_POLICY: 'pending' | 'fatal' = 'pending';

// -----------------------------------------------------------------------------
// Requesting a code
// -----------------------------------------------------------------------------

/**
 * `POST /api/auth/device/code`.
 *
 * `tokenType: 'pat'` is the whole reason #141 exists. Without it the server
 * defaults to `'session'` and mints a JWT that expires in minutes — a CLI that
 * re-authenticates every quarter of an hour is not a CLI anybody uses. With
 * it, approval issues a personal access token that is long-lived AND revocable
 * from the web UI's Access Tokens page, which is the property that makes a
 * long-lived credential acceptable in the first place.
 *
 * The endpoint is `@Public()`, so no token is sent — correct, since acquiring
 * one is the point.
 */
export async function requestDeviceCode(
  client: ApiClient,
  options: { deviceName: string; userAgent?: string | undefined; signal?: AbortSignal | undefined },
): Promise<DeviceCodeGrant> {
  const grant = await client.post<DeviceCodeGrant>(
    '/auth/device/code',
    {
      clientInfo: {
        deviceName: options.deviceName,
        ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
        tokenType: 'pat',
      },
    },
    options.signal === undefined ? undefined : { signal: options.signal },
  );

  if (
    grant === null ||
    typeof grant !== 'object' ||
    typeof grant.deviceCode !== 'string' ||
    typeof grant.userCode !== 'string'
  ) {
    // A 2xx with the wrong shape means we are not talking to this API — a
    // captive portal, a stale reverse proxy, the wrong host. Saying so beats
    // the alternative, which is polling forever with `deviceCode: undefined`.
    throw new DeviceLoginError(
      'unclassified',
      'The server accepted the device-code request but did not return a device code. Check that the server URL points at this application.',
    );
  }

  return grant;
}

// -----------------------------------------------------------------------------
// The state machine
// -----------------------------------------------------------------------------

/** Progress reports for a UI. Purely informational; never affects control flow. */
export type DevicePollState =
  | { kind: 'polling'; attempt: number; intervalSeconds: number; secondsRemaining: number }
  | { kind: 'slow_down'; intervalSeconds: number }
  | { kind: 'approved' };

export interface PollForTokenOptions {
  client: ApiClient;
  deviceCode: string;
  /** The server's advertised minimum. Honoured, not overridden. */
  intervalSeconds: number;
  /** The code's lifetime in seconds, used as a local deadline. */
  expiresInSeconds: number;
  /** Cancellation (Ctrl-C, a TUI unmount). */
  signal?: AbortSignal | undefined;
  /** Live state for a spinner or a TUI. */
  onState?: ((state: DevicePollState) => void) | undefined;
  /** Called at most once, when a response could not be classified. */
  onUnclassified?: ((signal: Extract<DevicePollSignal, { kind: 'unclassified' }>) => void) | undefined;
  /** Injected for tests, so the suite does not sleep through real intervals. */
  sleep?: ((ms: number, signal?: AbortSignal | undefined) => Promise<void>) | undefined;
  /** Injected for tests. */
  now?: (() => number) | undefined;
}

/**
 * Poll until the device is approved, or until one of the terminal outcomes.
 *
 * Returns the credential. Throws DeviceLoginError for a protocol outcome, or
 * lets NetworkError through untouched — a connection that dropped mid-wait is
 * a different problem from a refusal, and flattening the two is exactly what
 * #142 forbids.
 */
export async function pollForDeviceToken(options: PollForTokenOptions): Promise<DeviceCredential> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const onState = options.onState;

  // Clamped rather than trusted. A server that advertises `interval: 0` (a
  // misconfigured DEVICE_CODE_POLL_INTERVAL, an integer parsed from an empty
  // env var) would otherwise produce a tight loop that hammers a public
  // endpoint as fast as the event loop allows — a self-inflicted denial of
  // service that also guarantees a `slow_down` on every request.
  let intervalSeconds = clampInterval(options.intervalSeconds);

  // The LOCAL deadline, taken from the server's own `expiresIn`. It exists
  // because the authoritative expiry signal (`expired_token`) may never
  // arrive: the connection can be gone, or — today — the code can be
  // unrecoverable from the response body. Without it the loop is unbounded,
  // and an unbounded wait in CI burns the whole job budget.
  const deadline = now() + options.expiresInSeconds * 1000;

  let attempt = 0;
  let warnedUnclassified = false;

  for (;;) {
    throwIfCancelled(options.signal);

    if (now() >= deadline) {
      throw expiredError();
    }

    attempt += 1;
    onState?.({
      kind: 'polling',
      attempt,
      intervalSeconds,
      secondsRemaining: Math.max(0, Math.ceil((deadline - now()) / 1000)),
    });

    const signal = await pollOnce(options.client, options.deviceCode, options.signal);

    switch (signal.kind) {
      case 'approved':
        onState?.({ kind: 'approved' });
        return signal.credential;

      case 'pending':
        break;

      case 'slow_down':
        // The RFC's remedy, applied before the sleep so the widened interval
        // takes effect immediately. Note we do NOT also retry sooner or reset
        // the attempt counter: the server asked for less traffic, and the only
        // correct response is less traffic.
        intervalSeconds = clampInterval(intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS);
        onState?.({ kind: 'slow_down', intervalSeconds });
        break;

      case 'denied':
        throw new DeviceLoginError(
          'denied',
          `Authorization was denied in the browser. Nothing was saved. Run \`${CLI_NAME} login\` again if that was not what you intended.`,
        );

      case 'expired':
        throw expiredError();

      case 'invalid_grant':
        throw new DeviceLoginError(
          'invalid_grant',
          `The server rejected this device code (${signal.message}). It may already have been used. Run \`${CLI_NAME} login\` to start again.`,
        );

      case 'unclassified': {
        if (UNCLASSIFIED_POLL_POLICY === 'fatal') {
          throw new DeviceLoginError(
            'unclassified',
            `The server returned ${signal.status} without a recognisable device-authorization status (${signal.message}).`,
          );
        }
        // Warn ONCE. Repeating it every interval would bury the user code and
        // the verification URL — the two things they still need to read — under
        // a scrolling wall of the same sentence.
        if (!warnedUnclassified) {
          warnedUnclassified = true;
          options.onUnclassified?.(signal);
        }
        break;
      }
    }

    // Bounded by the deadline so the last sleep cannot overrun it by an
    // interval and turn a live code into an expired one while we wait.
    const remaining = deadline - now();
    if (remaining <= 0) throw expiredError();
    await sleep(Math.min(intervalSeconds * 1000 + POLL_MARGIN_MS, remaining), options.signal);
  }
}

/**
 * One poll. Every response — success or failure — becomes a DevicePollSignal;
 * only a NetworkError escapes, and it escapes on purpose.
 */
export async function pollOnce(
  client: ApiClient,
  deviceCode: string,
  signal?: AbortSignal | undefined,
): Promise<DevicePollSignal> {
  try {
    const body = await client.post<DeviceCredential>(
      '/auth/device/token',
      { deviceCode },
      signal === undefined ? undefined : { signal },
    );

    if (body === null || typeof body !== 'object' || typeof body.accessToken !== 'string') {
      return {
        kind: 'unclassified',
        status: 200,
        message: 'the server reported success but returned no access token',
      };
    }

    return { kind: 'approved', credential: body };
  } catch (error) {
    // NOT caught: NetworkError. It propagates so the caller can say "the
    // connection dropped" rather than inventing a protocol outcome for it —
    // the fifth distinct case in the list at the top of this file.
    if (!(error instanceof ApiError)) throw error;
    return classifyPollFailure(error);
  }
}

/**
 * Map a failed poll response to an RFC 8628 outcome.
 *
 * Exported because it is the piece worth testing exhaustively, and pure so it
 * can be: no clock, no client, no I/O.
 *
 * FOUR SOURCES ARE CHECKED, in decreasing order of authority, because the code
 * can survive in different places depending on how the server is built:
 *
 *   1. `error` in the raw body — the RFC-correct location, and where this API
 *      puts it before its exception filter drops it (see the block at the top
 *      of this file). Checked first so the classifier is already correct on the
 *      day the API is fixed, with no further change here.
 *   2. `error_description` in the raw body — same object, some frameworks emit
 *      only the description.
 *   3. `code` in the parsed envelope — where a fix might reasonably land,
 *      since that field already survives the filter.
 *   4. The server's message text — last resort, and matched as a WHOLE WORD.
 *      A substring match would be actively dangerous here: `access_denied`
 *      contains neither of the others, but a generic sentence mentioning
 *      "authorization pending, or denied" must not be read as a denial.
 *
 * Anything else is `unclassified` and is NOT guessed at. Guessing "probably
 * pending" inside the classifier would hide the ambiguity from the caller and
 * from its tests; the caller decides what to do with an unknown, in one
 * documented place.
 */
export function classifyPollFailure(error: ApiError): DevicePollSignal {
  const found =
    codeFromRawBody(error.rawBody) ??
    matchErrorCode(error.code) ??
    matchErrorCodeInText(error.serverMessage);

  switch (found) {
    case 'authorization_pending':
      return { kind: 'pending' };
    case 'slow_down':
      return { kind: 'slow_down' };
    case 'expired_token':
      return { kind: 'expired' };
    case 'access_denied':
      return { kind: 'denied' };
    case 'invalid_grant':
      return { kind: 'invalid_grant', message: error.serverMessage };
    default:
      return { kind: 'unclassified', status: error.status, message: error.serverMessage };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Read `error` / `error_description` straight out of the untouched body. */
function codeFromRawBody(rawBody: string | undefined): DevicePollErrorCode | undefined {
  if (rawBody === undefined || rawBody.trim().length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // An HTML proxy page. Not our protocol; leave it to the caller's fallback.
    return undefined;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const body = parsed as Record<string, unknown>;

  return (
    matchErrorCode(body.error) ??
    matchErrorCode(body.error_description) ??
    matchErrorCodeInText(body.error_description)
  );
}

/** Exact match against the known codes. */
function matchErrorCode(value: unknown): DevicePollErrorCode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalised = value.trim().toLowerCase();
  return (DEVICE_POLL_ERROR_CODES as readonly string[]).includes(normalised)
    ? (normalised as DevicePollErrorCode)
    : undefined;
}

/**
 * Whole-word search for a code inside a sentence.
 *
 * `\b` on both sides, so `expired_token_handler` is not read as
 * `expired_token`. At most ONE code may match: a message mentioning two is
 * ambiguous, and picking the first would be an arbitrary choice between
 * outcomes that have opposite consequences (keep waiting vs. stop and tell the
 * user they were denied). Ambiguous returns undefined and the caller reports
 * an unclassified response, which is the truth.
 */
function matchErrorCodeInText(value: unknown): DevicePollErrorCode | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.toLowerCase();
  const hits = DEVICE_POLL_ERROR_CODES.filter((code) =>
    new RegExp(`\\b${code}\\b`).test(text),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.min(Math.ceil(seconds), MAX_POLL_INTERVAL_SECONDS);
}

function expiredError(): DeviceLoginError {
  return new DeviceLoginError(
    'expired',
    `The device code expired before it was approved. Run \`${CLI_NAME} login\` to get a new code.`,
  );
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DeviceLoginError('cancelled', 'Login cancelled.');
  }
}

/**
 * Sleep that a cancellation can interrupt.
 *
 * The listener is removed in every exit path. A poll loop that runs for the
 * full 15-minute code lifetime adds a listener per interval, and AbortSignal
 * warns (then leaks) past ten — so an un-removed listener here is a real leak
 * on the one path that runs longest, not a theoretical one.
 */
function defaultSleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DeviceLoginError('cancelled', 'Login cancelled.'));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DeviceLoginError('cancelled', 'Login cancelled.'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
