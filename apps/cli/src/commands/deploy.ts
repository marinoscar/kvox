import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { CLI_NAME } from '../branding.js';
import {
  ALL_CHECKS,
  checksPassed,
  runChecks,
  summarise,
  type CheckContext,
  type CheckStatus,
  type CompletedCheck,
} from '../deploy/checks/index.js';
import { parseEnvFile } from '../deploy/env-spec.js';
import {
  collectHealth,
  isHealthy,
  type HealthReport,
  type ProbeResult,
} from '../deploy/health.js';
import { readState } from '../deploy/state.js';
import { runInstall, type InstallOptions } from '../deploy/install.js';
import { runUpdate, type UpdateOptions } from '../deploy/update.js';
import type { EnvGroup } from '../deploy/env-metadata.js';
import { runCommand } from '../deploy/executor.js';
import { CliError, EXIT, PreconditionError, UsageError, type ExitCode } from '../errors.js';
import { shouldUseColour } from '../output.js';

// =============================================================================
// `appctl deploy`  (issue #178, epic #168)
// =============================================================================
//
// The first user-facing surface of the deployment work, and the place the
// command GROUP is established - so the shape chosen here is the one every
// later subcommand follows.
//
// Two rules inherited from program.ts, neither negotiable here:
//
//   - HUMAN OUTPUT GOES TO STDERR. stdout carries `--json` and nothing else,
//     so `appctl deploy doctor --json | jq` is clean.
//   - FAILURE IS NON-ZERO. A doctor that prints failures and exits 0 makes
//     `doctor || provision-the-box` silently useless.
// =============================================================================

export const DEFAULT_DEPLOY_ROOT = '/opt/infra/apps';
export const DEFAULT_PROXY_ROOT = '/opt/infra/proxy';
export const DEFAULT_BIND_PORT = 3535;

const ESC = String.fromCharCode(27);
const RESET = ESC + '[0m';

export interface DoctorCommandOptions {
  root: string;
  proxyRoot: string;
  port: string;
  domain?: string | undefined;
  json?: boolean | undefined;
  color: boolean;
}

export interface DeployContext {
  /** Injected so tests drive the checks without a server. */
  checks?: readonly import('../deploy/checks/index.js').Check[] | undefined;
  runCommand?: typeof runCommand | undefined;
  stdout?: { write(chunk: string): unknown } | undefined;
  stderr?: { write(chunk: string): unknown } | undefined;
  isTty?: boolean | undefined;
  /** Injected so `status` can be tested without a running deployment. */
  fetch?: typeof globalThis.fetch | undefined;
}

