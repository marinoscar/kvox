import { hostname } from 'node:os';

import { CLI_NAME } from '../branding.js';
import {
  readConfigFile,
  requireCredentials,
  writeConfigFile,
  type ConfigSource,
  type StoredConfig,
  type StoredNodeConfig,
} from '../config.js';
import { ConfigError, UsageError } from '../errors.js';
import { nodeStateDir, type NodePathsContext } from './paths.js';
import { WORKER_ENV } from './worker-env.js';

// =============================================================================
// Worker node configuration  (issue #272, epic #254)
// =============================================================================
//
// Three behaviours, and the third is the one that matters most:
//
//   1. FILE, THEN ENVIRONMENT, PER FIELD. Not all-or-nothing — the precedent
//      is already set by `resolveConfig()` in config.ts, and the reason is the
//      same: a container that overrides only `CONCURRENCY` should not have to
//      restate the node's name and eligible types to do it.
//
//   2. A CONFIG IS SYNTHESISED FROM THE ENVIRONMENT ALONE when no file exists
//      and both the server URL and the token are present. That single
//      behaviour is what lets a worker container run with ZERO interactive
//      setup: `docker run -e APPCTL_SERVER_URL=... -e APPCTL_TOKEN=nod_...`
//      and nothing else. Without it, every replica in a fleet would need a
//      config file baked in or mounted, which is a secret in an image or a
//      volume per replica.
//
//   3. A WRITE FAILURE IN THAT MODE WARNS RATHER THAN THROWS. A container's
//      home directory is very often read-only, and the write is an
//      optimisation (it persists the `nodeId` so a restart re-attaches), not a
//      requirement — the environment can supply `NODE_ID` too. Turning a
//      read-only filesystem into a fatal start would break exactly the
//      deployment shape this feature exists for.
//
// AN INVALID ENUMERATED VALUE IS AN ERROR, NEVER A COERCION. An unknown
// eligible type names the valid set. Silently dropping it would produce a node
// that registered with fewer types than the operator asked for and then
// claimed nothing, which reads as "the queue is broken".
// =============================================================================

/** The server's own cap — `MAX_NODE_CONCURRENCY` in `node-control-plane.dto.ts`. */
export const MAX_NODE_CONCURRENCY = 64;

/** The floor. Zero is not "paused", it is a node that registers and never works. */
export const MIN_NODE_CONCURRENCY = 1;

/** Default idle poll interval. Fast enough to feel live, slow enough to be free. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Floor on the poll interval, so a typo cannot turn a worker into a load test. */
export const MIN_POLL_INTERVAL_MS = 250;

/** Ceiling — beyond this a node looks wedged rather than idle. */
export const MAX_POLL_INTERVAL_MS = 300_000;

/**
 * Default concurrency when nothing says otherwise.
 *
 * Deliberately conservative here; #277 replaces the DEFAULT with a core- and
 * RAM-aware value by passing `defaultConcurrency` into `resolveNodeConfig`.
 * The seam is the parameter, so that change touches no call site that does not
 * want it.
 */
export const DEFAULT_NODE_CONCURRENCY = 1;

/** The fully-defaulted worker settings. Nothing here is optional. */
export interface NodeConfig {
  name: string;
  concurrency: number;
  /** Empty means "everything the server says I may claim". */
  eligibleTypes: string[];
  pollIntervalMs: number;
}

/** Everything `node start` needs, with the environment already applied. */
export interface ResolvedNodeConfig {
  serverUrl: string;
  token: string;
  serverUrlSource: ConfigSource;
  tokenSource: ConfigSource;
  /** `undefined` until `node register` has run (or `NODE_ID` is set). */
  nodeId: string | undefined;
  node: NodeConfig;
  /** Drain on SIGTERM WITHOUT deregistering — the container/service mode. */
  headless: boolean;
  /** Absolute path of the worker's state directory. */
  stateDir: string;
  /** True when no config file existed and this was built from the environment. */
  synthesised: boolean;
}

export interface ResolveNodeConfigOptions extends NodePathsContext {
  /** Overrides `DEFAULT_NODE_CONCURRENCY`; #277 passes a RAM-aware value. */
  defaultConcurrency?: number | undefined;
  /**
   * The server's advertised node-eligible types, when the caller has fetched
   * them. Supplied by `node register` (#273); omitted at start-up, where the
   * cost of a round trip before reading config is not worth paying.
   */
  knownTypes?: readonly string[] | undefined;
  /** Where a degraded write reports itself. Defaults to stderr. */
  warn?: ((message: string) => void) | undefined;
}

