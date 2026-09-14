// =============================================================================
// AI error taxonomy (issue #47, epic #45)
// =============================================================================
//
// docs/specs/notes.md §2.2's taxonomy, implemented. A generation talks to a
// third-party API, over a network, WITH THE CALLING USER'S OWN CREDENTIAL, so
// it fails in ways that want completely different responses — and one of those
// differences is new here: the thing that failed may be the USER's key and the
// USER's quota, not the deployment's, so the message a user sees is the whole
// value of getting the classification right.
//
// FIVE OUTCOMES, AND WHAT EACH ONE COSTS TO GET WRONG:
//
//   1. `AiAuthError` — the provider refused the credential (401/403). The key
//      is wrong, revoked, or lacks the needed scope. RETRYING CANNOT HELP:
//      nothing about the next attempt differs. What it needs is the user on
//      their own key-settings page, which is why the message must say so
//      rather than reading as an application fault.
//
//   2. `AiInputError` — a DOMAIN error the provider blamed the request for: an
//      unknown model, a malformed body, a parameter this build got wrong
//      (400). The work is finished and the answer is "no". Retrying pays for
//      the same refusal twice against somebody's personal account.
//
//   3. `AiRefusedError` — the provider declined the request ITSELF: a
//      content-policy refusal, a `finish_reason: 'content_filter'`, a model
//      that rejects the input outright. Separated from `AiInputError` even
//      though both are terminal, because the two need DIFFERENT SENTENCES in
//      front of a user — "this application asked for something invalid" and
//      "the provider declined to answer this" are not the same news, and
//      collapsing them produces a message that is wrong for one of the two
//      every time.
//
//   4. `AiBudgetError` — the assembled prompt does not fit
//      (docs/specs/notes.md §3.3), or the provider reports a context-length
//      overflow the pre-flight check did not catch (a source that grew between
//      the request and the job). It carries NUMBERS, because §3.3's whole
//      argument is that "too large, by this much" is actionable and "too large"
//      is not. It is deliberately NOT silent truncation's error type: nothing
//      in this module truncates.
//
//   5. `RateLimitError` (429) — REUSED FROM `jobs/rate-limit.error.ts`,
//      deliberately not redefined here, for the reason `transcription/errors.ts`
//      states at length: the queue's deferral path keys off
//      `err instanceof RateLimitError`, and a second class of the same name in
//      a different module would satisfy no such check. Re-exported below so a
//      provider imports its error types from one place without that becoming a
//      second definition.
//
//   EVERYTHING ELSE IS RETRYABLE, and is thrown as a plain `Error`. A 5xx, a
//   dropped socket, a DNS failure, a body that is not what the API documents.
//   There is no `AiTransientError`, on purpose: making the common case require
//   a wrapper means the day somebody forgets it, a transient failure is
//   misclassified. The default has to be the safe one.
//
// ⚠ WHAT "RETRYABLE" MEANS FOR THIS EPIC SPECIFICALLY. `note.generate`
// declares `maxAttempts: 1` (docs/specs/notes.md §1.3, §2.2), so in practice
// nothing here auto-retries: a completion is non-deterministic and priced to
// the user, so a silent second attempt would bill them twice and show them
// different text than the partial stream they already watched. The taxonomy is
// still kept precise, because it drives WHAT THE USER IS TOLD and whether the
// failure is invisible (rate limit, deferred) or terminal (everything else).
//
// ⚠ NO ERROR IN THIS FILE MAY EVER BE CONSTRUCTED WITH KEY MATERIAL. These
// messages reach `Job.lastError`, the application log, and an API response. The
// only variables permitted in them are the provider id, the model id, the
// provider's own status/message, and token counts.
// =============================================================================

export { RateLimitError, parseRetryAfterMs } from '../jobs/rate-limit.error';

/**
 * Marker carried by every terminal AI failure.
 *
 * `instanceof` is the check to use inside this process. This field exists for
 * the case `instanceof` cannot serve — an error that has crossed a process
 * boundary (a worker node reporting a failure over HTTP) and arrives as a plain
 * object. A boolean on the payload is checkable there; a prototype is not. Same
 * device as `ProviderInputError.isDomainError`.
 */
interface DomainErrorMarker {
  readonly isDomainError: true;
}

