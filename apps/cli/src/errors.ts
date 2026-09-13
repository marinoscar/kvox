import { CLI_NAME } from './branding.js';

// =============================================================================
// CLI error model and exit codes  (issue #140, epic #110)
// =============================================================================
//
// Two things have to come out of a failed request, and they are not the same
// thing:
//
//   - A MESSAGE a person can act on. `403 Forbidden` tells you nothing; the
//     server already computed the useful sentence ("Missing permission
//     users:read") and put it in the body, so throwing it away and printing
//     the status text is the single most common way a CLI becomes useless.
//
//   - An EXIT CODE a script can branch on. `set -e` and every CI runner on
//     earth look at nothing else. A CLI that prints a red error and exits 0
//     turns a broken deploy into a green pipeline, and nobody finds out until
//     much later.
//
// The distinction this file is built around is REACHED THE SERVER vs DID NOT.
// "The server said no" (ApiError) and "I could not reach the server"
// (NetworkError) need different words and different exit codes: the first
// means fix your request or your permissions, the second means fix your URL,
// your VPN, or the fact that the API is down. Collapsing them into one
// "request failed" is what sends people debugging their credentials when the
// real problem is a typo'd hostname.
// =============================================================================

/**
 * Process exit codes.
 *
 * Small integers, deliberately: values 126, 127 and 128+n are claimed by the
 * shell (not executable / not found / killed by signal n), so a CLI that picks
 * its own codes up there produces output a script cannot tell apart from the
 * shell's own failures. Everything here stays well below that.
 *
 * These are a PUBLIC CONTRACT the moment someone writes `if [ $? -eq 4 ]`.
 * Add new codes; do not renumber existing ones.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** Anything unclassified — a bug in this CLI, most likely. */
  FAILURE: 1,
  /** The invocation itself was wrong: unknown command, missing argument. */
  USAGE: 2,
  /** The server was reached and answered with a non-2xx status. */
  API: 3,
  /** The server was never reached: DNS, refused, TLS, timeout. */
  NETWORK: 4,
  /**
   * 401 specifically — no credential, or one that expired or was revoked.
   *
   * Split out from API because it is the one failure with a known remedy that
   * a script can automate: re-run `login`. 403 deliberately stays API — a
   * permission the account does not have is not fixed by logging in again,
   * and telling someone to re-authenticate when their role is the problem
   * sends them round a loop.
   */
  AUTH: 5,
  /**
   * A prerequisite is not met, so nothing was attempted (#178, epic #168).
   *
   * SPLIT OUT FROM FAILURE because it is the one a script can act on:
   * `appctl deploy doctor || provision-the-box` is the intended shape, and
   * "this server is not ready" has to be distinguishable from "appctl itself
   * broke". Additive, like every code above it - never renumber.
   */
  PRECONDITION: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Base for every error this CLI raises on purpose.
 *
 * The `exitCode` lives on the error rather than in a switch at the top level
 * so that a new error type cannot be added without deciding what it does to
 * the process — the compiler asks the question.
 */
export abstract class CliError extends Error {
  abstract readonly exitCode: ExitCode;

  constructor(message: string, options?: ErrorOptions) {
    // `cause` is passed through so a future `--verbose` can unwind the real
    // underlying error. It must never be printed by default: an undici cause
    // can carry the full request, headers included, and this CLI's requests
    // carry a bearer token.
    super(message, options);
    // `new.target` is the SUBCLASS being constructed, so every error reports
    // its own name without each one repeating `this.name = 'ApiError'`. The
    // built-in default would say `Error` for all of them, which turns an
    // `err.name` check in a caller into a silent no-op.
    this.name = new.target.name;
  }
}

/** The invocation was malformed. Exists so #144 can reject a bad method/path. */
export class UsageError extends CliError {
  readonly exitCode = EXIT.USAGE;
}

/**
 * There is no credential to use, so the request was never attempted (#143).
 *
 * EXIT.AUTH, the same code a 401 produces, ON PURPOSE: from a script's point
 * of view "the stored token was revoked" and "there was never a stored token"
 * have the identical remedy — run `login` — and a script that branches on the
 * exit code should not have to know which of the two happened. What must
 * differ is the MESSAGE, and that is the whole reason this class exists: the
 * naive implementation sends `Authorization: Bearer undefined`, gets a 401,
 * and tells the user their credentials were rejected. They were not; there
 * were none. That misdirection sends people to revoke and re-issue tokens
 * that were never the problem.
 */
