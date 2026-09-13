import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { arch, cpus, freemem, platform, totalmem } from 'node:os';

// =============================================================================
// Capability probe and the startup self-test  (issue #276, epic #254)
// =============================================================================
//
// THE FAILURE MODE THIS EXISTS TO PREVENT is the worst one a worker has: a node
// that starts successfully but cannot actually do the work it advertised. It
// claims jobs and fails them one at a time, looking healthy to every
// orchestrator and every dashboard while draining the queue into the failed
// pile — and each failure costs the job an attempt, so a fleet member with a
// missing dependency can permanently fail work that nothing was wrong with.
//
// So a worker probes what it can do, compares that against what its ELIGIBLE
// TYPES require, and splits the outcome:
//
//   - a missing REQUIRED capability  → hard exit, naming the capability and
//     the type. In a container that is a visible crash-loop with a clear
//     reason, which is strictly better than a node that quietly fails
//     everything it touches.
//   - a missing DEGRADABLE capability → warn and continue.
//
// That distinction is the whole point of the self-test. Without it, "start
// succeeded" carries no information at all.
//
// -----------------------------------------------------------------------------
// THE REQUIREMENTS MAP NOW HAS ONE REAL ENTRY, AND ONE EXAMPLE-SHAPED ONE
// -----------------------------------------------------------------------------
//
// It was empty when this file was written (#276), and deliberately so: the
// template's example type hashes a stream and needs nothing native, and
// inventing requirements this repository did not have would have been
// inventing dependencies. #352 gave it a genuine one — `db.backup.run` runs
// `pg_dump` — which is also what turns this map from a documented STRUCTURE
// into a worked example of both tiers: a required binary whose absence must
// stop the type being declared at all, and a degradable one whose absence
// costs two audit fields and nothing else.
// =============================================================================

/** A capability key. `binary:<name>` is the convention for an executable. */
export type Capability = string;

/** Build the key for an executable, so no call site spells the prefix itself. */
export function binaryCapability(name: string): Capability {
  return `binary:${name}`;
}

export interface JobTypeRequirements {
  /** Absent → the node must NOT claim this type. Hard exit at startup. */
  required: Capability[];
  /** Absent → reduced function, but the work is still worth attempting. */
  degradable: Capability[];
}

/**
 * What each node-eligible job type needs.
 *
 * A type absent from this map requires nothing — which is the right default for
 * a template, and means a fork adds an entry only when it has something to
 * declare.
 */
export const JOB_TYPE_REQUIREMENTS: Record<string, JobTypeRequirements> = {
  // The example type streams and hashes. No native dependency, deliberately.
  'example.checksum': { required: [], degradable: [] },
  // ---------------------------------------------------------------------------
  // `db.backup.run` (#352, epic #345) — the first type with a REAL requirement,
  // and the entry this map's whole structure was written for.
  // ---------------------------------------------------------------------------
  //
  // `pg_dump` is REQUIRED: without it this node cannot take a backup at all,
  // and a node that declares the type anyway would claim the deployment's
  // nightly dump, fail it, and — because `db.backup.run` carries
  // `maxAttempts: 1` — PERMANENTLY fail it. That is the exact failure the
  // self-test exists to prevent, in its most expensive form: the backup that
  // did not happen is discovered during a restore.
  //
  // `psql` is DEGRADABLE, and it is the template's worked example of that tier.
  // The executor uses it for two best-effort provenance reads (the server
  // version and the newest applied migration). Without it the backup is taken,
  // uploaded and verified exactly as before; two audit columns are `null`. A
  // node that refused to run because it could not report a version string would
  // be trading a whole backup for a label — and in practice the two binaries
  // ship in the same `postgresql-client` package, so a node with `pg_dump` and
  // no `psql` is a deliberately trimmed image whose owner already knows.
  'db.backup.run': {
    required: [binaryCapability('pg_dump')],
    degradable: [binaryCapability('psql')],
  },
};

/**
 * Executables the probe looks for. A fork extends this beside its requirements.
 *
 * ⚠ THIS LIST AND THE MAP ABOVE MOVE TOGETHER. A capability that is never
 * PROBED is a capability that is never satisfied, so a requirement naming a
 * binary missing from here would fail the self-test on every machine, however
 * complete its install.
 */
export const PROBED_BINARIES: string[] = ['pg_dump', 'psql'];

