import { readFileSync } from 'node:fs';
import { arch, cpus, hostname, release, totalmem } from 'node:os';

import { parseDf } from './checks/host.js';
import type { runCommand } from './executor.js';

// =============================================================================
// What kind of server this is  (issue #120, epic #118)
// =============================================================================
//
// The About page (#124, #126, #128) shows the machine the application runs
// on, and the API cannot see it from inside its container: `os.hostname()`
// there is the container id, `statfs('/app')` is the overlay, and the docker
// version is the one thing docker never tells a container. So the CLI reads
// the facts at deploy time, on the host, and writes them into deploy-info for
// the API to read back (deploy-info.ts). #127 reuses the same reading for its
// server-derived wizard defaults, so nothing here is specific to the About page.
//
// EVERY PROBE IS INDIVIDUALLY OPTIONAL. A missing value is `null`, never a
// throw: an install that succeeded must not be reported as failed because
// `/etc/os-release` is absent on some minimal image, and the About page can
// render "unknown" for one cell. Pure given its inputs - the subprocess runner
// and the reads are injected, so the tests can fail each probe on its own.
// =============================================================================

export interface ServerFacts {
  hostname: string | null;
  /** `PRETTY_NAME` from /etc/os-release: "Ubuntu 24.04.1 LTS". */
  os: string | null;
  /** The kernel release: "6.8.0-45-generic". */
  kernel: string | null;
  arch: string | null;
  cpuModel: string | null;
  cpus: number | null;
  memoryBytes: number | null;
  /** The size of the filesystem holding the deploy root. */
  diskBytes: number | null;
  dockerVersion: string | null;
  composeVersion: string | null;
  /** The Node the CLI ran under, without the leading `v`. */
  nodeVersion: string | null;
}

/** The host reads, injectable so each can be made to fail on its own. */
export interface ServerProbes {
  hostname: () => string;
  release: () => string;
  arch: () => string;
  cpus: () => { model: string }[];
  totalmem: () => number;
  readFile: (path: string) => string;
  nodeVersion: () => string;
}

export interface ServerFactsOptions {
  runCommand: typeof runCommand;
  /** The deploy root; `df` is asked about the filesystem holding it. */
  root: string;
  probes?: Partial<ServerProbes> | undefined;
}

export const OS_RELEASE_PATH = '/etc/os-release';

const realProbes: ServerProbes = {
  hostname,
  release,
  arch,
  cpus,
  totalmem,
  readFile: (path) => readFileSync(path, 'utf8'),
  nodeVersion: () => process.version,
};

/** `PRETTY_NAME="Ubuntu 24.04.1 LTS"` → `Ubuntu 24.04.1 LTS`. */
export function parseOsRelease(contents: string): string | null {
  for (const line of contents.split('\n')) {
    const match = /^PRETTY_NAME=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const value = (match[1] as string).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    return value === '' ? null : value;
  }
  return null;
}

/** `Docker version 27.3.1, build 1234abc` → `27.3.1`. */
export function parseDockerVersion(output: string): string | null {
  const match = /version\s+v?(\d[\w.+-]*)/i.exec(output);
  return match === null ? null : (match[1] as string);
}

/** `v2.29.7` or `2.29.7` (from `docker compose version --short`) → `2.29.7`. */
export function parseComposeVersion(output: string): string | null {
  const match = /v?(\d+\.\d+[\w.+-]*)/.exec(output.trim());
  return match === null ? null : (match[1] as string);
}

function attempt<T>(probe: () => T): T | null {
  try {
    const value = probe();
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

async function attemptAsync<T>(probe: () => Promise<T>): Promise<T | null> {
  try {
    const value = await probe();
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

/** Runs one command for its stdout; a non-zero exit or a missing binary is `null`. */
async function output(
  options: ServerFactsOptions,
  argv: readonly string[],
): Promise<string | null> {
  return await attemptAsync(async () => {
    const result = await options.runCommand(argv, { cwd: options.root, timeoutMs: 30_000 });
    return result.stdout;
  });
}

export async function collectServerFacts(options: ServerFactsOptions): Promise<ServerFacts> {
  const probes: ServerProbes = { ...realProbes, ...(options.probes ?? {}) };

  const [df, docker, compose] = await Promise.all([
    output(options, ['df', '-Pk', options.root]),
    output(options, ['docker', '--version']),
    output(options, ['docker', 'compose', 'version', '--short']),
  ]);

  const cpuList = attempt(() => probes.cpus());

  return {
    hostname: attempt(() => nonEmpty(probes.hostname())),
    os: attempt(() => parseOsRelease(probes.readFile(OS_RELEASE_PATH))),
    kernel: attempt(() => nonEmpty(probes.release())),
    arch: attempt(() => nonEmpty(probes.arch())),
    cpuModel: cpuList === null ? null : nonEmpty(cpuList[0]?.model ?? ''),
    cpus: cpuList === null || cpuList.length === 0 ? null : cpuList.length,
    memoryBytes: attempt(() => positive(probes.totalmem())),
    diskBytes: df === null ? null : (parseDf(df)?.totalBytes ?? null),
    dockerVersion: docker === null ? null : parseDockerVersion(docker),
    composeVersion: compose === null ? null : parseComposeVersion(compose),
    nodeVersion: attempt(() => nonEmpty(probes.nodeVersion().replace(/^v/, ''))),
  };
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function positive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}