export class AuthRequiredError extends CliError {
  readonly exitCode = EXIT.AUTH;

  constructor(message = `Not logged in. Run \`${CLI_NAME} login\` first.`) {
    super(message);
  }
}

/**
 * A required prerequisite failed, so the command did not proceed (#178).
 *
 * The message names what failed; the remedy belongs to the check that
 * produced it and is rendered beside it, not folded in here.
 */
export class PreconditionError extends CliError {
  readonly exitCode = EXIT.PRECONDITION;
}

/**
 * The config file exists but cannot be used (#143).
 *
 * NOT EXIT.AUTH: "your config is corrupt" is not fixed by logging in against
 * whatever server the corrupt file names, and a script retrying `login` on
 * an AUTH code would loop. FAILURE is honest — something is wrong that the
 * CLI cannot resolve on its own — and the message always names the path so
 * the fix (delete it, or fix the JSON) needs no further investigation.
 */
export class ConfigError extends CliError {
  readonly exitCode = EXIT.FAILURE;
}

/** Everything the server may have told us about a failed request. */
export interface ApiErrorFields {
  /** HTTP status. 0 is never used here — that is NetworkError's territory. */
  readonly status: number;
  /** The server's own sentence, already extracted from the body. */
  readonly serverMessage: string;
  /** `code` from the API error envelope, e.g. `FORBIDDEN`. */
  readonly code: string | undefined;
  /** `details` from the envelope. Absent in production — see below. */
  readonly details: unknown;
  /** Request method, for the message. */
  readonly method: string;
  /** Request URL, for the message. Never contains the token. */
  readonly url: string;
  /**
   * True when the body parsed as the API's documented error envelope. False
   * means the message below was salvaged from something else — an nginx error
   * page, an empty body, a proxy's HTML.
   */
  readonly structured: boolean;
  /**
   * The response body EXACTLY as it arrived, before this module distilled a
   * message out of it. OPTIONAL, so adding it did not change the shape every
   * existing caller of this constructor already passes.
   *
   * WHY KEEP IT, given that `serverMessage`, `code` and `details` are meant to
   * BE the useful distillation: because a caller can need a field this module
   * deliberately does not model. The concrete case is #142's RFC 8628 polling.
   * `POST /api/auth/device/token` signals four COMPLETELY DIFFERENT outcomes —
   * keep waiting, back off, the code expired, the user pressed Deny — in an
   * `error` field that is neither `message` nor `code` nor `details`. So
   * `extractServerMessage` throws it away, and the client is left unable to
   * tell "still waiting" from "denied". Rather than teach this generic error
   * model one endpoint's vocabulary, the raw body is kept and the device-flow
   * classifier reads it.
   *
   * SAFE TO KEEP, NOT SAFE TO PRINT. It is an ERROR body, so it can never
   * contain an issued token — a credential only ever appears in a 2xx — but it
   * CAN carry a stack trace when the API runs with NODE_ENV !== 'production'
   * (see the filter's `details` handling). `formatError` prints `message` and
   * nothing else; nothing else should either.
   */
  // `| undefined` alongside the `?` is required by this package's
  // `exactOptionalPropertyTypes`: without it, the field could be omitted but
  // not explicitly passed as undefined, and the class below — which must
  // declare it as `string | undefined` to implement the interface — would not
  // satisfy it.
  readonly rawBody?: string | undefined;
}

/**
 * The server responded, and the response was not a success.
 *
 * `message` is built as `<status>: <server message>` so that the default
 * `console.error(err.message)` at the top level is already the useful line.
 */
export class ApiError extends CliError implements ApiErrorFields {
  readonly status: number;
  readonly serverMessage: string;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly method: string;
  readonly url: string;
  readonly structured: boolean;
  readonly rawBody: string | undefined;

  constructor(fields: ApiErrorFields) {
    super(`${fields.status}: ${fields.serverMessage}`);
    this.status = fields.status;
    this.serverMessage = fields.serverMessage;
    this.code = fields.code;
    this.details = fields.details;
    this.method = fields.method;
    this.url = fields.url;
    this.structured = fields.structured;
    this.rawBody = fields.rawBody;
  }