export function registerDeployCommand(
  program: Command,
  ctx?: DeployContext,
): Command {
  const deploy = program
    .command('deploy')
    .description('Check, install and update this application on a server');

  deploy
    .command('doctor')
    .description('Check that this server meets the prerequisites')
    .option('--root <path>', 'Deployment directory', DEFAULT_DEPLOY_ROOT)
    .option('--proxy-root <path>', 'Shared reverse proxy directory', DEFAULT_PROXY_ROOT)
    .option('--port <port>', 'Loopback port the proxy forwards to', String(DEFAULT_BIND_PORT))
    .option('--domain <domain>', 'Public domain; enables the DNS and TLS checks')
    .option('--json', 'Print a machine-readable report on stdout')
    .option('--no-color', 'Disable colour even on a terminal')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy doctor`,
        `  ${CLI_NAME} deploy doctor --domain app.example.com`,
        `  ${CLI_NAME} deploy doctor --json | jq '.checks[] | select(.status=="fail")'`,
        '',
        'Exit codes:',
        '  0  every required check passed (warnings do not fail the run)',
        '  6  a required check failed; nothing was changed',
        '',
        'Nothing is installed, written or started. It is safe to run at any time.',
      ].join('\n'),
    )
    .action(async (options: DoctorCommandOptions) => {
      await runDoctorCommand(options, ctx);
    });

  deploy
    .command('install')
    .description('Install this application on this server')
    .option('--root <path>', 'Deployment directory', DEFAULT_DEPLOY_ROOT)
    .option('--domain <domain>', 'Public domain to publish under')
    .option('--proxy-root <path>', 'Shared reverse proxy directory', DEFAULT_PROXY_ROOT)
    .option('--port <port>', 'Loopback port the proxy forwards to', String(DEFAULT_BIND_PORT))
    .option('--repo <url>', 'Repository to deploy (default: this checkout\'s origin)')
    .option('--ref <ref>', 'Branch, tag or commit (default: the remote default branch)')
    .option('--email <email>', 'Certificate registration address')
    .option('--group <name>', 'Optional feature group; repeat for more', collectGroup, [])
    .option('--all', 'Review every environment variable, not only the essential ones')
    .option('--non-interactive', 'Never prompt; fail listing anything unresolved')
    .option('--reinstall', 'Install over an existing deployment')
    .option('--resume', 'Continue from the step that failed')
    .option('--skip-doctor', 'Skip the prerequisite checks')
    .option('--skip-proxy', 'Do not touch the reverse proxy or request a certificate')
    .option('--skip-seed', 'Do not run the database seed')
    .option('--no-cache', 'Rebuild images without the layer cache')
    .option('--force', 'Discard uncommitted changes in the checkout')
    .option('--staging', "Use Let's Encrypt staging while working out the setup")
    .option('--json', 'Print a machine-readable result on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy install --domain app.example.com`,
        `  ${CLI_NAME} deploy install --domain app.example.com --staging`,
        `  ${CLI_NAME} deploy install --non-interactive --domain app.example.com`,
        '',
        'What it does, in order: checks prerequisites, clones the repository,',
        'collects the environment, validates the database, builds the images,',
        'migrates, seeds, starts the stack, waits for health, issues the',
        'certificate and publishes the vhost, then verifies the result.',
        '',
        'The repository and branch come from THIS checkout\'s git remote unless',
        'you pass --repo/--ref, so a fork deploys itself with no configuration.',
      ].join('\n'),
    )
    .action(async (options: InstallCommandOptions) => {
      await runInstallCommand(options, ctx);
    });

  deploy
    .command('update')
    .description('Bring this server up to the latest revision')
    .option('--root <path>', 'Deployment directory', DEFAULT_DEPLOY_ROOT)
    .option('--ref <ref>', 'Branch, tag or commit to move to')
    .option('--force', 'Rebuild even when the revision has not changed')
    .option('--no-cache', 'Rebuild images without the layer cache')
    .option('--non-interactive', 'Never prompt; fail listing anything unresolved')
    .option('--skip-seed', 'Do not re-run the database seed')
    .option('--skip-proxy', 'Do not touch the reverse proxy')
    .option('--json', 'Print a machine-readable result on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy update`,
        `  ${CLI_NAME} deploy update --ref v1.4.0`,
        '',
        'Exits 0 without doing anything when the revision has not moved, so it',
        'is safe to run from cron.',
        '',
        'The seed RE-RUNS by default. It is idempotent, and it is the only way',
        'permissions added by a new release reach an existing deployment —',
        'without it the feature ships and the permission does not exist, which',
        'surfaces as a confusing 403. Pass --skip-seed to opt out.',
        '',
        'There is no automatic roll-back: a partly-applied migration cannot be',
        'undone by checking out the old code. On failure the previous revision',
        'and the command to redeploy it are printed.',
      ].join('\n'),
    )
    .action(async (options: UpdateCommandOptions) => {
      await runUpdateCommand(options, ctx);
    });

  deploy
    .command('status')
    .description('Report whether the deployment on this server is healthy')
    .option('--root <path>', 'Deployment directory', DEFAULT_DEPLOY_ROOT)
    .option('--port <port>', 'Loopback port the proxy forwards to', String(DEFAULT_BIND_PORT))
    .option('--domain <domain>', 'Public domain; adds an external HTTPS check')
    .option('--json', 'Print a machine-readable report on stdout')
    .option('--no-color', 'Disable colour even on a terminal')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy status`,
        `  ${CLI_NAME} deploy status --domain app.example.com`,
        `  ${CLI_NAME} deploy status --json || alert 'deployment unhealthy'`,
        '',
        'Exit codes:',
        '  0  serving, and the schema is current',
        '  1  installed but unhealthy',
        '  2  nothing is installed at --root',
        '',
        'Note that /api/health/ready only proves SELECT 1 succeeded, so it',
        'passes against an empty database. Migration state is reported',
        'separately, and a green probe alone is not treated as proof.',
      ].join('\n'),
    )
    .action(async (options: StatusCommandOptions) => {
      await runStatusCommand(options, ctx);
    });

  return deploy;
}

/** Display-safe by construction: no field can hold a secret. */
export interface DoctorReport {
  ok: boolean;
  checks: Array<{
    id: string;
    title: string;
    severity: 'required' | 'recommended';
    status: CheckStatus;
    detail: string;
    remedy?: string;
    durationMs: number;
  }>;
  summary: ReturnType<typeof summarise>;
}

export async function runDoctorCommand(
  options: DoctorCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const checks = ctx?.checks ?? ALL_CHECKS;
  const json = options.json === true;

  const context: CheckContext = {
    runCommand: ctx?.runCommand ?? runCommand,
    deployRoot: options.root,
    proxyRoot: options.proxyRoot,
    bindPort: Number(options.port),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(readEnvironment(options.root) ?? {}),
  };

  // Under --json nothing is written until the end: a partial checklist on
  // stderr is useless to a machine, and colour is never consulted at all so
  // no FORCE_COLOR can inject escapes into the pipe.
  const colour =
    !json &&
    shouldUseColour({
      // `--no-color` arrives as `color: false`, matching commander's handling
      // of a `--no-` flag; `requested` is undefined when the user said nothing.
      requested: options.color === false ? false : undefined,
      env: process.env,
      isTTY: ctx?.isTty ?? process.stderr.isTTY === true,
    });

  if (!json) stderr.write('\n  Prerequisites\n\n');

  const results = await runChecks(checks, context, (result) => {
    // Streamed as each completes: a dozen subprocess probes take long enough
    // that a silent terminal looks like a hang.
    if (!json) stderr.write(renderResult(result, colour));
  });

  const report = buildReport(results);

  if (json) {
    stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    stderr.write(renderSummary(report.summary, colour));
  }

  if (!report.ok) {
    const failed = results.filter(
      (result) => result.severity === 'required' && result.status === 'fail',
    );
    throw new PreconditionError(
      `${failed.length} required check(s) failed: ${failed.map((result) => result.id).join(', ')}`,
    );
  }
}

/** Reads the deployment's .env, when there is one, for the database checks. */
function readEnvironment(deployRoot: string): { env: Map<string, string> } | undefined {
  try {
    const contents = readFileSync(
      join(deployRoot, 'repo', 'infra', 'compose', '.env'),
      'utf8',
    );
    return { env: parseEnvFile(contents) };
  } catch {
    // Absent before a first install; the database checks then report `skip`.
    return undefined;
  }
}

export function buildReport(results: readonly CompletedCheck[]): DoctorReport {
  return {
    ok: checksPassed(results),
    checks: results.map((result) => ({
      id: result.id,
      title: result.title,
      severity: result.severity,
      status: result.status,
      detail: result.detail,
      ...(result.remedy === undefined ? {} : { remedy: result.remedy }),
      durationMs: result.durationMs,
    })),
    summary: summarise(results),
  };
}

const MARKS: Record<CheckStatus, string> = {
  pass: 'OK',
  warn: '!!',
  fail: 'XX',
  skip: '--',
};

const COLOURS: Record<CheckStatus, string> = {
  pass: '32',
  warn: '33',
  fail: '31',
  skip: '90',
};

const TITLE_WIDTH = 30;

/** Installed, reachable, and not working. Distinct from "not installed". */
export class DeploymentUnhealthyError extends CliError {
  readonly exitCode: ExitCode = EXIT.FAILURE;
}

/** One check, rendered. Exported for its test. */
export function renderResult(result: CompletedCheck, colour: boolean): string {
  // A GLYPH as well as a colour. These are read over SSH, piped into files,
  // and by people who cannot distinguish red from green; colour alone would
  // make the status invisible to all three.
  const mark = MARKS[result.status];
  const painted = colour ? `${ESC}[${COLOURS[result.status]}m${mark}${RESET}` : mark;

  const lines = [`  ${painted} ${result.title.padEnd(TITLE_WIDTH)}${result.detail}\n`];

  if (result.remedy !== undefined && (result.status === 'fail' || result.status === 'warn')) {
    // The arrow marks the remedy once; continuation lines are indented to
    // line up under it, so a wrapped sentence reads as one sentence rather
    // than as several separate instructions.
    wrap(result.remedy, 66).forEach((line, index) => {
      lines.push(`       ${index === 0 ? '->' : '  '} ${line}\n`);
    });
  }

  return lines.join('');
}

export function renderSummary(
  summary: ReturnType<typeof summarise>,
  colour: boolean,
): string {
  const parts = [`${summary.passed} passed`];
  if (summary.warned > 0) parts.unshift(`${summary.warned} warning(s)`);
  if (summary.failed > 0) parts.unshift(`${summary.failed} failed`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);

  const line = parts.join(', ');
  const painted =
    colour && summary.failed > 0 ? `${ESC}[31m${line}${RESET}` : line;

  return `\n  ${painted}\n\n`;
}

/** Wraps a remedy so it stays readable in an 80-column SSH session. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);

  return lines;
}


// ---------------------------------------------------------------------------
// `appctl deploy status`  (issue #183)
// ---------------------------------------------------------------------------

export interface StatusCommandOptions {
  root: string;
  port: string;
  domain?: string | undefined;
  json?: boolean | undefined;
  color: boolean;
}

export async function runStatusCommand(
  options: StatusCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  // "Nothing installed" is a USAGE problem, distinct from "installed and
  // unhealthy" - a monitoring script must be able to tell them apart.
  const state = readState(options.root);
  if (state === undefined) {
    throw new UsageError(
      `No deployment found at ${options.root}. Run \`${CLI_NAME} deploy install\` first, or pass --root.`,
    );
  }

  const report = await collectHealth({
    runCommand: ctx?.runCommand ?? runCommand,
    deployRoot: options.root,
    bindPort: Number(options.port),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    state,
    ...(ctx?.fetch === undefined ? {} : { fetch: ctx.fetch }),
  });

  const healthy = isHealthy(report);

  if (json) {
    stdout.write(`${JSON.stringify({ healthy, ...report })}\n`);
  } else {
    const colour = shouldUseColour({
      requested: options.color === false ? false : undefined,
      env: process.env,
      isTTY: ctx?.isTty ?? process.stderr.isTTY === true,
    });
    stderr.write(renderHealth(report, healthy, colour));
  }

  if (!healthy) {
    throw new DeploymentUnhealthyError(
      `The deployment at ${options.root} is not healthy.`,
    );
  }
}