/** Default node name: the hostname, so the common case needs no flags. */
export function defaultNodeName(ctx?: NodePathsContext): string {
  const fromEnv = (ctx?.env ?? process.env)[WORKER_ENV.nodeName]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const host = hostname().trim();
  return host.length > 0 ? host : `${CLI_NAME}-node`;
}

/**
 * Parse `--types`/`ELIGIBLE_TYPES`: a comma-separated list, trimmed, deduped,
 * order preserved.
 *
 * Empty entries are dropped rather than rejected, because `a,b,` is a trailing
 * comma somebody typed, not a request to claim a type called "".
 */
export function parseEligibleTypes(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const parts = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(parts)];
}

/**
 * Refuse an eligible type the server has never heard of, NAMING the valid set.
 *
 * Only enforced when the caller actually knows the valid set. Start-up does
 * not — `node start` must work while the API is briefly unreachable, and the
 * server re-checks every claim against its own registry anyway, so the
 * client-side check is a usability guard rather than a security one.
 */
export function assertKnownTypes(types: readonly string[], knownTypes: readonly string[]): void {
  const known = new Set(knownTypes);
  const unknown = types.filter((type) => !known.has(type));
  if (unknown.length === 0) return;

  const valid = knownTypes.length > 0 ? [...knownTypes].sort().join(', ') : '(this server advertises none)';
  throw new UsageError(
    `Unknown job ${unknown.length === 1 ? 'type' : 'types'}: ${unknown.join(', ')}. ` +
      `Valid node-eligible types are: ${valid}.`,
  );
}

/** Bounds-check concurrency with the server's own limits, named in the message. */
export function assertConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < MIN_NODE_CONCURRENCY || value > MAX_NODE_CONCURRENCY) {
    throw new UsageError(
      `Concurrency must be a whole number between ${MIN_NODE_CONCURRENCY} and ${MAX_NODE_CONCURRENCY} (got ${value}).`,
    );
  }
  return value;
}

/** Read an integer from the environment, naming the variable when it is not one. */
function envInteger(name: string, raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    throw new UsageError(`${name} must be a whole number (got ${JSON.stringify(trimmed)}).`);
  }
  return parsed;
}

/** `true`/`1`/`yes`/`on`, case-insensitively. Anything else is false. */
export function envFlag(raw: string | undefined): boolean {
  const trimmed = raw?.trim().toLowerCase();
  return trimmed === 'true' || trimmed === '1' || trimmed === 'yes' || trimmed === 'on';
}

function clampPollInterval(value: number): number {
  if (value < MIN_POLL_INTERVAL_MS || value > MAX_POLL_INTERVAL_MS) {
    throw new UsageError(
      `Poll interval must be between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS} ms (got ${value}).`,
    );
  }
  return value;
}

/**
 * The one resolver every node command calls.
 *
 * Credentials come from `requireCredentials()` — reused, never reimplemented —
 * so a half-set environment produces the message that already names the
 * missing variable, rather than a second, differently-worded version of it.
 */