  get exitCode(): ExitCode {
    return this.status === 401 ? EXIT.AUTH : EXIT.API;
  }

  /**
   * Build an ApiError from a raw response body.
   *
   * TAKES THE BODY AS TEXT, NOT AS A RESPONSE TO `.json()`. That is the whole
   * defence against the failure this issue calls out: calling `response.json()`
   * on an nginx 502 page throws `SyntaxError: Unexpected token '<'`, which
   * escapes as a completely unrelated error and buries the fact that the
   * gateway is down. The caller reads `.text()` (which cannot throw on
   * content) and hands the string here, so a non-JSON body is a case we handle
   * rather than an exception we suffer.
   */
  static fromBody(args: {
    status: number;
    statusText: string;
    rawBody: string;
    method: string;
    url: string;
  }): ApiError {
    const extracted = extractServerMessage(args.rawBody, args.status, args.statusText);
    return new ApiError({
      status: args.status,
      serverMessage: extracted.message,
      code: extracted.code,
      details: extracted.details,
      method: args.method,
      url: args.url,
      structured: extracted.structured,
      rawBody: args.rawBody,
    });
  }
}

/** How the connection failed, in the terms a user can act on. */
export type NetworkFailureKind =
  | 'dns'
  | 'refused'
  | 'reset'
  | 'tls'
  | 'timeout'
  | 'aborted'
  | 'unknown';

/**
 * The request never produced a response.
 *
 * Carries no status, because there is none — that absence is the point, and it
 * is why this is a separate class rather than an ApiError with `status: 0`. A
 * `status: 0` sentinel invites `if (err.status >= 500)` to quietly do the
 * wrong thing.
 */
export class NetworkError extends CliError {
  readonly exitCode = EXIT.NETWORK;
  readonly kind: NetworkFailureKind;
  readonly method: string;
  readonly url: string;

  constructor(fields: {
    kind: NetworkFailureKind;
    method: string;
    url: string;
    message: string;
    cause?: unknown;
  }) {
    super(fields.message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.kind = fields.kind;
    this.method = fields.method;
    this.url = fields.url;
  }

  /**
   * Classify whatever `fetch` threw.
   *
   * Node's `fetch` rejects with a flat `TypeError: fetch failed` for every
   * transport problem — DNS, refused, TLS, reset are all the same two words —
   * and puts the real diagnosis in `.cause.code`. Printing the TypeError alone
   * gives the user nothing; reading the cause turns it into "no such host" vs
   * "connection refused", which are different problems with different fixes.
   */
  static fromCause(args: {
    cause: unknown;
    method: string;
    url: string;
    timeoutMs: number;
    /** True when the caller's own AbortSignal fired, not our timeout. */
    callerAborted: boolean;
  }): NetworkError {
    const { cause, method, url } = args;
    const origin = safeOrigin(url);

    if (isAbortLike(cause)) {
      // A timeout and a Ctrl-C look identical at this level (both surface as
      // an AbortError), so the caller tells us which signal fired. Reporting a
      // deliberate cancellation as "the server timed out" would send someone
      // looking for a server problem that does not exist.
      return args.callerAborted
        ? new NetworkError({ kind: 'aborted', method, url, message: 'Request cancelled.', cause })
        : new NetworkError({
            kind: 'timeout',
            method,
            url,
            message: `Timed out after ${args.timeoutMs}ms waiting for ${origin}. The server may be slow, unreachable, or behind a proxy that is not responding.`,
            cause,
          });
    }

    const code = errorCode(cause);

    switch (code) {
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return new NetworkError({
          kind: 'dns',
          method,
          url,
          message: `Could not resolve ${origin}. Check the server URL${code === 'EAI_AGAIN' ? ' and your DNS/network connection' : ''}.`,
          cause,
        });
      case 'ECONNREFUSED':
        return new NetworkError({
          kind: 'refused',
          method,
          url,
          message: `Connection refused by ${origin}. Nothing is listening on that host and port — is the server running?`,
          cause,
        });
      case 'ECONNRESET':
      case 'EPIPE':
        return new NetworkError({
          kind: 'reset',
          method,
          url,
          message: `Connection to ${origin} was reset before a response arrived.`,
          cause,
        });
      case 'ETIMEDOUT':
        return new NetworkError({
          kind: 'timeout',
          method,
          url,
          message: `Connection to ${origin} timed out.`,
          cause,
        });
      default:
        break;
    }

    // TLS failures are their own family and their own fix (a self-signed cert
    // on a dev box, a clock that is wrong, a missing CA). undici surfaces them
    // with codes that vary by OpenSSL version, so match the family by prefix
    // rather than enumerating values that will be wrong on the next release.
    if (code && (code.startsWith('ERR_TLS') || code.startsWith('UNABLE_TO_') || code.startsWith('DEPTH_ZERO') || code.startsWith('SELF_SIGNED') || code.startsWith('CERT_'))) {
      return new NetworkError({
        kind: 'tls',
        method,
        url,
        message: `TLS handshake with ${origin} failed (${code}). If this is a development server with a self-signed certificate, use http:// or install its CA.`,
        cause,
      });
    }

    // No recognisable code. This is not a dead end — Node's own message is
    // often the whole diagnosis ("bad port" for a port on the blocked list,
    // for instance, which has no code at all), and a bare "could not reach"
    // would throw away the only sentence that explains why.
    const detail = code ?? causeSummary(cause);
    return new NetworkError({
      kind: 'unknown',
      method,
      url,
      message: `Could not reach ${origin}${detail ? ` (${detail})` : ''}.`,
      cause,
    });
  }
}

/**
 * Map any thrown value to an exit code.
 *
 * The `unknown` parameter is honest rather than defensive: JavaScript lets any
 * value be thrown, and the top-level handler runs after user-supplied config,
 * JSON parsing and third-party code have all had a turn.
 */
export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof CliError) return error.exitCode;
  return EXIT.FAILURE;
}