function probeLine(label: string, result: ProbeResult): string {
  const outcome = result.ok
    ? `${result.status ?? 'ok'} (${result.durationMs}ms)`
    : (result.error ?? `HTTP ${result.status ?? '?'}`);
  return `  ${label.padEnd(TITLE_WIDTH)}${outcome}\n`;
}

/** The human report. Exported for its test. */
export function renderHealth(
  report: HealthReport,
  healthy: boolean,
  colour: boolean,
): string {
  const lines: string[] = ['\n  Deployment\n\n'];

  if (report.deployed !== undefined) {
    lines.push(`  ${'Revision'.padEnd(TITLE_WIDTH)}${report.deployed.commitSha.slice(0, 12)} (${report.deployed.ref})\n`);
    lines.push(`  ${'Last deployed'.padEnd(TITLE_WIDTH)}${report.deployed.lastDeployedAt} by ${report.deployed.lastCommand}\n`);
  }

  lines.push('\n  Containers\n\n');
  if (report.containers.length === 0) {
    lines.push('  none reported\n');
  } else {
    for (const container of report.containers) {
      const health = container.health === undefined ? '' : ` (${container.health})`;
      lines.push(`  ${container.service.padEnd(TITLE_WIDTH)}${container.state}${health}\n`);
    }
  }

  lines.push('\n  Probes\n\n');
  lines.push(probeLine('Liveness', report.local.live));
  lines.push(probeLine('Readiness', report.local.ready));
  lines.push(probeLine('Frontend', report.local.frontend));
  if (report.external !== undefined) {
    lines.push(probeLine('External HTTPS', report.external.probe));
  }

  lines.push('\n  Schema\n\n');
  if (!report.migrations.known) {
    lines.push(`  ${'Migrations'.padEnd(TITLE_WIDTH)}could not be determined\n`);
  } else if (report.migrations.pending.length > 0) {
    // Readiness can be green while this is red; that is the whole point of
    // reporting it separately.
    lines.push(`  ${'Migrations'.padEnd(TITLE_WIDTH)}${report.migrations.pending.length} pending\n`);
    for (const pending of report.migrations.pending) {
      lines.push(`       -> ${pending}\n`);
    }
  } else {
    lines.push(`  ${'Migrations'.padEnd(TITLE_WIDTH)}up to date\n`);
  }

  const verdict = healthy ? 'healthy' : 'NOT healthy';
  const painted = colour && !healthy ? `${ESC}[31m${verdict}${RESET}` : verdict;
  lines.push(`\n  ${painted}\n\n`);

  return lines.join('');
}


