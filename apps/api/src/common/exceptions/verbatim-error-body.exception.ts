import { HttpException } from '@nestjs/common';

/**
 * Opt-out from the shared error envelope (issue #153).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `HttpExceptionFilter` rebuilds EVERY error response from a fixed key
 * allowlist — it reads `message`, `code` and `details` off the thrown payload
 * and discards everything else. That is the right default and must stay the
 * default: one envelope, parsed by exactly one code path in the web app and one
 * in the CLI (`ApiError`, #140), with no endpoint quietly inventing its own
 * error shape for its own callers to special-case.
 *
 * It is wrong for the small set of endpoints whose error body is dictated by an
 * external specification rather than by us. `POST /auth/device/token` is the
 * live example and the reason this file exists: RFC 8628 §3.5 (deferring to
 * RFC 6749 §5.2) specifies `{ error, error_description }` at the TOP LEVEL of
 * the token response, and the codes it defines — `authorization_pending`,
 * `slow_down`, `expired_token`, `access_denied` — ARE the protocol. Each one
 * demands a different action from the polling client: keep waiting, back off,
 * restart the flow, stop and tell the user they declined. Flattened into the
 * envelope all four arrived byte-identical, the RFC code destroyed server-side
 * where no amount of client parsing could recover it, and the endpoint was
 * simply not RFC 8628 compliant.
 *
 * ---------------------------------------------------------------------------
 * WHY A BRAND, AND NOT "A PAYLOAD THAT HAPPENS TO CARRY `error`"
 * ---------------------------------------------------------------------------
 * The smaller fix considered in #153 was for the filter to sniff the payload:
 * if it has an `error` key, pass it through untouched. Fewer lines, no new
 * concepts — and implicit in exactly the way that hurts later. It would make an
 * endpoint's WIRE SHAPE a consequence of the KEY NAMES somebody happened to
 * pick inside a thrown object, decided silently and at a distance from both the
 * throw site and the filter.
 *
 * `throw new BadRequestException({ error: 'could not reach the mailer' })` is a
 * completely natural line for someone to write. Under a sniffing filter that
 * line drops its endpoint out of the envelope, the web app's error rendering
 * stops finding `message`, and nothing at the throw site hints at why. Nobody
 * would connect the failure to a decision made in an exception filter over a
 * key name.
 *
 * The brand inverts that. An error leaves the envelope only because someone
 * said so, in the throw, in one word that is greppable and links back here. An
 * ordinary exception cannot fall out of the envelope by accident no matter what
 * keys it carries, and the next person to add an RFC-shaped endpoint finds the
 * mechanism by following the brand from the filter or from the throw site.
 * The cost is one file of machinery; the thing it buys is that the default
 * cannot be broken by inattention.
 *
 * ---------------------------------------------------------------------------
 * WHEN TO USE IT
 * ---------------------------------------------------------------------------
 * Only when an external standard dictates the body. NOT to give an endpoint a
 * nicer error shape, and NOT to smuggle an extra field to a client: that field
 * belongs under `details`, which the envelope already carries through. Every
 * new use is a new shape some client has to learn, so it should be rare enough
 * that each one is argued for.
 */

/**
 * Registered via `Symbol.for` rather than a module-local `Symbol()` on purpose.
 * The brand is set in one module and read in another, and both this module and
 * the filter can be instantiated twice in a single process — ts-jest gives each
 * test file its own module registry, and a `src`/`dist` double-load does the
 * same in a mis-built container. Two module instances mean two distinct local
 * symbols, and the brand check would then silently return false: the response
 * would quietly revert to the flattened envelope and #153 would be back with no
 * error anywhere. The global symbol registry is keyed by string, so every copy
 * of this module resolves to the same symbol.
 */
const VERBATIM_ERROR_BODY = Symbol.for('EnterpriseAppBase.verbatimErrorBody');

/**
 * Mark an exception so `HttpExceptionFilter` sends its payload to the client
 * exactly as given, instead of rebuilding it as `{ statusCode, code, message,
 * … }`.
 *
 * Returns the same exception instance, so the class identity is untouched:
 * `withVerbatimErrorBody(new BadRequestException(…))` is still a
 * `BadRequestException` and still carries status 400. That matters — guards,
 * interceptors and existing tests that branch on the exception type keep
 * working, and the opt-out stays a single orthogonal fact about the response
 * body rather than a parallel exception hierarchy.
 *
 * The payload MUST be an object; a string payload has nothing to send verbatim
 * and the filter falls back to the envelope for it.
 */
export function withVerbatimErrorBody<T extends HttpException>(
  exception: T,
): T {
  Object.defineProperty(exception, VERBATIM_ERROR_BODY, {
    value: true,
    // Non-enumerable so the brand cannot leak into anything that walks the
    // exception's own properties — a log serializer, a test snapshot, an
    // error-reporting SDK. It is an instruction to the filter, not data.
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return exception;
}

/**
 * Whether an exception opted out of the envelope. Read only by
 * `HttpExceptionFilter`.
 */
export function hasVerbatimErrorBody(exception: unknown): boolean {
  return (
    exception instanceof HttpException &&
    (exception as unknown as Record<symbol, unknown>)[
      VERBATIM_ERROR_BODY
    ] === true
  );
}
