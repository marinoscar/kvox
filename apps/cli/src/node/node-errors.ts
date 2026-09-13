import { CliError, EXIT, type ExitCode } from '../errors.js';

// =============================================================================
// Errors a worker classifies rather than merely reports  (issue #274, epic #254)
// =============================================================================
//
// The engine reports every failure to the server the same way except one, and
// the exception is the reason this module exists.
// =============================================================================

/**
 * A provider throttled us. NOT a job failure.
 *
 * The distinction is load-bearing. A job that failed because a third-party API
 * said "429, come back in 30 seconds" has not failed at all — nothing about it
 * is wrong, and retrying it in 30 seconds will work. Charging it an attempt
 * would let a busy afternoon exhaust a job's whole retry budget without a
 * single genuine error, and permanently fail work that was only ever waiting.
 *
 * So the node reports this as `rateLimited` with a `retryAfterMs`, the server
 * routes it through its DEFERRAL path (which un-charges the attempt), and —
 * because the throttle belongs to the provider and not to this node — the
 * server also backs off SIBLING jobs of the same type, including ones it was
 * about to run itself. That last part is only possible because the node sends
 * a typed signal instead of a message the server would have to string-match.
 *
 * A THROWN INSTANCE IS THE ONLY WAY TO SAY THIS. `node-engine.ts` checks
 * `instanceof` and nothing else — deliberately no message sniffing, no status
 * inspection — so a fork's executor opts in explicitly and cannot trip the
 * deferral path by accident with an unluckily-worded error.
 */
export class ProviderRateLimitError extends CliError {
  readonly exitCode: ExitCode = EXIT.API;

  /** Milliseconds the provider asked us to wait. A FLOOR on the server's backoff. */
  readonly retryAfterMs: number;

  /** Which provider, for the log line. Free-form; the server does not parse it. */
  readonly provider: string | undefined;

  constructor(message: string, options: { retryAfterMs: number; provider?: string | undefined; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    // Clamped to the server's own accepted range (0…24h in
    // `nodeJobFailureSchema`) so a provider's absurd `Retry-After` becomes a
    // validation failure on OUR side of the boundary, where the message is
    // ours, rather than a 400 that reads as the node being broken.
    this.retryAfterMs = Math.max(0, Math.min(Math.round(options.retryAfterMs), 86_400_000));
    this.provider = options.provider;
  }
}

/**
 * A type declared it needs an input object and the server gave us no download
 * URL for this job.
 *
 * NAMED, with the job and the type in the message. The alternative — carrying
 * an empty path forward — surfaces much later as `ENOENT ... open ''`, which
 * says nothing about which job, which type, or that an input was expected at
 * all. That failure costs an hour to diagnose the first time and is entirely
 * avoidable here.
 */
export class MissingJobInputError extends CliError {
  readonly exitCode: ExitCode = EXIT.FAILURE;

  constructor(jobId: string, type: string, detail?: string) {
    super(
      `Job ${jobId} (${type}) requires an input object, but the server provided no download URL` +
        (detail === undefined ? '.' : `: ${detail}`),
    );
  }
}

/** No executor is registered for a type this node was handed. */
export class UnknownJobTypeError extends CliError {
  readonly exitCode: ExitCode = EXIT.FAILURE;

  constructor(type: string, known: readonly string[]) {
    super(
      `No executor registered for job type "${type}". This node can run: ` +
        `${known.length > 0 ? [...known].sort().join(', ') : '(none)'}.`,
    );
  }
}
