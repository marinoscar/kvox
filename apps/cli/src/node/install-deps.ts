import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

import { CLI_NAME } from '../branding.js';
import { binaryCapability, isWritable, probeCapabilities } from './capabilities.js';

// =============================================================================
// `node install-deps` — a framework, deliberately  (issue #276, epic #254)
// =============================================================================
//
// ⚠ THIS WAS THE ONE PLACE IN EPIC #254 WHERE FULL PARITY WAS KNOWINGLY
// REDUCED, and the reason was that the parity target was entirely
// domain-specific: the application this design comes from installs ffmpeg, OCR
// language data, ML models and a face-detection sidecar, and inventing
// equivalents would have been inventing dependencies a template did not have.
//
// Issue #26 gave it a REAL one. `media.audio.transcode` needs `ffmpeg` (which
// ships `ffprobe`) on any node that claims it, and a node running outside a
// container has no image to have baked it in — so `ffmpeg` below is the worked
// example of a genuine package step, and the thing a fork copies rather than a
// structure a fork has to imagine filling.
//
// What ships is still, first, the STRUCTURE: ordered steps, a per-step outcome of
// `skipped | installed | failed | unsupported`, distro detection, an explicit
// sudo announcement, and `--dry-run`. A fork fills in its own steps, and the
// README documents that as the extension point.
//
// SUDO IS ANNOUNCED, NEVER SILENT. A command that quietly escalates is a
// command people stop trusting; the plan says which steps need it before any
// of them run.
// =============================================================================

export type StepOutcome = 'skipped' | 'installed' | 'failed' | 'unsupported';

export interface DistroInfo {
  /** `ubuntu`, `debian`, `alpine`, `darwin`, `win32`, or `unknown`. */
  id: string;
  versionId: string | undefined;
  family: 'debian' | 'rhel' | 'alpine' | 'darwin' | 'windows' | 'unknown';
}

export interface InstallContext {
  distro: DistroInfo;
  dryRun: boolean;
  stateDir: string;
  run: (command: string, args: string[]) => void;
  log: (message: string) => void;
}

export interface InstallStep {
  id: string;
  label: string;
  /** Escalation is declared up front so the plan can announce it. */
  requiresSudo?: boolean | undefined;
  /** Can this step run at all here? Returning false yields `unsupported`. */
  supported(context: InstallContext): boolean;
  /** Already satisfied? Returning true yields `skipped`. */
  detect(context: InstallContext): boolean;
  install(context: InstallContext): void;
}

export interface StepResult {
  id: string;
  label: string;
  outcome: StepOutcome;
  detail?: string | undefined;
}

/**
 * Read `/etc/os-release`, falling back to the platform.
 *
 * Best effort by construction: a distro nobody anticipated yields `unknown`,
 * and every step that cares reports `unsupported` rather than guessing a
 * package manager and running it.
 */
export function detectDistro(options?: { platform?: NodeJS.Platform | undefined; osRelease?: string | undefined }): DistroInfo {
  const plat = options?.platform ?? process.platform;
  if (plat === 'win32') return { id: 'win32', versionId: undefined, family: 'windows' };
  if (plat === 'darwin') return { id: 'darwin', versionId: undefined, family: 'darwin' };

  let content = options?.osRelease;
  if (content === undefined) {
    try {
      content = readFileSync('/etc/os-release', 'utf8');
    } catch {
      return { id: 'unknown', versionId: undefined, family: 'unknown' };
    }
  }

  const fields = new Map<string, string>();
  for (const line of content.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) fields.set(match[1], (match[2] ?? '').replace(/^"|"$/g, ''));
  }

  const id = fields.get('ID') ?? 'unknown';
  const like = fields.get('ID_LIKE') ?? '';
  const haystack = `${id} ${like}`;

  const family: DistroInfo['family'] = /debian|ubuntu/.test(haystack)
    ? 'debian'
    : /rhel|fedora|centos/.test(haystack)
      ? 'rhel'
      : /alpine/.test(haystack)
        ? 'alpine'
        : 'unknown';

  return { id, versionId: fields.get('VERSION_ID'), family };
}

/**
 * The steps this template ships.
 *
 * Both are generic and both are real — they are the two things every worker
 * needs regardless of what it computes. A fork appends beside them.
 */
/**
 * Package name for ffmpeg, per distribution family.
 *
 * The same on all three that package it, which is worth stating rather than
 * leaving as a coincidence: the step below is still written as a lookup so a
 * family whose name differs is one entry rather than a rewritten `install`.
 */
const FFMPEG_PACKAGES: Partial<Record<DistroInfo['family'], { command: string; args: string[] }>> = {
  debian: { command: 'apt-get', args: ['install', '-y', 'ffmpeg'] },
  rhel: { command: 'dnf', args: ['install', '-y', 'ffmpeg'] },
  alpine: { command: 'apk', args: ['add', '--no-cache', 'ffmpeg'] },
};