// ---------------------------------------------------------------------------
// `appctl deploy install`  (issue #180)
// ---------------------------------------------------------------------------

function collectGroup(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export interface InstallCommandOptions {
  root: string;
  domain?: string | undefined;
  proxyRoot: string;
  port: string;
  repo?: string | undefined;
  ref?: string | undefined;
  email?: string | undefined;
  group: string[];
  all?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  reinstall?: boolean | undefined;
  resume?: boolean | undefined;
  skipDoctor?: boolean | undefined;
  skipProxy?: boolean | undefined;
  skipSeed?: boolean | undefined;
  cache: boolean;
  force?: boolean | undefined;
  staging?: boolean | undefined;
  json?: boolean | undefined;
}

export async function runInstallCommand(
  options: InstallCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  const installOptions: InstallOptions = {
    deployRoot: options.root,
    bindPort: Number(options.port),
    proxyRoot: options.proxyRoot,
    groups: options.group as EnvGroup[],
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.email === undefined ? {} : { email: options.email }),
    ...(options.all === undefined ? {} : { all: options.all }),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.reinstall === undefined ? {} : { reinstall: options.reinstall }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.skipDoctor === undefined ? {} : { skipDoctor: options.skipDoctor }),
    ...(options.skipProxy === undefined ? {} : { skipProxy: options.skipProxy }),
    ...(options.skipSeed === undefined ? {} : { skipSeed: options.skipSeed }),
    ...(options.cache === false ? { noCache: true } : {}),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.staging === undefined ? {} : { staging: options.staging }),
    ...(ctx?.runCommand === undefined ? {} : { runCommand: ctx.runCommand }),
    // Rendered as lines on stderr here; #184's screen renders the identical
    // callbacks as React state. One implementation, two renderers.
    ...(json
      ? {}
      : {
          hooks: {
            onStepStart: ({ title, index, total }) =>
              void stderr.write(`\n  [${index + 1}/${total}] ${title}\n`),
            onStepResult: (result) =>
              void stderr.write(
                result.outcome === 'ok'
                  ? `  done (${result.durationMs}ms)\n`
                  : `  ${result.outcome}: ${result.detail ?? ''}\n`,
              ),
            onProgress: (message) => void stderr.write(`  ${message}\n`),
            onLog: (line) => void stderr.write(`    ${line}\n`),
          },
        }),
  };

  const result = await runInstall(installOptions);

  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  stderr.write(
    [
      '',
      '  Installed.',
      '',
      `  Revision   ${result.commitSha.slice(0, 12)}`,
      `  Log        ${result.journalPath}`,
      '',
      `  ${result.nextStep}`,
      '',
    ].join('\n'),
  );
}


