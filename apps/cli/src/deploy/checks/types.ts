import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { totalmem } from 'node:os';

import { CLI_NAME } from '../../branding.js';
import type { runCommand } from '../executor.js';

// =============================================================================
// The doctor check contract  (issue #176, epic #168)
// =============================================================================
//
// A VPS deployment has prerequisites. When one is missing, the failure surfaces
// halfway through an install - after the repository is cloned and possibly
// after .env is written - as an error from a tool the operator was not
// expecting to run. The whole point of `doctor` is to ask "is this server
// ready?" BEFORE anything is changed, and get back a list of what to fix.
//
// FOUR RULES THAT MAKE THIS WORTH HAVING:
//
//   1. A CHECK NEVER THROWS. A crashed probe becomes a `fail` carrying the
//      error's message. One broken check must not abort the run: the operator
//      wants the whole list, not the first problem.
//   2. `remedy` IS MANDATORY ON `fail`, and must name a command or a path.
//      "Install Docker" is not a remedy. There is a test asserting every check
//      in the registry produces one, so a new check cannot be added without it.
//   3. `required` vs `recommended` decides the EXIT CODE, not the display.
//      Both are shown; only a failed required check makes doctor exit non-zero.
//      Failing on advice is how people learn to pass --force, and then the
//      required checks stop being enforced too.
//   4. CHECKS ARE READ-ONLY. Doctor never installs, never writes, never starts
//      anything. That is what makes it safe to run against a production server
//      at any time, and it must stay true.
// =============================================================================

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  status: CheckStatus;
  /** One line: what was found. "Docker 27.3.1", or "not installed". */
  detail: string;
  /** Shown on warn/fail. A command or a path, never a category. */
  remedy?: string | undefined;
}

/** Filesystem probes, injectable so checks are testable without a real server. */
export interface CheckFs {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  isWritable(path: string): boolean;
  /** File contents, or undefined when unreadable. Optional so older fakes still type. */
  readFile?(path: string): string | undefined;
  /** Directory entries (names only), or undefined when unreadable. */
  readDir?(path: string): readonly string[] | undefined;
}

export const realFs: CheckFs = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  readDir(path) {
    try {
      return readdirSync(path);
    } catch {
      return undefined;
    }
  },
  exists(path) {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  isWritable(path) {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * True when nothing is listening on the loopback address for `port`.
 *
 * Binding is used rather than parsing `ss` output: it needs no external tool,
 * it cannot be confused by a different output format, and it answers the
 * question that actually matters - can this deployment take the port.
 */
export async function isLoopbackPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** True when something answers on `port` of any interface. */
export async function isPortListening(port: number): Promise<boolean> {
  return !(await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  }));
}

export interface CheckContext {
  runCommand: typeof runCommand;
  /** Where the deployment lives, or will. */
  deployRoot: string;
  /**
   * The compose project name (#119), so a check can tell the app's OWN
   * containers (`<name>-nginx-1`) from somebody else's. Absent before a first
   * install when no name has been chosen yet, in which case there is nothing
   * of the app's to recognise.
   */
  name?: string | undefined;
  /** Loopback port the shared proxy forwards to. */
  bindPort: number;
  /** The shared reverse proxy's directory. */
  proxyRoot: string;
  /** Public hostname, when one is known. DNS and TLS checks need it. */
  domain?: string | undefined;
  /** The resolved environment, when one exists. Database checks need it. */
  env?: ReadonlyMap<string, string> | undefined;
  fs?: CheckFs | undefined;
  totalMemoryBytes?: (() => number) | undefined;
  portFree?: ((port: number) => Promise<boolean>) | undefined;
  portListening?: ((port: number) => Promise<boolean>) | undefined;
  /** Resolves DNS; injected so the DNS checks (#177) are testable. */
  resolveHost?: ((hostname: string) => Promise<string[]>) | undefined;
  /** This host's own public addresses, when they can be determined. */
  ownAddresses?: (() => Promise<string[]>) | undefined;

  // ---- Doctor v2 (issue #122, epic #118) ------------------------------------