/**
 * The one line printed to stderr when a command fails.
 *
 * Prefixed with the binary name because this output usually arrives in the
 * middle of a CI log next to a dozen other tools' output, and an unattributed
 * "403: ..." belongs to nobody.
 *
 * NO STACK TRACE. A stack is noise for the person who mistyped a URL, and the
 * `cause` chain behind a fetch failure can contain request details. #144 can
 * add a `--verbose` that opts into it.
 */
export function formatError(error: unknown): string {
  if (error instanceof CliError) return `${CLI_NAME}: ${error.message}`;
  if (error instanceof Error) return `${CLI_NAME}: ${error.message}`;
  return `${CLI_NAME}: ${String(error)}`;
}

// -----------------------------------------------------------------------------
// Body extraction
// -----------------------------------------------------------------------------

interface ExtractedError {
  message: string;
  code: string | undefined;
  details: unknown;
  structured: boolean;
}

/**
 * How much of an unparseable body to show. Long enough for an nginx page to
 * name itself ("502 Bad Gateway ... nginx/1.25"), short enough that a stray
 * 40KB HTML error page does not scroll the real command's output off screen.
 */
const SNIPPET_LIMIT = 200;

/**
 * Pull a usable sentence out of an error body, whatever shape it turns out to
 * have.
 *
 * The happy path is the API's own envelope from
 * apps/api/src/common/filters/http-exception.filter.ts:
 *
 *     { statusCode, code, message, details?, timestamp, path }
 *
 * with two documented wrinkles:
 *
 *   - `details` is ABSENT IN PRODUCTION for unhandled errors (the filter only
 *     attaches a stack when NODE_ENV !== 'production'), so nothing here may
 *     depend on it being present.
 *
 *   - `message` is NOT ALWAYS A STRING. The filter copies it straight out of
 *     the HttpException response, and a validation failure (ValidationPipe /
 *     nestjs-zod) puts an ARRAY of messages there. Rendering that with string
 *     concatenation yields `400: [object Object]`, which is the exact failure
 *     mode this issue exists to prevent.
 *
 * Everything else — an HTML proxy page, an empty body, a JSON array, a plain
 * string — falls back to a snippet, never to a throw.
 */
