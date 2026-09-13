import { envVar } from '../branding.js';
import { SERVER_URL_ENV_VAR, TOKEN_ENV_VAR } from '../config.js';

// =============================================================================
// Worker environment variables — one map, one source of truth  (issue #272, epic #254)
// =============================================================================
//
// This repository is a TEMPLATE, and the worker node is the part of it most
// exposed to that fact. The application this design is ported from hard-codes
// its own product name into roughly a dozen environment variables, its state
// directory, its systemd unit and its compose file. Ported literally, every
// one of those is wrong the moment somebody renames this template — and none
// of them would fail loudly. A worker would simply never see its
// configuration and would sit idle, or start with defaults nobody asked for.
//
// So every variable the worker reads is declared HERE, once, built through
// the existing `envVar()` so it inherits `ENV_PREFIX` from `CLI_NAME`. Call
// sites read `WORKER_ENV.concurrency`, never `process.env.APPCTL_CONCURRENCY`.
// A rename is then still a one-line edit in `branding.ts`.
//
// -----------------------------------------------------------------------------
// WHY `serverUrl` AND `token` ARE NOT NEW NAMES
// -----------------------------------------------------------------------------
//
// They are the EXISTING `SERVER_URL_ENV_VAR` / `TOKEN_ENV_VAR` from
// `config.ts`, re-exported through this map rather than minted again. Two
// reasons, and both matter more than the small ugliness of a map whose first
// two entries come from somewhere else:
//
//   1. A worker container authenticates exactly the way `appctl login`
//      does — it IS the same CLI, reading the same config file. A second name
//      for the server URL would mean a machine where `appctl api` works and
//      `appctl node start` does not, for no reason a user could discover.
//
//   2. Two names for one value is precisely the drift `branding.ts` exists to
//      prevent. It would also have to be written into the Dockerfile and the
//      compose file (#278), where the bidirectional guard would then be
//      asserting a duplicate.
//
// -----------------------------------------------------------------------------
// THE GUARD
// -----------------------------------------------------------------------------
//
// `env-prefix.test.ts` scans every non-test module under `src/` and fails if
// any of them contains a string literal starting with `ENV_PREFIX` outside
// `branding.ts`. That is what makes "every read goes through this map" a
// structural property rather than a convention somebody remembers. The
// scanning pattern is BUILT from `ENV_PREFIX`, never written out, or the
// guard would itself contain the literal it forbids.
// =============================================================================

/**
 * Every environment variable a worker node reads.
 *
 * Keys are the internal names code uses; values are the actual variable names
 * a user sets. Adding a variable means adding it here first — #278's guard
 * asserts this map and the container files agree in BOTH directions, so a
 * variable that exists in only one of the two places is a failing test.
 */
export const WORKER_ENV = {
  /** `APPCTL_SERVER_URL` — reused from `config.ts`, never minted again. */
  serverUrl: SERVER_URL_ENV_VAR,
  /** `APPCTL_TOKEN` — reused from `config.ts`. A `nod_` credential, normally. */
  token: TOKEN_ENV_VAR,
  /** The node row this process re-attaches to, so a restart is not a new node. */
  nodeId: envVar('NODE_ID'),
  /** Display name; defaults to the hostname. Reattachment keys on it server-side. */
  nodeName: envVar('NODE_NAME'),
  /** How many jobs this process runs at once. 1–64, per the server's own cap. */
  concurrency: envVar('CONCURRENCY'),
  /** Comma-separated job types this node will claim. Empty means "all it can". */
  types: envVar('ELIGIBLE_TYPES'),
  /** Idle poll interval in milliseconds. */
  pollMs: envVar('POLL_INTERVAL_MS'),
  /** `true` to run without a TTY and drain on SIGTERM WITHOUT deregistering. */
  headless: envVar('HEADLESS'),
  /** Overrides the state directory. The one variable a container almost always sets. */
  stateDir: envVar('STATE_DIR'),
  /** Old-space limit in MB for the re-exec (#277). `0` disables re-tuning entirely. */
  heapLimitMb: envVar('HEAP_LIMIT_MB'),
  /**
   * The re-exec LATCH (#277). Set by the parent shim on the child it spawns.
   *
   * Not an operator knob — it exists so the re-exec cannot loop. It is still
   * declared here rather than read as a literal, because the rule this map
   * enforces has no exceptions: a variable the code reads is a variable a
   * rename must reach.
   */
  heapTuned: envVar('HEAP_TUNED'),
  /** `false` to disable the memory watchdog and its pre-OOM valve (#277). */
  memoryWatchdog: envVar('MEMORY_WATCHDOG'),
  /** heapUsed/heapLimit fraction at which the valve fires. Default ~0.9 (#277). */
  memoryThreshold: envVar('MEMORY_THRESHOLD'),
  /** `false` to disable ALL THREE heap-snapshot paths (#277). */
  heapSnapshots: envVar('HEAP_SNAPSHOTS'),
} as const;

/** The key set of `WORKER_ENV`, for exhaustive iteration in guards and docs. */
export type WorkerEnvKey = keyof typeof WORKER_ENV;

/** Every variable name the worker reads, deduplicated and sorted. */
export function workerEnvNames(): string[] {
  return [...new Set(Object.values(WORKER_ENV))].sort();
}
