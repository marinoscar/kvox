// =============================================================================
// Transcription error taxonomy (issue #23, epic #19)
// =============================================================================
//
// A transcription job talks to a third-party API over a network, so it fails in
// ways that want completely different responses. The queue already knows how to
// tell a bug from a throttle (`jobs/rate-limit.error.ts`); this file adds the
// two distinctions that are specific to a provider integration, and states the
// default for everything else.
//
// FOUR CLASSES, AND WHAT EACH ONE COSTS TO GET WRONG:
//
//   1. `ProviderAuthError` — the API key is missing, wrong, revoked, or belongs
//      to a different region. RETRYING CANNOT HELP: nothing about the next
//      attempt differs. It is retryable-by-the-queue only in the sense that any
//      thrown error is; what it really needs is an administrator on the
//      settings page. Treating it as transient burns the attempt budget and
//      buries the one actionable message in `lastError` behind three identical
//      copies of itself.
//
//   2. `ProviderInputError` — a DOMAIN error. The provider accepted the request,
//      ran it, and reported that the INPUT cannot be transcribed: a corrupt
//      container, silence, an unsupported codec, a file that is not audio. THIS
//      MUST NEVER BE RETRIED. It is the one class where retrying is not merely
//      useless but actively harmful — each attempt is a full upload and a full
//      provider charge for a result that is already known.
//
//   3. `RateLimitError` — REUSED FROM `jobs/rate-limit.error.ts`, deliberately
//      not redefined here. The queue's deferral path keys off
//      `err instanceof RateLimitError`, and a second class with the same name in
//      a different module would satisfy no such check: the job would be
//      classified as an ordinary bug, charged an attempt, and fail permanently
//      on a condition that was never its fault. Re-exported below so a provider
//      imports its three error types from one place without that becoming a
//      second definition.
//
//   4. EVERYTHING ELSE IS RETRYABLE. A 5xx, a dropped socket, a DNS failure, a
//      JSON body that is not what the API documents — all transient until
//      proven otherwise, and all handled by simply throwing. There is no
//      `ProviderTransientError`, on purpose: making the common case require a
//      wrapper means the day somebody forgets it, a transient failure is
//      misclassified. The default has to be the safe one.
//
// HOW A HANDLER USES THIS (issue #25 owns the handler; this is the contract it
// will implement): catch nothing. `ProviderInputError` is checked for by the
// handler and turned into a terminal failure with no retry; `RateLimitError`
// is already understood by `JobTerminalService`; anything else retries.
// =============================================================================

export { RateLimitError } from '../jobs/rate-limit.error';

/**
 * The provider refused the credential.
 *
 * Carries no key material and must never be constructed with any: the message
 * reaches `Job.lastError`, the application log, and an admin response. The
 * only variables permitted in it are the provider id and the provider's own
 * status/message.
 */
export class ProviderAuthError extends Error {
  constructor(
    message: string,
    /** `TranscriptionProvider.id` — which provider refused. */
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = 'ProviderAuthError';

    // ⚠ REQUIRED, NOT CEREMONIAL — the same downlevelling trap
    // `RateLimitError` documents: without this, `instanceof` returns false
    // under a downlevelled target and every auth failure is classified as an
    // ordinary bug.
    Object.setPrototypeOf(this, ProviderAuthError.prototype);
  }
}

/**
 * The provider ran the job and reported that the INPUT is the problem.
 *
 * A DOMAIN ERROR: the work is finished and the answer is "no". A caller that
 * retries this is paying twice for the same refusal. `providerMessage` is the
 * provider's verbatim explanation, which is the only thing that tells an
 * operator whether the file was silent, truncated, or simply not audio.
 */
export class ProviderInputError extends Error {
  /**
   * Marker property, alongside `instanceof`.
   *
   * `instanceof` is the check to use inside this process. This field exists for
   * the case `instanceof` cannot serve: an error that has crossed a process
   * boundary (a worker node reporting a failure over HTTP) and arrives as a
   * plain object. A boolean on the payload is checkable there; a prototype is
   * not.
   */
  readonly isDomainError = true as const;

  constructor(
    message: string,
    /** The provider's own `error` string, verbatim. Never a credential. */
    public readonly providerMessage?: string,
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = 'ProviderInputError';
    Object.setPrototypeOf(this, ProviderInputError.prototype);
  }
}

/**
 * Is this a failure no amount of retrying will change?
 *
 * TOTAL AND NEVER THROWS, mirroring `classifyRateLimit`: it is called from a
 * failure path on a value that is `unknown` by construction. Anything it does
 * not positively recognise is "retryable", because the cost of a false negative
 * is one wasted attempt and the cost of a false positive is a job abandoned on
 * a transient network blip.
 */
export function isTerminalProviderError(err: unknown): boolean {
  if (err instanceof ProviderInputError) return true;

  // A domain error that crossed a process boundary and lost its prototype —
  // see `isDomainError` above.
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isDomainError?: unknown }).isDomainError === true
  );
}
