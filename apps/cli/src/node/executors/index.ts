import type { NodeApi, NodeJobAssignment } from '../node-api.js';
import { UnknownJobTypeError } from '../node-errors.js';

// =============================================================================
// The CLI-side executor registry  (issue #274, epic #254)
// =============================================================================
//
// The mirror image of the server's `JobHandlerRegistry`, and deliberately the
// same shape: a fork adds a node-side executor by writing one class and
// registering it, with no wiring anywhere else. The two registries are
// separate because they answer different questions — the server's decides what
// may be enqueued and what a result must look like; this one decides what THIS
// machine can actually run.
//
// A TYPE IN ONE AND NOT THE OTHER IS A REAL STATE, not a bug to design away:
//
//   - Server-only (no executor here) — this node simply never claims it, which
//     is what `eligibleTypes` says, and the in-process worker runs it.
//   - Executor-only (the server does not advertise it) — the server refuses
//     the claim; #273's `--types` validation catches the typo before that.
// =============================================================================

/** Everything an executor is given. Nothing is reachable except through this. */
export interface JobExecutionContext {
  /** The job row as the server leased it. */
  job: NodeJobAssignment['job'];
  /** The handler's own parameters, straight from `Job.payload`. */
  params: Record<string, unknown>;
  /**
   * Where the input object was streamed to, when `requiresInput` is true.
   * Guaranteed non-empty for such a type: the engine refuses the job with a
   * NAMED error rather than passing an empty path through.
   */
  inputPath: string | undefined;
  /** The input object's metadata, when there was one. */
  input: { objectId: string; size: string; mimeType: string } | undefined;
  /** For a type that must upload its output; the SERVER chooses the key. */
  api: NodeApi;
  nodeId: string;
  /** Aborted on drain and on lease loss. Long work should honour it. */
  signal: AbortSignal;
  /** Structured logging that goes through the daemon's redaction (#275). */
  log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * One job type this machine can run.
 *
 * `execute` RETURNS the result and THROWS to fail — the same contract the
 * server's handlers use, for the same reason: every provider error, missing
 * file and truncated stream becomes a reported failure with the real message,
 * and nobody has to remember to check a return code.
 *
 * Throw `ProviderRateLimitError` to route a throttle through the server's
 * deferral path instead of burning an attempt.
 */
export interface JobExecutor {
  readonly type: string;
  /**
   * Whether the engine should fetch a download URL and stream the input to a
   * temp file before calling `execute`.
   *
   * Declared rather than inferred, so a type that needs an input and did not
   * get one fails with a named error at the top of the job instead of an
   * opaque filesystem error somewhere inside it.
   */
  readonly requiresInput: boolean;
  execute(context: JobExecutionContext): Promise<unknown>;
}

/** A mutable registry. One instance per engine, so tests never share state. */
export class ExecutorRegistry {
  private readonly executors = new Map<string, JobExecutor>();

  register(executor: JobExecutor): this {
    this.executors.set(executor.type, executor);
    return this;
  }

  /** Every type this node can run. What `register`/`claim` advertise. */
  types(): string[] {
    return [...this.executors.keys()].sort();
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  /** Throws `UnknownJobTypeError`, naming what this node CAN run. */
  require(type: string): JobExecutor {
    const executor = this.executors.get(type);
    if (executor === undefined) throw new UnknownJobTypeError(type, this.types());
    return executor;
  }
}
