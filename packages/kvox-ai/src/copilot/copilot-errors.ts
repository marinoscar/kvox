import { AiError, type AiErrorCode } from '@marinoscar/platform-ai-providers';

// =============================================================================
// GitHub Copilot failures as platform `AiError`s, and the token redaction (#581)
// =============================================================================
//
// The Copilot runtime reports a failure three ways, and each becomes ONE
// `AiError` here, so `createKvoxAi` classifies Copilot exactly like every other
// provider (`toKvoxAiError` reads the code):
//
//   session.error        { errorType, statusCode?, errorCode?, message }
//   model.call_failure   { errorType?, statusCode?, errorCode?, errorMessage? }
//                        (the SDK's own retries are suppressed: see the adapter)
//   a thrown value       createSession / send / listModels rejecting
//
// THE TABLE (first match wins):
//
//   rate_limit | quota | status 429           AI_RATE_LIMITED (retryAfterMs when a numeric hint is present)
//   authentication | authorization | 401/403  AI_KEY_INVALID
//   a content-filter type                     AI_CONTENT_FILTERED
//   context_limit | status 413                AI_INVALID_REQUEST
//   any other 400 / 422                       AI_INVALID_REQUEST
//   anything else                             AI_PROVIDER_UNAVAILABLE
//
//   thrown: our own AiError passes through; "not authenticated" is
//   AI_KEY_REQUIRED (sign in); anything else AI_PROVIDER_UNAVAILABLE.
//
//   sign-in (#630): a sign-in that expired, was cancelled or did not finish is
//   AI_KEY_REQUIRED (the user is still not signed in) and carries
//   `details.signInReason` (`sign_in_expired`, `sign_in_cancelled`, ...), so a
//   host switches on that, not on the text. (`details.reason` is the platform's
//   own and always equals the code, so it cannot carry this.)
//
// ⚠ NOTHING SECRET LEAVES. Every message is `redactTokens`-ed and capped at 300
// characters; `details` carries only `errorType`, `statusCode` and `errorCode`
// (redacted). The runtime's own message is the only free text kept, because it
// is what an operator needs, and it never carries the prompt.
// ⚠ A LOCAL REDACTION, not the `errors` slice's `scrub`: the `copilot` slice
// depends on no other slice (packages/kvox-slices.json), and its shapes are a
// superset (`Bearer` credentials too).
// =============================================================================

/**
 * The sentence of a Copilot call made while no GitHub account is signed in
 * (`AI_KEY_REQUIRED`).
 *
 * @stability experimental
 */
export const COPILOT_SIGN_IN_MESSAGE = 'Sign in to GitHub Copilot to use it in KVox.';

/**
 * The `details.signInReason` of a Copilot sign-in that did not end signed in. The
 * strings are permanent: a host switches on them.
 *
 * @stability experimental
 */
export type CopilotSignInFailureReason =
  | 'sign_in_expired'
  | 'sign_in_cancelled'
  | 'sign_in_failed'
  | 'sign_in_not_started'
  | 'sign_in_needs_plaintext_consent'
  | 'sign_in_needs_account_selection'
  | 'sign_in_needs_input';

/** The longest runtime message an error carries. */
const MESSAGE_LIMIT = 300;

/** Strings shaped like a credential: GitHub tokens, PATs, `sk-` keys and Bearer values. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[opusr]_[A-Za-z0-9_]+/g,
  /\bgithub_pat_[A-Za-z0-9_]+/g,
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

/**
 * Replaces every credential-shaped run in a text with `[redacted]`: GitHub
 * tokens (`gho_`, `ghp_`, `ghu_`, `ghs_`, `ghr_`), fine-grained PATs
 * (`github_pat_`), `sk-` keys and `Bearer` values.
 *
 * @example
 * ```ts
 * redactTokens('auth failed for gho_abc123'); // 'auth failed for [redacted]'
 * ```
 *
 * @param text - any text about to leave the adapter (an error message, a log field).
 * @returns the text, redacted.
 * @stability experimental
 */
export function redactTokens(text: string): string {
  return TOKEN_SHAPES.reduce((out, pattern) => out.replace(pattern, '[redacted]'), text);
}

/**
 * A Copilot runtime failure, as `session.error` and `model.call_failure` carry
 * it (every field optional: the two events differ).
 *
 * @stability experimental
 */
export interface CopilotErrorData {
  /** The failure's category (`rate_limit`, `quota`, `authentication`, `context_limit`, ...). */
  errorType?: string;
  /** The upstream HTTP status, when there was one. */
  statusCode?: number;
  /** The upstream's own fine-grained code. */
  errorCode?: string;
  /** The runtime's message (`session.error`). */
  message?: string;
  /** The runtime's message (`model.call_failure`). */
  errorMessage?: string;
  /** A retry hint in seconds, if a later runtime release reports one (1.0.22 does not). */
  retryAfterSeconds?: number;
  /** A retry hint in milliseconds, if a later runtime release reports one (1.0.22 does not). */
  retryAfterMs?: number;
}