export function extractServerMessage(
  rawBody: string,
  status: number,
  statusText: string,
): ExtractedError {
  const trimmed = rawBody.trim();
  const fallbackMessage = statusText.trim() || `HTTP ${status}`;

  if (trimmed.length === 0) {
    return {
      message: `${fallbackMessage} (the server sent no response body).`,
      code: undefined,
      details: undefined,
      structured: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON at all. Overwhelmingly this is a reverse proxy or load balancer
    // answering instead of the API, which means the useful information is the
    // page's own text and NOT anything about our request.
    return {
      message: `${fallbackMessage} — the server did not return JSON: ${snippet(trimmed)}`,
      code: undefined,
      details: undefined,
      structured: false,
    };
  }

  // A JSON string body (`"Something went wrong"`) is rare but legal, and the
  // string is exactly the message we want.
  if (typeof parsed === 'string' && parsed.trim().length > 0) {
    return { message: parsed.trim(), code: undefined, details: undefined, structured: false };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      message: `${fallbackMessage} — unexpected error body: ${snippet(trimmed)}`,
      code: undefined,
      details: undefined,
      structured: false,
    };
  }

  const body = parsed as Record<string, unknown>;
  const message = normaliseMessage(body.message);
  const code = typeof body.code === 'string' ? body.code : undefined;

  if (message === undefined) {
    // JSON object, but not our envelope — some other service's error shape.
    // Keep whatever `code` it had (it may still be meaningful) and show the
    // body, because guessing at its message field would be worse than showing
    // it verbatim.
    return {
      message: `${fallbackMessage} — unexpected error body: ${snippet(trimmed)}`,
      code,
      details: undefined,
      structured: false,
    };
  }

  return { message, code, details: body.details, structured: true };
}

/**
 * Accept the two `message` shapes the API can actually produce, reject the
 * rest. Arrays are joined with `; ` rather than newlines so the error stays a
 * single grep-able line in a CI log.
 */
function normaliseMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return parts.length > 0 ? parts.join('; ') : undefined;
  }

  return undefined;
}

/**
 * Collapse a body into one short readable line.
 *
 * The tag strip is FOR DISPLAY ONLY and is not, and must never be relied on
 * as, sanitisation — its whole job is that `<html><head><title>502 Bad
 * Gateway</title></head>` reads as `502 Bad Gateway` in a terminal instead of
 * as forty characters of markup before the first real word.
 */
function snippet(body: string): string {
  const looksLikeHtml = /^\s*<(?:!doctype|html|head|body)/i.test(body);
  const stripped = looksLikeHtml ? body.replace(/<[^>]*>/g, ' ') : body;
  const collapsed = stripped.replace(/\s+/g, ' ').trim();

  if (collapsed.length === 0) return '(unreadable body)';
  return collapsed.length > SNIPPET_LIMIT
    ? `${collapsed.slice(0, SNIPPET_LIMIT)}…`
    : collapsed;
}

// -----------------------------------------------------------------------------
// Cause inspection helpers
// -----------------------------------------------------------------------------

/**
 * Walk the `cause` chain looking for a syscall/OpenSSL error code.
 *
 * The chain matters: undici wraps the socket error, so the `code` is one or
 * two levels down from what `fetch` rejects with. The depth cap stops a
 * self-referential cause chain (which a badly-behaved library can construct)
 * from spinning here forever.
 */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;

    // A dual-stack host (plain `localhost` resolves to both ::1 and 127.0.0.1)
    // makes undici try every address and reject with an AggregateError. Node
    // normally copies the shared code onto the aggregate, but when the
    // attempts failed for DIFFERENT reasons it cannot, and the codes only
    // exist on the children — so descend into the first one rather than
    // reporting "unknown" for the most ordinary failure there is.
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const nested = errorCode(errors[0]);
      if (nested !== undefined) return nested;
    }

    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The first non-empty message in the cause chain, for the case where no code
 * was found.
 *
 * Safe to show: these are Node/undici transport messages ("connect
 * ECONNREFUSED 127.0.0.1:45999", "bad port"), which carry a host and port and
 * nothing else. An AggregateError's own message is empty, hence the skip.
 */
function causeSummary(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') {
      const trimmed = message.trim();
      // 'fetch failed' is undici's placeholder for every transport error and
      // says nothing; keep walking past it.
      if (trimmed.length > 0 && trimmed !== 'fetch failed') return trimmed;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isAbortLike(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR';
}

/**
 * `https://host:3535` from a full request URL, for error messages.
 *
 * Only the origin, deliberately: a URL can carry query parameters, and this
 * CLI will eventually put things like a device code in them. An error message
 * ends up in scrollback, in screenshots and in bug reports, so it gets the
 * host and nothing else. Falls back to the raw string if the URL is so
 * malformed it will not parse — which is itself worth showing the user.
 */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