// ---------------------------------------------------------------------------
// `appctl deploy update`  (issue #182)
// ---------------------------------------------------------------------------

export interface UpdateCommandOptions {
  root: string;
  ref?: string | undefined;
  force?: boolean | undefined;
  cache: boolean;
  nonInteractive?: boolean | undefined;
  skipSeed?: boolean | undefined;
  skipProxy?: boolean | undefined;
  json?: boolean | undefined;
}

export async function runUpdateCommand(
  options: UpdateCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  const updateOptions: UpdateOptions = {
    deployRoot: options.root,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.cache === false ? { noCache: true } : {}),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.skipSeed === undefined ? {} : { skipSeed: options.skipSeed }),
    ...(options.skipProxy === undefined ? {} : { skipProxy: options.skipProxy }),
    ...(ctx?.runCommand === undefined ? {} : { runCommand: ctx.runCommand }),
    ...(json
      ? {}
      : {
          hooks: {
            onStepStart: ({ title, index, total }) =>
              void stderr.write(`\n  [${index + 1}/${total}] ${title}\n`),
            onStepResult: (result) =>
              void stderr.write(
                result.outcome === 'ok'
                  ? `  done (${result.durationMs}ms)\n`
                  : `  ${result.outcome}: ${result.detail ?? ''}\n`,
              ),
            onProgress: (message) => void stderr.write(`  ${message}\n`),
            onLog: (line) => void stderr.write(`    ${line}\n`),
          },
        }),
  };

  const result = await runUpdate(updateOptions);

  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (!result.changed) {
    stderr.write(`\n  Already at ${result.commitSha.slice(0, 12)}. Nothing to do.\n\n`);
    return;
  }

  stderr.write(
    [
      '',
      '  Updated.',
      '',
      `  ${(result.previousSha ?? 'unknown').slice(0, 12)} -> ${result.commitSha.slice(0, 12)}`,
      `  Took       ${Math.round(result.durationMs / 1000)}s`,
      `  Log        ${result.journalPath}`,
      '',
    ].join('\n'),
  );
}