export const DEFAULT_INSTALL_STEPS: InstallStep[] = [
  {
    id: 'state-dir',
    label: 'Worker state directory',
    supported: () => true,
    detect: (context) => isWritable(context.stateDir),
    install: (context) => {
      if (context.dryRun) return;
      mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
    },
  },
  {
    id: 'node-runtime',
    label: 'Node.js 20 or newer',
    supported: () => true,
    detect: () => {
      const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
      return major >= 20;
    },
    install: () => {
      // Deliberately NOT automated. Replacing the runtime out from under a
      // process that is currently running on it is not something a subcommand
      // should do unannounced, and every platform has its own right answer.
      throw new Error(
        `This ${CLI_NAME} needs Node.js 20 or newer; ${process.versions.node} is installed. Upgrade Node, then re-run.`,
      );
    },
  },
  {
    // -------------------------------------------------------------------------
    // ffmpeg — for `media.audio.transcode` (#26, epic #19)
    // -------------------------------------------------------------------------
    //
    // ⚠ INSTALLED UNCONDITIONALLY RATHER THAN "ONLY IF THIS NODE DECLARES THE
    // TYPE", and the ordering is why: `install-deps` is what an operator runs
    // BEFORE the worker has ever started, so there is no `--types` to consult
    // and no config file to read. A step that tried would either skip the
    // install on a fresh machine (the case it exists for) or need the worker
    // running first, which is the thing it is preparing for.
    //
    // It is `skipped` the moment both binaries are on PATH, so on a machine
    // that will never run this type the cost is one `which` per binary.
    //
    // NOT AUTOMATED ON macOS OR WINDOWS: `brew`/`winget` install into a user's
    // own environment and frequently need a licence prompt or a cask, which a
    // subcommand must not answer on somebody's behalf. Those report
    // `unsupported` with the one-line command to run.
    id: 'ffmpeg',
    label: 'ffmpeg and ffprobe (media.audio.transcode)',
    requiresSudo: true,
    supported: (context) => FFMPEG_PACKAGES[context.distro.family] !== undefined,
    detect: () => {
      const probe = probeCapabilities({ binaries: ['ffmpeg', 'ffprobe'] });
      const satisfied = new Set(probe.capabilities);

      // BOTH, not either: the executor runs them as two programs, and a build
      // with only `ffmpeg` fails every job at the probe step.
      return (
        satisfied.has(binaryCapability('ffmpeg')) && satisfied.has(binaryCapability('ffprobe'))
      );
    },
    install: (context) => {
      const pkg = FFMPEG_PACKAGES[context.distro.family];

      if (pkg === undefined) {
        throw new Error(
          `No ffmpeg package is known for "${context.distro.id}". Install ffmpeg by hand, then re-run.`,
        );
      }

      if (context.dryRun) {
        context.log(`Would run: sudo ${pkg.command} ${pkg.args.join(' ')}`);

        return;
      }

      context.run(pkg.command, pkg.args);
    },
  },
];

export interface InstallDepsOptions {
  stateDir: string;
  steps?: InstallStep[] | undefined;
  dryRun?: boolean | undefined;
  distro?: DistroInfo | undefined;
  run?: ((command: string, args: string[]) => void) | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface InstallDepsReport {
  distro: DistroInfo;
  dryRun: boolean;
  results: StepResult[];
  /** True when nothing failed. `unsupported` is not a failure. */
  ok: boolean;
}

/**
 * Run (or plan) the steps in order.
 *
 * `--dry-run` PERFORMS NO MUTATION: `detect` still runs (it is read-only and
 * is what makes the plan accurate), `install` does not.
 */
export function runInstallDeps(options: InstallDepsOptions): InstallDepsReport {
  const steps = options.steps ?? DEFAULT_INSTALL_STEPS;
  const dryRun = options.dryRun === true;
  const log = options.log ?? (() => {});
  const distro = options.distro ?? detectDistro();

  const context: InstallContext = {
    distro,
    dryRun,
    stateDir: options.stateDir,
    run:
      options.run ??
      ((command, args) => {
        execFileSync(command, args, { stdio: 'inherit' });
      }),
    log,
  };

  const escalating = steps.filter((step) => step.requiresSudo === true);
  if (escalating.length > 0) {
    log(
      `These steps need sudo: ${escalating.map((step) => step.id).join(', ')}. ` +
        'You will be prompted for your password.',
    );
  }

  const results: StepResult[] = [];

  for (const step of steps) {
    if (!step.supported(context)) {
      results.push({ id: step.id, label: step.label, outcome: 'unsupported', detail: `Not supported on ${distro.id}` });
      continue;
    }

    let satisfied: boolean;
    try {
      satisfied = step.detect(context);
    } catch (error) {
      results.push({ id: step.id, label: step.label, outcome: 'failed', detail: messageOf(error) });
      continue;
    }

    if (satisfied) {
      results.push({ id: step.id, label: step.label, outcome: 'skipped', detail: 'Already satisfied' });
      continue;
    }

    if (dryRun) {
      results.push({ id: step.id, label: step.label, outcome: 'installed', detail: 'Would install (dry run)' });
      continue;
    }

    try {
      step.install(context);
      results.push({ id: step.id, label: step.label, outcome: 'installed' });
    } catch (error) {
      results.push({ id: step.id, label: step.label, outcome: 'failed', detail: messageOf(error) });
    }
  }

  return { distro, dryRun, results, ok: results.every((result) => result.outcome !== 'failed') };
}

export function formatInstallReport(report: InstallDepsReport): string {
  const lines = [`Detected ${report.distro.id}${report.distro.versionId === undefined ? '' : ` ${report.distro.versionId}`} (${report.distro.family})`];
  if (report.dryRun) lines.push('Dry run — nothing was changed.');
  lines.push('');
  for (const result of report.results) {
    lines.push(`  ${result.outcome.padEnd(11)} ${result.label}${result.detail === undefined ? '' : ` — ${result.detail}`}`);
  }
  return `${lines.join('\n')}\n`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