export interface CapabilityProbe {
  platform: string;
  arch: string;
  nodeVersion: string;
  cpus: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  /** Which of `PROBED_BINARIES` were found on PATH. */
  binaries: Record<string, boolean>;
  /** Flat set of satisfied capability keys — what the self-test compares against. */
  capabilities: Capability[];
}

/**
 * Probe this machine. NEVER THROWS, whatever the environment.
 *
 * A probe that can fail is a probe that turns a diagnostic command into
 * another thing to diagnose. Every lookup below degrades to "absent".
 */
export function probeCapabilities(options?: {
  binaries?: string[] | undefined;
  hasBinary?: ((name: string) => boolean) | undefined;
}): CapabilityProbe {
  const names = options?.binaries ?? PROBED_BINARIES;
  const has = options?.hasBinary ?? isOnPath;

  const binaries: Record<string, boolean> = {};
  for (const name of names) {
    try {
      binaries[name] = has(name);
    } catch {
      binaries[name] = false;
    }
  }

  const capabilities: Capability[] = [];
  for (const [name, found] of Object.entries(binaries)) {
    if (found) capabilities.push(binaryCapability(name));
  }

  return {
    platform: safe(() => platform(), 'unknown'),
    arch: safe(() => arch(), 'unknown'),
    nodeVersion: process.version,
    cpus: safe(() => cpus().length, 1),
    totalMemoryMb: safe(() => Math.round(totalmem() / 1024 / 1024), 0),
    freeMemoryMb: safe(() => Math.round(freemem() / 1024 / 1024), 0),
    binaries,
    capabilities,
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Is `name` an executable on PATH?
 *
 * `which`/`where` rather than walking PATH ourselves: the platform's own
 * resolver already knows about PATHEXT, symlinks and shell builtins, and
 * reimplementing it is how a probe reports "missing" for something that is
 * plainly installed.
 */
function isOnPath(name: string): boolean {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(finder, [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface CapabilityGap {
  type: string;
  capability: Capability;
}

export interface SelfTestResult {
  /** False only when a REQUIRED capability is missing. */
  ok: boolean;
  missingRequired: CapabilityGap[];
  missingDegradable: CapabilityGap[];
}

/** Compare advertised types against the probe. Pure, so it is trivially testable. */
export function evaluateCapabilities(
  types: readonly string[],
  probe: CapabilityProbe,
  requirements: Record<string, JobTypeRequirements> = JOB_TYPE_REQUIREMENTS,
): SelfTestResult {
  const satisfied = new Set(probe.capabilities);
  const missingRequired: CapabilityGap[] = [];
  const missingDegradable: CapabilityGap[] = [];

  for (const type of types) {
    const need = requirements[type];
    if (need === undefined) continue;
    for (const capability of need.required) {
      if (!satisfied.has(capability)) missingRequired.push({ type, capability });
    }
    for (const capability of need.degradable) {
      if (!satisfied.has(capability)) missingDegradable.push({ type, capability });
    }
  }

  return { ok: missingRequired.length === 0, missingRequired, missingDegradable };
}

export interface SelfTestOptions {
  types: readonly string[];
  probe?: CapabilityProbe | undefined;
  requirements?: Record<string, JobTypeRequirements> | undefined;
  warn?: ((message: string) => void) | undefined;
  fail?: ((message: string) => void) | undefined;
}

/**
 * Run the startup self-test and report what to do about it.
 *
 * Returns the result rather than calling `process.exit` itself — the caller
 * owns the exit, which is what keeps this testable and lets `doctor` reuse it
 * without terminating.
 */
export function runStartupSelfTest(options: SelfTestOptions): SelfTestResult {
  const probe = options.probe ?? probeCapabilities();
  const result = evaluateCapabilities(options.types, probe, options.requirements);

  for (const gap of result.missingDegradable) {
    options.warn?.(
      `Reduced function: job type "${gap.type}" would use "${gap.capability}", which is not available on this machine.`,
    );
  }

  for (const gap of result.missingRequired) {
    options.fail?.(
      `Cannot run job type "${gap.type}": required capability "${gap.capability}" is missing. ` +
        `Install it, or drop the type from this node's --types.`,
    );
  }

  return result;
}

/** Is a path writable? Used by `doctor` and the install steps. */
export function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