  /** The repository being deployed, when known. `gh-repo-access` needs it. */
  repoUrl?: string | undefined;
  /**
   * The shared proxy's container name. Given by `--proxy-container` or state,
   * otherwise WRITTEN by `proxy-container` once it has found one, so the
   * checks after it (and the publisher, #125) address the same container.
   */
  proxyContainer?: string | undefined;
  /** Written by `proxy-ipv6`: whether the vhost may bind `[::]` (#125 reads it). */
  ipv6?: boolean | undefined;
  /**
   * This host's public address as stated by the operator (`--public-ip`).
   * Behind NAT the interfaces carry a private address, and an external echo
   * service is deliberately not consulted (see dns.ts); this is the override.
   */
  publicIp?: string | undefined;
  /** `--skip-proxy`: proxy, certificate, port and DNS checks report `skip`. */
  skipProxy?: boolean | undefined;
  /** `--skip-dns`: the `dns-*` checks report `skip`. */
  skipDns?: boolean | undefined;
  /** `--skip-github`: the `gh-*` checks report `skip` (CI's `file://` remote). */
  skipGithub?: boolean | undefined;
}

/**
 * The `skip` a proxy-related check answers under `--skip-proxy`, or undefined.
 *
 * One helper rather than a condition in each check, so every check names the
 * flag the same way and none of them forgets to.
 */
export function skippedByProxyFlag(context: CheckContext): CheckResult | undefined {
  return context.skipProxy === true ? { status: 'skip', detail: '--skip-proxy' } : undefined;
}

export interface Check {
  /** Stable, kebab-case. Used by --json and by tests. */
  id: string;
  title: string;
  severity: 'required' | 'recommended';
  /** Ids that must pass first; otherwise this reports `skip`. */
  requires?: readonly string[] | undefined;
  run(context: CheckContext): Promise<CheckResult>;
}

export interface CompletedCheck extends CheckResult {
  id: string;
  title: string;
  severity: 'required' | 'recommended';
  durationMs: number;
}

export function contextFs(context: CheckContext): CheckFs {
  return context.fs ?? realFs;
}

export function contextMemory(context: CheckContext): number {
  return (context.totalMemoryBytes ?? totalmem)();
}

export function contextPortFree(context: CheckContext): (port: number) => Promise<boolean> {
  return context.portFree ?? isLoopbackPortFree;
}

export function contextPortListening(
  context: CheckContext,
): (port: number) => Promise<boolean> {
  return context.portListening ?? isPortListening;
}

/**
 * Runs the registry in order, honouring `requires`.
 *
 * A check that throws is reported as a failure and the run continues - rule 1.
 * `onResult` fires as each completes so a command can stream a checklist
 * rather than appearing to hang through a dozen subprocess calls.
 */
export async function runChecks(
  checks: readonly Check[],
  context: CheckContext,
  onResult?: (result: CompletedCheck) => void,
): Promise<CompletedCheck[]> {
  const results: CompletedCheck[] = [];
  const byId = new Map<string, CompletedCheck>();

  for (const check of checks) {
    const startedAt = Date.now();

    const unmet = (check.requires ?? []).filter(
      (id) => byId.get(id)?.status !== 'pass',
    );
    // A prerequisite that was itself SKIPPED (--skip-proxy, no domain given)
    // hands its reason down, so a flag reads the same on every check it
    // silences. A prerequisite that FAILED is named instead.
    const inherited = unmet.every((id) => byId.get(id)?.status === 'skip')
      ? byId.get(unmet[0] ?? '')?.detail
      : undefined;

    const result: CheckResult =
      unmet.length > 0
        ? {
            status: 'skip',
            // Named, so a wall of skips explains itself rather than looking
            // like the checks silently did nothing.
            detail: inherited ?? `skipped: ${unmet.join(', ')} did not pass`,
          }
        : await check.run(context).catch((error: unknown) => ({
            status: 'fail' as const,
            detail: error instanceof Error ? error.message : String(error),
            remedy: `This check itself failed; the problem may be with ${CLI_NAME}.`,
          }));

    const completed: CompletedCheck = {
      ...result,
      id: check.id,
      title: check.title,
      severity: check.severity,
      durationMs: Date.now() - startedAt,
    };

    results.push(completed);
    byId.set(check.id, completed);
    onResult?.(completed);
  }

  return results;
}

/** True when every required check passed. Warnings do not fail a run. */
export function checksPassed(results: readonly CompletedCheck[]): boolean {
  return !results.some(
    (result) => result.severity === 'required' && result.status === 'fail',
  );
}

export interface CheckSummary {
  passed: number;
  warned: number;
  failed: number;
  skipped: number;
}

export function summarise(results: readonly CompletedCheck[]): CheckSummary {
  return {
    passed: results.filter((result) => result.status === 'pass').length,
    warned: results.filter((result) => result.status === 'warn').length,
    failed: results.filter((result) => result.status === 'fail').length,
    skipped: results.filter((result) => result.status === 'skip').length,
  };
}