export function resolveNodeConfig(options?: ResolveNodeConfigOptions): ResolvedNodeConfig {
  const env = options?.env ?? process.env;
  const credentials = requireCredentials(options);
  const file = readConfigFile(options);
  const stored: StoredNodeConfig = file?.node ?? {};

  const envTypes = env[WORKER_ENV.types]?.trim();
  const eligibleTypes =
    envTypes !== undefined && envTypes.length > 0
      ? parseEligibleTypes(envTypes)
      : (stored.eligibleTypes ?? []);

  if (options?.knownTypes !== undefined) {
    assertKnownTypes(eligibleTypes, options.knownTypes);
  }

  const envConcurrency = envInteger(WORKER_ENV.concurrency, env[WORKER_ENV.concurrency]);
  const concurrency = assertConcurrency(
    envConcurrency ?? stored.concurrency ?? options?.defaultConcurrency ?? DEFAULT_NODE_CONCURRENCY,
  );

  const envPoll = envInteger(WORKER_ENV.pollMs, env[WORKER_ENV.pollMs]);
  const pollIntervalMs = clampPollInterval(envPoll ?? stored.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  const envName = env[WORKER_ENV.nodeName]?.trim();
  const name = envName !== undefined && envName.length > 0 ? envName : (stored.name ?? defaultNodeName(options));

  const envNodeId = env[WORKER_ENV.nodeId]?.trim();
  const nodeId = envNodeId !== undefined && envNodeId.length > 0 ? envNodeId : file?.nodeId;

  return {
    serverUrl: credentials.serverUrl,
    token: credentials.token,
    serverUrlSource: credentials.serverUrlSource,
    tokenSource: credentials.tokenSource,
    nodeId,
    node: { name, concurrency, eligibleTypes, pollIntervalMs },
    headless: envFlag(env[WORKER_ENV.headless]),
    stateDir: nodeStateDir(options),
    synthesised: file === undefined,
  };
}

/**
 * Merge a patch into the stored config's node block and write it back.
 *
 * READ-MERGE-WRITE, because `writeConfigFile` replaces the file wholesale:
 * writing `{ node }` alone would delete the user's token. The merge is
 * shallow over two levels, which is all this shape has.
 *
 * `degradeOnFailure` is the env-only-mode contract from the header: the caller
 * that synthesised its config from the environment passes `true`, so a
 * read-only home directory warns and keeps working.
 */
export function saveNodeConfig(
  patch: { nodeId?: string | undefined; node?: Partial<NodeConfig> | undefined },
  options?: ResolveNodeConfigOptions & { degradeOnFailure?: boolean | undefined },
): string | undefined {
  try {
    // The READ is inside the try too, deliberately. An unusable home directory
    // fails on the read (ENOTDIR/EACCES on `config.json`) before the write ever
    // runs, so a try around the write alone would still turn a read-only
    // container home into a fatal start — the exact failure this parameter
    // exists to prevent.
    const existing: StoredConfig = readConfigFile(options) ?? {};
    const mergedNode: StoredNodeConfig = { ...(existing.node ?? {}), ...(patch.node ?? {}) };

    const next: StoredConfig = {
      ...existing,
      ...(patch.nodeId !== undefined ? { nodeId: patch.nodeId } : {}),
      ...(Object.keys(mergedNode).length > 0 ? { node: mergedNode } : {}),
    };

    return writeConfigFile(next, options);
  } catch (error) {
    if (options?.degradeOnFailure !== true) throw error;
    const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
    warn(
      `Warning: could not persist worker settings (${
        error instanceof ConfigError ? error.message : String(error)
      }). Continuing with the settings from the environment; set ${WORKER_ENV.nodeId} to re-attach after a restart.`,
    );
    return undefined;
  }
}

/**
 * Persist a freshly-minted `nod_` credential, PRESERVING the node block.
 *
 * `saveCredentials()` in config.ts replaces the whole file, which is right for
 * `login` (it is establishing a new session) and wrong here: `node enroll` on
 * a machine that has already registered would silently drop its `nodeId` and
 * leak a second node row on the next start.
 *
 * ⚠ THE EXPIRY IS CLEARED, NOT CARRIED OVER. A node credential normally never
 * expires (`expiresAt: null` — see the epic's locked decisions), and leaving a
 * previous PAT's `expiresAt` in place would make `config` report a perfectly
 * valid credential as expired, and `status` refuse to use it. Passing `null`
 * is therefore meaningfully different from passing `undefined`: it means "this
 * one has no expiry", and both land as an ABSENT field rather than a stale one.
 */
export function saveNodeCredentials(
  input: {
    serverUrl: string;
    token: string;
    expiresAt?: string | null | undefined;
    tokenId?: string | undefined;
    tokenName?: string | undefined;
  },
  options?: ResolveNodeConfigOptions,
): string {
  const existing: StoredConfig = readConfigFile(options) ?? {};

  const next: StoredConfig = {
    ...existing,
    serverUrl: input.serverUrl,
    token: input.token,
    ...(typeof input.expiresAt === 'string' ? { expiresAt: input.expiresAt } : {}),
    ...(input.tokenId !== undefined ? { tokenId: input.tokenId } : {}),
    ...(input.tokenName !== undefined ? { tokenName: input.tokenName } : {}),
  };

  // Explicitly deleted rather than merely not set: `existing` was spread in
  // above, so an omitted key would carry the OLD value forward — which is
  // exactly the stale-expiry bug this function exists to prevent.
  if (typeof input.expiresAt !== 'string') delete next.expiresAt;
  if (input.tokenId === undefined) delete next.tokenId;
  if (input.tokenName === undefined) delete next.tokenName;

  return writeConfigFile(next, options);
}