/**
 * Maps a Copilot runtime failure (`session.error`, `model.call_failure`) to the
 * platform `AiError` of the table in this file's header.
 *
 * @param data - the event's payload.
 * @returns the error, its message redacted and capped.
 * @stability experimental
 */
export function copilotErrorFromData(data: CopilotErrorData): AiError {
  const type = typeof data.errorType === 'string' ? data.errorType.toLowerCase() : '';
  const status = typeof data.statusCode === 'number' ? data.statusCode : undefined;

  let code: AiErrorCode;
  if (type === 'rate_limit' || type === 'quota' || status === 429) code = 'AI_RATE_LIMITED';
  else if (type === 'authentication' || type === 'authorization' || status === 401 || status === 403) code = 'AI_KEY_INVALID';
  else if (/content[_ -]?filter/.test(type)) code = 'AI_CONTENT_FILTERED';
  else if (type === 'context_limit' || status === 413) code = 'AI_INVALID_REQUEST';
  else if (status === 400 || status === 422) code = 'AI_INVALID_REQUEST';
  else code = 'AI_PROVIDER_UNAVAILABLE';

  const retryAfterMs =
    code !== 'AI_RATE_LIMITED'
      ? undefined
      : isNonNegative(data.retryAfterMs)
        ? data.retryAfterMs
        : isNonNegative(data.retryAfterSeconds)
          ? data.retryAfterSeconds * 1000
          : undefined;

  const text = data.message ?? data.errorMessage ?? 'the request failed';
  return new AiError(code, copilotMessage(text), {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    details: safeDetails(data),
  });
}

/**
 * Maps a value the transport threw (`createSession`, `send`, `listModels`
 * rejecting) to a platform `AiError`.
 *
 * @remarks
 * An `AiError` passes through (the adapter's own refusals, the transport's
 * "SDK not installed"). A message saying the user is not authenticated is
 * `AI_KEY_REQUIRED` with {@link COPILOT_SIGN_IN_MESSAGE}; anything else is
 * `AI_PROVIDER_UNAVAILABLE` with the redacted, capped message.
 *
 * @param err - anything caught.
 * @returns the error.
 * @stability experimental
 */
export function copilotErrorFromThrown(err: unknown): AiError {
  if (AiError.isAiError(err)) return err;
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : typeof (err as { message?: unknown } | null)?.message === 'string'
          ? (err as { message: string }).message
          : 'the request failed';
  if (/not\s+authenticated/i.test(raw)) {
    return new AiError('AI_KEY_REQUIRED', COPILOT_SIGN_IN_MESSAGE);
  }
  return new AiError('AI_PROVIDER_UNAVAILABLE', copilotMessage(raw));
}

/**
 * The error of a sign-in whose time ran out before the user finished in the browser.
 *
 * @returns `AI_KEY_REQUIRED` with `details.signInReason` `sign_in_expired`.
 * @stability experimental
 */
export function copilotSignInExpired(): AiError {
  return new AiError('AI_KEY_REQUIRED', 'The GitHub Copilot sign-in expired. Start the sign-in again.', {
    details: { signInReason: 'sign_in_expired' satisfies CopilotSignInFailureReason },
  });
}

/**
 * The error of a sign-in that was cancelled (the user closed it, or the caller aborted the wait).
 *
 * @returns `AI_KEY_REQUIRED` with `details.signInReason` `sign_in_cancelled`.
 * @stability experimental
 */
export function copilotSignInCancelled(): AiError {
  return new AiError('AI_KEY_REQUIRED', 'The GitHub Copilot sign-in was cancelled.', {
    details: { signInReason: 'sign_in_cancelled' satisfies CopilotSignInFailureReason },
  });
}

/**
 * The error of a sign-in that ended without a signed-in account for a reason of
 * our own (nothing to wait for, a decision the runtime asks of the user that KVox
 * never takes for them, a status that is not signed in).
 *
 * @param reason - the `details.signInReason`.
 * @param message - a fixed sentence (never runtime text).
 * @returns `AI_KEY_REQUIRED` carrying the reason.
 * @stability experimental
 */
export function copilotSignInFailed(reason: CopilotSignInFailureReason, message: string): AiError {
  return new AiError('AI_KEY_REQUIRED', message, { details: { signInReason: reason } });
}

/** `GitHub Copilot: <redacted, capped message>`. */
function copilotMessage(text: string): string {
  return `GitHub Copilot: ${redactTokens(text).slice(0, MESSAGE_LIMIT)}`;
}

/** Only the three safe fields, strings redacted. */
function safeDetails(data: CopilotErrorData): Record<string, unknown> {
  return {
    ...(typeof data.errorType === 'string' ? { errorType: redactTokens(data.errorType).slice(0, 100) } : {}),
    ...(typeof data.statusCode === 'number' ? { statusCode: data.statusCode } : {}),
    ...(typeof data.errorCode === 'string' ? { errorCode: redactTokens(data.errorCode).slice(0, 100) } : {}),
  };
}

/** A finite number at or above zero. */
function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