/**
 * The provider refused the credential (401/403).
 *
 * ⚠ CARRIES NO KEY MATERIAL AND MUST NEVER BE CONSTRUCTED WITH ANY — and here
 * the key is the USER'S OWN, so a leak would be of a personal credential rather
 * than a deployment one.
 */
export class AiAuthError extends Error implements DomainErrorMarker {
  readonly isDomainError = true as const;

  constructor(
    message: string,
    /** `AiProvider.id` — which provider refused. */
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = 'AiAuthError';

    // ⚠ REQUIRED, NOT CEREMONIAL — the same downlevelling trap
    // `RateLimitError` documents: without this, `instanceof` returns false
    // under a downlevelled target and every auth failure is classified as an
    // ordinary bug.
    Object.setPrototypeOf(this, AiAuthError.prototype);
  }
}

/**
 * The provider blamed the REQUEST: an unknown model, a malformed body, a
 * parameter this build got wrong.
 *
 * A DOMAIN ERROR: retrying pays for the same refusal twice, against somebody's
 * personal account. `providerMessage` is the provider's verbatim explanation,
 * which is the only thing that tells an operator whether the model id is
 * retired or a parameter was renamed.
 */
export class AiInputError extends Error implements DomainErrorMarker {
  readonly isDomainError = true as const;

  constructor(
    message: string,
    /** The provider's own error string, verbatim. Never a credential. */
    public readonly providerMessage?: string,
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = 'AiInputError';
    Object.setPrototypeOf(this, AiInputError.prototype);
  }
}

/**
 * The provider declined to answer — a content-policy refusal, a
 * `finish_reason: 'content_filter'`, a model rejecting the input outright.
 *
 * SEPARATE FROM `AiInputError` on purpose. Both are terminal and neither is
 * retryable, so the distinction buys nothing mechanically; it buys the correct
 * SENTENCE in front of a user, which is the only thing a terminal failure can
 * still be good for.
 */
export class AiRefusedError extends Error implements DomainErrorMarker {
  readonly isDomainError = true as const;

  constructor(
    message: string,
    /** The provider's own explanation, when it gave one. Never a credential. */
    public readonly providerMessage?: string,
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = 'AiRefusedError';
    Object.setPrototypeOf(this, AiRefusedError.prototype);
  }
}

/**
 * The prompt does not fit the budget (docs/specs/notes.md §3.3).
 *
 * ⚠ IT CARRIES THE NUMBERS, and that is the entire point. §3.3 forbids silent
 * truncation and requires the refusal to name a figure the user can act on —
 * "this source is approximately 14,200 tokens; gpt-4o allows 11,500 for input
 * with this template and output length". An error that could only say "too
 * large" would satisfy the type and defeat the requirement, so the counts are
 * constructor arguments rather than optional extras.
 */
export class AiBudgetError extends Error implements DomainErrorMarker {
  readonly isDomainError = true as const;

  constructor(
    message: string,
    /** How many tokens the assembled prompt measured. */
    public readonly requiredTokens: number,
    /** How many were available for input, after output and safety margin. */
    public readonly availableTokens: number,
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = 'AiBudgetError';
    Object.setPrototypeOf(this, AiBudgetError.prototype);
  }
}

/**
 * Is this a failure no amount of retrying will change?
 *
 * TOTAL AND NEVER THROWS, mirroring `isTerminalProviderError` and
 * `classifyRateLimit`: it is called from a failure path on a value that is
 * `unknown` by construction. Anything it does not positively recognise is
 * "retryable", because the cost of a false negative is one wasted attempt and
 * the cost of a false positive is a job abandoned on a transient network blip.
 *
 * ⚠ A `RateLimitError` IS NOT TERMINAL and must not be passed here expecting
 * `true`: it is not a failure at all, it is a deferral, and the queue handles
 * it before this function is ever reached.
 */
export function isTerminalAiError(err: unknown): boolean {
  if (
    err instanceof AiAuthError ||
    err instanceof AiInputError ||
    err instanceof AiRefusedError ||
    err instanceof AiBudgetError
  ) {
    return true;
  }

  // A domain error that crossed a process boundary and lost its prototype —
  // see `DomainErrorMarker` above.
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isDomainError?: unknown }).isDomainError === true
  );
}
