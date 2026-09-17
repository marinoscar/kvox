import { readFileSync } from 'node:fs';

import { Option, type Command } from 'commander';

import { CLI_NAME, envVar } from '../branding.js';
import {
  ALL_CHECKS,
  DEFAULT_PROXY_CONTAINER,
  checksPassed,
  runChecks,
  summarise,
  type CheckContext,
  type CheckStatus,
  type CompletedCheck,
} from '../deploy/checks/index.js';
import { collectAbout, renderAbout, type AboutReport } from '../deploy/about.js';
import { updateDeployInfoRemote, type DeployRemote } from '../deploy/deploy-info.js';
import { readEnvFile } from '../deploy/env-file.js';
import { metadataFor } from '../deploy/env-metadata.js';
import { parseEnvFile } from '../deploy/env-spec.js';
import {
  collectHealth,
  isHealthy,
  type HealthReport,
  type ProbeResult,
} from '../deploy/health.js';
import { readState, type DeployState } from '../deploy/state.js';
import { resolveRepoTarget } from '../deploy/repo.js';
import { runInstall, type InstallOptions } from '../deploy/install.js';
import {
  DEFAULT_APPS_ROOT,
  DEFAULT_BIND_PORT,
  DEFAULT_PROXY_ROOT,
  locateApp,
  locateInstalledApp,
  type ResolvedLayout,
} from '../deploy/layout.js';
import {
  certificateExpiry,
  defaultCliPath,
  installRenewalCron,
  listCertificates,
  renewCertificates,
  renewalCronPath,
  type CertificateExpiry,
} from '../deploy/proxy.js';
import {
  checkForUpdate,
  remoteFromCheck,
  runUpdate,
  type UpdateOptions,
} from '../deploy/update.js';
import type { EnvGroup } from '../deploy/env-metadata.js';
import { runCommand } from '../deploy/executor.js';
import { CliError, EXIT, PreconditionError, UsageError, type ExitCode } from '../errors.js';
import { shouldUseColour } from '../output.js';

// =============================================================================
// `kvox deploy`  (issue #178, epic #168)
// =============================================================================
//
// The first user-facing surface of the deployment work, and the place the
// command GROUP is established - so the shape chosen here is the one every
// later subcommand follows.
//
// Two rules inherited from program.ts, neither negotiable here:
//
//   - HUMAN OUTPUT GOES TO STDERR. stdout carries `--json` and nothing else,
//     so `kvox deploy doctor --json | jq` is clean.
//   - FAILURE IS NON-ZERO. A doctor that prints failures and exits 0 makes
//     `doctor || provision-the-box` silently useless.
// =============================================================================

export { DEFAULT_APPS_ROOT, DEFAULT_BIND_PORT, DEFAULT_PROXY_ROOT };

/**
 * `--public-ip` from the environment (issue #122). Built through envVar() so
 * a rename of the CLI renames it; see the env-prefix guard.
 */
export const PUBLIC_IP_ENV_VAR = envVar('PUBLIC_IP');

const ESC = String.fromCharCode(27);
const RESET = ESC + '[0m';

/**
 * The three flags every subcommand takes to say WHICH app (#119).
 *
 * `--root` has no default any more: the deploy root is `<apps-root>/<name>`,
 * and `--root` is the escape hatch that names the full path outright.
 */
export interface LayoutCommandOptions {
  appsRoot: string;
  name?: string | undefined;
  root?: string | undefined;
}

function withLayoutOptions(command: Command): Command {
  return command
    .option('--apps-root <dir>', 'Directory that holds one folder per app', DEFAULT_APPS_ROOT)
    .option('--name <app>', 'App folder and compose project name')
    .option('--root <dir>', 'Deployment directory, overriding --apps-root/--name');
}

export interface DoctorCommandOptions extends LayoutCommandOptions {
  proxyRoot: string;
  port: string;
  domain?: string | undefined;
  proxyContainer?: string | undefined;
  publicIp?: string | undefined;
  skipProxy?: boolean | undefined;
  skipGithub?: boolean | undefined;
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
  /** Where doctor looks for a checkout to name the repository; tests point it away. */
  cwd?: string | undefined;
  /** Injected so the install flags can be tested without running a pipeline. */
  install?: typeof runInstall | undefined;
  /** Where `--install-cron` writes; default /etc/cron.d, tests point it away. */
  cronDir?: string | undefined;
  /** The command the renewal cron runs; default this binary. */
  cliPath?: string | undefined;
  /**
   * Injected so `about` reads a test's config rather than the developer's own
   * `~/.<cli>/config.json` - which would otherwise decide, machine by machine,
   * whether the API block is attempted at all.
   */
  configContext?: import('../config.js').ConfigContext | undefined;
}

export function registerDeployCommand(
  program: Command,
  ctx?: DeployContext,
): Command {
  const deploy = program
    .command('deploy')
    .description('Check, install and update this application on a server');

  withLayoutOptions(
    deploy.command('doctor').description('Check that this server meets the prerequisites'),
  )
    .option('--proxy-root <path>', 'Shared reverse proxy directory', DEFAULT_PROXY_ROOT)
    .option('--port <port>', 'Loopback port the proxy forwards to', String(DEFAULT_BIND_PORT))
    .option('--domain <domain>', 'Public domain; enables the DNS and TLS checks')
    .option('--proxy-container <name>', 'Verify this proxy container instead of finding one')
    .addOption(
      new Option('--public-ip <ip>', "This server's public address, for the DNS check behind NAT")
        .env(PUBLIC_IP_ENV_VAR),
    )
    .option('--skip-proxy', 'Skip the proxy, certificate, port and DNS checks')
    .option('--skip-github', 'Skip the GitHub CLI checks (a non-GitHub remote)')
    .option('--json', 'Print a machine-readable report on stdout')
    .option('--no-color', 'Disable colour even on a terminal')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy doctor`,
        `  ${CLI_NAME} deploy doctor --domain app.example.com`,
        `  ${CLI_NAME} deploy doctor --domain app.example.com --public-ip 203.0.113.10`,
        `  ${CLI_NAME} deploy doctor --skip-proxy`,
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

  withLayoutOptions(
    deploy.command('install').description('Install this application on this server'),
  )
    .option('--domain <domain>', 'Public domain to publish under')
    .option('--proxy-root <path>', 'Shared reverse proxy directory', DEFAULT_PROXY_ROOT)
    // No default: the wizard suggests the first free port from 3535 that no
    // other app under --apps-root has recorded (#127). Given, it is an answer.
    .option('--port <port>', `Loopback port the proxy forwards to (default: suggested, from ${DEFAULT_BIND_PORT})`)
    .option('--repo <url>', 'Repository to deploy (default: this checkout\'s origin)')
    .option('--ref <ref>', 'Branch, tag or commit (default: the remote default branch)')
    .option('--email <email>', 'Certificate registration address')
    .option('--group <name>', 'Optional feature group; repeat for more', collectGroup, [])
    .option('--all', 'Review every environment variable, not only the essential ones')
    .option('--non-interactive', 'Never prompt; fail listing anything unresolved')
    .option('--answer <KEY=VALUE>', 'Supply one environment value without a prompt; repeat for more', collectAnswer, [])
    .option('--answers-file <path>', 'Supply environment values from a .env-format file')
    .option('--reinstall', 'Install over an existing deployment')
    .option('--resume', 'Continue from the step that failed')
    .option('--skip-doctor', 'Skip the prerequisite checks')
    .option('--skip-proxy', 'Do not touch the reverse proxy or request a certificate')
    .option('--skip-seed', 'Do not run the database seed')
    .option('--create-database', 'Create the PostgreSQL database when it does not exist')
    .option('--skip-github', 'Never consult the GitHub CLI, even for a GitHub remote')
    .option('--no-cache', 'Rebuild images without the layer cache')
    .option('--force', 'Discard uncommitted changes in the checkout')
    .option('--staging', "Use Let's Encrypt staging while working out the setup")
    .option('--proxy-container <name>', 'Publish through this proxy container instead of finding one')
    .option('--no-ipv6', 'Render the vhost without [::] listeners (a host with IPv6 disabled)')
    // `--install-cron` is declared BEFORE `--no-install-cron` on purpose:
    // commander then leaves the default undefined, which is the third state
    // ("when a certificate was issued") rather than a plain boolean.
    .option('--install-cron', 'Write the certificate renewal cron even if no certificate was issued')
    .option('--no-install-cron', 'Never write the renewal cron')
    .option('--json', 'Print a machine-readable result on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy install --domain app.example.com`,
        `  ${CLI_NAME} deploy install --domain app.example.com --staging`,
        `  ${CLI_NAME} deploy install --non-interactive --domain app.example.com`,
        `  ${CLI_NAME} deploy install --non-interactive --answers-file answers.env`,
        `  ${CLI_NAME} deploy install --domain app.example.com --no-ipv6`,
        '',
        'The environment is collected in steps - domain, database, secrets,',
        'OAuth, admin, resources - and each is verified before the next: the',
        'DNS record when the domain is typed, the connection and credentials',
        'when the database is. Secrets are generated; the port, worker slots and',
        'memory limits are suggested from this server with their reason.',
        '',
        '--answer and --answers-file seed values without a prompt. With',
        '--non-interactive, a file holding the domain (APP_DOMAIN), the',
        'database, the OAuth client and the admin email is enough: every secret',
        'is generated and every resource suggested.',
        '',
        'What it does, in order: checks prerequisites, ensures the devnet',
        'network, authenticates git through the GitHub CLI, clones the',
        'repository, collects the environment, validates the database, builds',
        'the images, migrates, seeds, starts the stack, waits for health, proves',
        'the domain routes here, issues the certificate, publishes the vhost',
        'through the shared proxy container, then verifies the result.',
        '',
        'A GitHub remote is cloned over HTTPS with the token `gh auth login`',
        'stored (`gh auth setup-git` is run for you); ssh and git@ remotes are',
        'rewritten to HTTPS. A remote that is not on GitHub uses plain git.',
        '',
        'The certificate is issued with `docker run certbot/certbot`, and the',
        'proxy is validated and reloaded with `docker exec`; there is no host',
        'nginx or certbot. When a certificate is issued, a renewal cron is',
        `written to ${renewalCronPath('<name>')} unless --no-install-cron.`,
        '',
        'The repository and branch come from THIS checkout\'s git remote unless',
        'you pass --repo/--ref, so a fork deploys itself with no configuration.',
        '',
        'Everything lands under <apps-root>/<name>/, where <name> defaults to the',
        'repository\'s own name and is also the compose project name, so two',
        'apps on one server never share containers.',
      ].join('\n'),
    )
    .action(async (options: InstallCommandOptions) => {
      await runInstallCommand(options, ctx);
    });

  withLayoutOptions(
    deploy.command('update').description('Bring this server up to the latest revision'),
  )
    .option('--check', 'Report what an update would apply, then stop; nothing is changed')
    .option('--ref <ref>', 'Branch, tag or commit to move to')
    .option('--force', 'Rebuild even when the revision has not changed')
    .option('--no-cache', 'Rebuild images without the layer cache')
    .option('--non-interactive', 'Never prompt; fail listing anything unresolved')
    .option('--answer <KEY=VALUE>', 'Supply a value a new revision asks for; repeat for more', collectAnswer, [])
    .option('--answers-file <path>', 'Supply such values from a .env-format file')
    .option('--skip-seed', 'Do not re-run the database seed')
    .option('--skip-proxy', 'Do not touch the reverse proxy')
    .option('--skip-github', 'Never consult the GitHub CLI, even for a GitHub remote')
    .option('--json', 'Print a machine-readable result on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy update --check`,
        `  ${CLI_NAME} deploy update`,
        `  ${CLI_NAME} deploy update --ref v1.4.0`,
        '',
        '--check fetches and prints `current <sha> -> latest <sha>, N commits',
        'behind` with the commit subjects, records it in deploy-info, and exits',
        '0 whether or not there is anything to apply - without checking out,',
        'building or touching the state. Without --check the same block is',
        'printed before the build, so you see what is about to be applied.',
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

  withLayoutOptions(
    deploy
      .command('status')
      .description('Report whether the deployment on this server is healthy'),
  )
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
        '  2  nothing is installed under --apps-root (or at --root)',
        '',
        'With one app installed no flags are needed; with several, --name says',
        'which.',
        '',
        'The Update line fetches the remote (ten seconds at most) and reports',
        'how many commits behind the deployment is; when the remote cannot be',
        'reached it says so and the verdict is unaffected.',
        '',
        'Note that /api/health/ready only proves SELECT 1 succeeded, so it',
        'passes against an empty database. Migration state is reported',
        'separately, and a green probe alone is not treated as proof.',
      ].join('\n'),
    )
    .action(async (options: StatusCommandOptions) => {
      await runStatusCommand(options, ctx);
    });

  withLayoutOptions(
    deploy
      .command('about')
      .description('Show what is deployed here, on what, and whether it is current'),
  )
    .option('--check', 'Fetch the remote first, so the Update line is current')
    .option('--server <url>', 'Ask this API about itself instead of the deployment\'s own domain')
    .option('--json', 'Print the report on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy about`,
        `  ${CLI_NAME} deploy about --check`,
        `  ${CLI_NAME} deploy about --json | jq .deployment.updatedAt`,
        '',
        'Exit codes:',
        '  0  a deployment is installed here',
        '  2  nothing is installed under --apps-root (or at --root)',
        '',
        'Informational, never a health verdict: a stopped API, no network and',
        'a missing deployment record are all reported inline and still exit 0.',
        `Use \`${CLI_NAME} deploy status\` for the check a monitor should act on.`,
        '',
        'Three blocks, the same three the web Console\'s About page shows:',
        'Application (the running process and its database), Deployment (what',
        'was deployed, when, by whom, and how far behind it is) and Server (the',
        'machine as recorded at deploy time, with any live value that has',
        'changed since shown beside it).',
        '',
        'Every timestamp is UTC, with how long ago it was. The API block needs',
        'a login for this deployment\'s own domain; without one it reads',
        'unavailable and everything else still renders.',
      ].join('\n'),
    )
    .action(async (options: AboutCommandOptions) => {
      await runAboutCommand(options, ctx);
    });

  const certs = deploy
    .command('certs')
    .description("Renew and inspect the Let's Encrypt certificates behind the shared proxy");

  withLayoutOptions(
    certs
      .command('renew')
      .description('Renew what is due, reloading the proxy only when something was renewed'),
  )
    .option('--proxy-root <path>', `Shared reverse proxy directory (default: the app's, else ${DEFAULT_PROXY_ROOT})`)
    .option('--proxy-container <name>', `Proxy container to reload (default: the app's, else ${DEFAULT_PROXY_CONTAINER})`)
    .option('--all', "Every certificate under the proxy, not only this app's")
    .option('--dry-run', "Rehearse with certbot's own --dry-run; nothing is written or reloaded")
    .option('--install-cron', `Also write ${renewalCronPath('<name>')} so this runs twice a day`)
    .option('--json', 'Print a machine-readable result on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy certs renew`,
        `  ${CLI_NAME} deploy certs renew --dry-run`,
        `  ${CLI_NAME} deploy certs renew --install-cron`,
        `  ${CLI_NAME} deploy certs renew --all --apps-root /opt/infra/apps --name myapp`,
        '',
        'Runs `docker run --rm certbot/certbot renew` against the proxy\'s own',
        'letsencrypt/ and webroot/ mounts. certbot decides what is due (within',
        '30 days of expiry); the proxy is reloaded with `docker exec` only when',
        'it reports a renewal. The cron entry uses --all so one entry serves',
        'every app behind the shared proxy, and is rewritten only on change.',
      ].join('\n'),
    )
    .action(async (options: CertsRenewCommandOptions) => {
      await runCertsRenewCommand(options, ctx);
    });

  withLayoutOptions(
    certs.command('status').description('Show when each certificate behind the proxy expires'),
  )
    .option('--proxy-root <path>', `Shared reverse proxy directory (default: the app's, else ${DEFAULT_PROXY_ROOT})`)
    .option('--json', 'Print a machine-readable report on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy certs status`,
        `  ${CLI_NAME} deploy certs status --json`,
        '',
        'Exit codes:',
        '  0  every certificate is valid',
        '  1  at least one has expired',
        '  2  there are no certificates under the proxy',
      ].join('\n'),
    )
    .action(async (options: CertsStatusCommandOptions) => {
      await runCertsStatusCommand(options, ctx);
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

  // Doctor is the one command that must work BEFORE anything is installed,
  // so "nothing found and nothing named" is not an error here: the checks run
  // against the apps root itself, and with no name there is no container of
  // the app's own to recognise yet.
  const layout = locateApp({ appsRoot: options.appsRoot, name: options.name, root: options.root });
  const deployRoot = layout?.deployRoot ?? options.appsRoot;
  const exec = ctx?.runCommand ?? runCommand;

  const context: CheckContext = {
    runCommand: exec,
    deployRoot,
    ...(layout === undefined ? {} : { name: layout.name }),
    proxyRoot: options.proxyRoot,
    bindPort: Number(options.port),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.proxyContainer === undefined ? {} : { proxyContainer: options.proxyContainer }),
    ...(options.publicIp === undefined || options.publicIp === '' ? {} : { publicIp: options.publicIp }),
    ...(options.skipProxy === undefined ? {} : { skipProxy: options.skipProxy }),
    ...(options.skipGithub === undefined ? {} : { skipGithub: options.skipGithub }),
    ...(readEnvironment(deployRoot) ?? {}),
    ...(await resolveRepoUrl(deployRoot, exec, ctx?.cwd)),
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

/**
 * The repository `gh-repo-access` should ask about, when one can be known.
 *
 * The recorded state first (an installed deployment), then the checkout this
 * command runs in - the same order install and update resolve their target.
 * Outside both there is simply nothing to ask about: the check reports
 * `skip`, and doctor stays runnable from any directory.
 */
async function resolveRepoUrl(
  deployRoot: string,
  exec: typeof runCommand,
  cwd: string = process.cwd(),
): Promise<{ repoUrl: string } | Record<string, never>> {
  try {
    const state = readState(deployRoot);
    const target = await resolveRepoTarget({
      cwd,
      runCommand: exec,
      ...(state === undefined ? {} : { state }),
    });
    return { repoUrl: target.url };
  } catch {
    return {};
  }
}

/** Reads the deployment's .env, when there is one, for the database checks. */
function readEnvironment(deployRoot: string): { env: Map<string, string> } | undefined {
  try {
    // `<root>/.env` since #120, falling back to the pre-#120 location inside
    // the clone without moving anything - doctor never writes.
    const env = readEnvFile(deployRoot);
    return env === undefined ? undefined : { env };
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
// `kvox deploy status`  (issue #183)
// ---------------------------------------------------------------------------

export interface StatusCommandOptions extends LayoutCommandOptions {
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
  const layout = locateInstalledApp({
    appsRoot: options.appsRoot,
    name: options.name,
    root: options.root,
  });
  const state = readState(layout.deployRoot);
  if (state === undefined) {
    throw new UsageError(
      `No deployment found at ${layout.deployRoot}. Run \`${CLI_NAME} deploy install\` first, or pass --name or --root.`,
    );
  }

  const exec = ctx?.runCommand ?? runCommand;
  const report = await collectHealth({
    runCommand: exec,
    deployRoot: layout.deployRoot,
    name: layout.name,
    bindPort: Number(options.port),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    state,
    ...(ctx?.fetch === undefined ? {} : { fetch: ctx.fetch }),
  });

  const healthy = isHealthy(report);
  const update = await statusUpdateCheck(layout.deployRoot, state, exec);

  if (json) {
    stdout.write(
      `${JSON.stringify({
        healthy,
        ...report,
        remote: 'remote' in update ? update.remote : null,
        ...('error' in update ? { updateCheckError: update.error } : {}),
      })}\n`,
    );
  } else {
    const colour = shouldUseColour({
      requested: options.color === false ? false : undefined,
      env: process.env,
      isTTY: ctx?.isTty ?? process.stderr.isTTY === true,
    });
    stderr.write(renderHealth(report, healthy, colour, update));
  }

  if (!healthy) {
    throw new DeploymentUnhealthyError(
      `The deployment at ${layout.deployRoot} is not healthy.`,
    );
  }
}

/** What `status` learned about the remote, or why it could not. */
export type StatusUpdate = { remote: DeployRemote } | { error: string };

/**
 * The same computation `update --check` runs (#123), bounded and forgiving:
 * ten seconds for the fetch, no clone created, and any failure - no network,
 * a revoked token, no checkout yet - becomes a line in the report rather
 * than a verdict. "Is it serving?" and "is it current?" are different
 * questions, and the second must never fail the first. What it finds is
 * recorded in deploy-info, which is how the About page learns it.
 */
async function statusUpdateCheck(
  deployRoot: string,
  state: DeployState,
  exec: typeof runCommand,
): Promise<StatusUpdate> {
  try {
    const { check } = await checkForUpdate({
      deployRoot,
      state,
      runCommand: exec,
      fetchTimeoutMs: 10_000,
      requireExisting: true,
    });
    const remote = remoteFromCheck(check);
    updateDeployInfoRemote(deployRoot, remote);
    return { remote };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.split('\n')[0] ?? message };
  }
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" - for the Update line. */
export function describeAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(seconds)) return 'at an unknown time';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
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
  update?: StatusUpdate | undefined,
): string {
  const lines: string[] = ['\n  Deployment\n\n'];

  if (report.deployed !== undefined) {
    // ONE revision line, and no more (#128). `Last deployed`, `Last attempt`
    // and the host facts used to be repeated here; they are `deploy about`'s
    // three blocks now, and a health report that also tried to be an
    // inventory made the verdict - the thing a monitor reads - harder to find.
    lines.push(`  ${'Revision'.padEnd(TITLE_WIDTH)}${report.deployed.commitSha.slice(0, 12)} (${report.deployed.ref})\n`);
  }

  if (update !== undefined) {
    if ('error' in update) {
      lines.push(`  ${'Update'.padEnd(TITLE_WIDTH)}update check: unavailable (${update.error})\n`);
    } else {
      const { remote } = update;
      const behind =
        remote.commitsBehind === 0
          ? 'up to date'
          : `${remote.commitsBehind} commit${remote.commitsBehind === 1 ? '' : 's'} behind`;
      lines.push(
        `  ${'Update'.padEnd(TITLE_WIDTH)}${behind} (latest ${remote.sha.slice(0, 12)}, checked ${describeAge(remote.checkedAt)})\n`,
      );
    }
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
  lines.push(`\n  ${painted}\n`);
  lines.push(`\n  Run \`${CLI_NAME} deploy about\` for the full picture.\n\n`);

  return lines.join('');
}


// ---------------------------------------------------------------------------
// `kvox deploy about`  (issue #128, epic #118)
// ---------------------------------------------------------------------------

export interface AboutCommandOptions extends LayoutCommandOptions {
  check?: boolean | undefined;
  server?: string | undefined;
  json?: boolean | undefined;
}

/**
 * The informational counterpart to `status`.
 *
 * IT HAS EXACTLY TWO EXIT CODES: 0 when a deployment is installed here, and
 * EXIT.USAGE (2) - raised by `collectAbout` through the same
 * `locateInstalledApp` `status` uses - when nothing is. A stopped API, an
 * unreachable remote and a missing deployment record are all facts this
 * command REPORTS, so `about` never becomes a second health check with a
 * second opinion (#128's rejected alternative).
 */
export async function runAboutCommand(
  options: AboutCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;

  const report: AboutReport = await collectAbout({
    appsRoot: options.appsRoot,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.root === undefined ? {} : { root: options.root }),
    runCommand: ctx?.runCommand ?? runCommand,
    ...(options.check === true ? { check: true } : {}),
    ...(options.server === undefined ? {} : { serverUrl: options.server }),
    ...(ctx?.fetch === undefined ? {} : { fetch: ctx.fetch }),
    ...(ctx?.cwd === undefined ? {} : { cwd: ctx.cwd }),
    ...(ctx?.configContext === undefined ? {} : { configContext: ctx.configContext }),
  });

  // stdout carries the report and nothing else, so `| jq` is clean; the
  // human rendering is stderr, like every other block in this file.
  if (options.json === true) {
    stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    stderr.write(renderAbout(report));
  }
}


// ---------------------------------------------------------------------------
// `kvox deploy install`  (issue #180)
// ---------------------------------------------------------------------------

function collectGroup(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectAnswer(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** The pseudo-key an answers file may use for the domain, which is not an .env key. */
export const DOMAIN_ANSWER_KEY = 'APP_DOMAIN';

const ANSWER_FLAG = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * `--answer KEY=VALUE` (repeatable) and `--answers-file <path>` (#127), as
 * one map: the file first, then the flags, so a flag overrides the file.
 *
 * Every value is checked against the key's own validator HERE, before the
 * pipeline touches the server: a typo in an answers file should fail in a
 * millisecond with the key named, not after a clone and a preflight. The
 * wizard validates again, with the same validators, for values it reads
 * from disk; this is the earlier of the two checks, not a different one.
 */
export function collectAnswers(
  flags: readonly string[],
  answersFile: string | undefined,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Map<string, string> {
  const answers = new Map<string, string>();

  if (answersFile !== undefined) {
    let contents: string;
    try {
      contents = readFile(answersFile);
    } catch (error) {
      throw new UsageError(
        `Cannot read --answers-file ${answersFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const [key, value] of parseEnvFile(contents)) answers.set(key, value);
  }

  for (const flag of flags) {
    const match = ANSWER_FLAG.exec(flag);
    if (match === null) {
      throw new UsageError(`--answer expects KEY=VALUE, got ${JSON.stringify(flag)}.`);
    }
    answers.set(match[1] as string, match[2] as string);
  }

  const problems: string[] = [];
  for (const [key, value] of answers) {
    if (key === DOMAIN_ANSWER_KEY) continue;
    const message = metadataFor(key).validate?.(value);
    if (message !== undefined) problems.push(`  - ${key} ${message}`);
  }
  if (problems.length > 0) {
    throw new UsageError(`Invalid answer(s):\n${problems.join('\n')}`);
  }

  return answers;
}

export interface InstallCommandOptions extends LayoutCommandOptions {
  domain?: string | undefined;
  proxyRoot: string;
  port?: string | undefined;
  repo?: string | undefined;
  ref?: string | undefined;
  email?: string | undefined;
  group: string[];
  all?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  answer: string[];
  answersFile?: string | undefined;
  reinstall?: boolean | undefined;
  resume?: boolean | undefined;
  skipDoctor?: boolean | undefined;
  skipProxy?: boolean | undefined;
  skipSeed?: boolean | undefined;
  createDatabase?: boolean | undefined;
  skipGithub?: boolean | undefined;
  cache: boolean;
  force?: boolean | undefined;
  staging?: boolean | undefined;
  proxyContainer?: string | undefined;
  /** `--no-ipv6` arrives as false; commander defaults it to true. */
  ipv6: boolean;
  /** `--install-cron` true, `--no-install-cron` false, neither undefined. */
  installCron?: boolean | undefined;
  json?: boolean | undefined;
}

export async function runInstallCommand(
  options: InstallCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  const answers = collectAnswers(options.answer, options.answersFile);
  // `--port` is an answer like any other, so the wizard never second-guesses
  // it; without one, the wizard suggests and the pipeline follows its choice.
  if (options.port !== undefined && !answers.has('APP_BIND_PORT')) {
    answers.set('APP_BIND_PORT', options.port);
  }
  const bindPort = Number(answers.get('APP_BIND_PORT') ?? DEFAULT_BIND_PORT);
  if (!Number.isInteger(bindPort) || bindPort <= 0 || bindPort >= 65536) {
    throw new UsageError(`--port must be a port number between 1 and 65535, got ${JSON.stringify(options.port)}.`);
  }
  // The domain may come from the answers file too, as APP_DOMAIN.
  const domain = options.domain ?? answers.get(DOMAIN_ANSWER_KEY);
  answers.delete(DOMAIN_ANSWER_KEY);

  const installOptions: InstallOptions = {
    // Resolved inside runInstall, before the journal opens: the name may
    // still have to come from the repository.
    appsRoot: options.appsRoot,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.root === undefined ? {} : { deployRoot: options.root }),
    bindPort,
    proxyRoot: options.proxyRoot,
    groups: options.group as EnvGroup[],
    ...(answers.size === 0 ? {} : { answers }),
    ...(domain === undefined ? {} : { domain }),
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
    ...(options.createDatabase === undefined ? {} : { createDatabase: options.createDatabase }),
    ...(options.skipGithub === undefined ? {} : { skipGithub: options.skipGithub }),
    ...(options.cache === false ? { noCache: true } : {}),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.staging === undefined ? {} : { staging: options.staging }),
    ...(options.proxyContainer === undefined ? {} : { proxyContainer: options.proxyContainer }),
    // Only the NEGATIVE is passed: without --no-ipv6 the proxy-ipv6 check
    // decides, and a `true` here would override what it found.
    ...(options.ipv6 === false ? { ipv6: false } : {}),
    ...(options.installCron === undefined ? {} : { installCron: options.installCron }),
    ...(ctx?.cronDir === undefined ? {} : { cronDir: ctx.cronDir }),
    ...(ctx?.cliPath === undefined ? {} : { cliPath: ctx.cliPath }),
    ...(ctx?.runCommand === undefined ? {} : { runCommand: ctx.runCommand }),
    ...(ctx?.fetch === undefined ? {} : { fetch: ctx.fetch }),
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

  const result = await (ctx?.install ?? runInstall)(installOptions);

  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  stderr.write(
    [
      '',
      '  Installed.',
      '',
      `  App        ${result.name} at ${result.deployRoot}`,
      `  Revision   ${result.commitSha.slice(0, 12)}`,
      `  Log        ${result.journalPath}`,
      '',
      `  ${result.nextStep}`,
      '',
    ].join('\n'),
  );
}


// ---------------------------------------------------------------------------
// `kvox deploy update`  (issue #182)
// ---------------------------------------------------------------------------

export interface UpdateCommandOptions extends LayoutCommandOptions {
  check?: boolean | undefined;
  ref?: string | undefined;
  force?: boolean | undefined;
  cache: boolean;
  nonInteractive?: boolean | undefined;
  answer: string[];
  answersFile?: string | undefined;
  skipSeed?: boolean | undefined;
  skipProxy?: boolean | undefined;
  skipGithub?: boolean | undefined;
  json?: boolean | undefined;
}

export async function runUpdateCommand(
  options: UpdateCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  const layout = locateInstalledApp({
    appsRoot: options.appsRoot,
    name: options.name,
    root: options.root,
  });

  const answers = collectAnswers(options.answer, options.answersFile);
  answers.delete(DOMAIN_ANSWER_KEY);

  const updateOptions: UpdateOptions = {
    deployRoot: layout.deployRoot,
    ...(answers.size === 0 ? {} : { answers }),
    ...(options.check === undefined ? {} : { check: options.check }),
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.cache === false ? { noCache: true } : {}),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.skipSeed === undefined ? {} : { skipSeed: options.skipSeed }),
    ...(options.skipProxy === undefined ? {} : { skipProxy: options.skipProxy }),
    ...(options.skipGithub === undefined ? {} : { skipGithub: options.skipGithub }),
    ...(ctx?.runCommand === undefined ? {} : { runCommand: ctx.runCommand }),
    ...(ctx?.cwd === undefined ? {} : { cwd: ctx.cwd }),
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

  if (options.check === true) {
    // The check IS the result: the object alone under --json, and on a
    // terminal the fetch step has already rendered `current -> latest` and
    // the subjects through the hooks. Exit 0 either way - "there is an
    // update" is an answer, not a failure.
    if (json) stdout.write(`${JSON.stringify(result.check ?? null)}\n`);
    return;
  }

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


// ---------------------------------------------------------------------------
// `kvox deploy certs renew|status`  (issue #125, epic #118)
// ---------------------------------------------------------------------------
//
// The proxy is shared, so its certificates are a host-level concern that
// happens to be reachable through any one app's state: the app knows the proxy
// root and container, and its domain names the one lineage that is "its own".
// `--all` drops that last part - it is what the cron uses, so one cron entry
// serves every app this CLI put behind the proxy.

export interface CertsRenewCommandOptions extends LayoutCommandOptions {
  proxyRoot?: string | undefined;
  proxyContainer?: string | undefined;
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
  installCron?: boolean | undefined;
  json?: boolean | undefined;
}

export interface CertsStatusCommandOptions extends LayoutCommandOptions {
  proxyRoot?: string | undefined;
  json?: boolean | undefined;
}

interface CertsScope {
  layout?: ResolvedLayout | undefined;
  state?: DeployState | undefined;
  proxyRoot: string;
  proxyContainer: string;
}

/**
 * Which proxy, and on whose behalf. The flag wins, then the app's recorded
 * state, then the defaults - the same order everything else in this group
 * resolves the proxy in. With `--all` an app is optional: several installed
 * and none named is not an error, because none of them is being singled out.
 */
function resolveCertsScope(
  options: { appsRoot: string; name?: string | undefined; root?: string | undefined; proxyRoot?: string | undefined; proxyContainer?: string | undefined },
  all: boolean,
): CertsScope {
  let layout: ResolvedLayout | undefined;
  try {
    layout = locateApp({ appsRoot: options.appsRoot, name: options.name, root: options.root });
  } catch (error) {
    if (!all) throw error;
  }
  const state = layout === undefined ? undefined : readState(layout.deployRoot);

  return {
    layout,
    state,
    proxyRoot: options.proxyRoot ?? state?.proxyRoot ?? DEFAULT_PROXY_ROOT,
    proxyContainer: options.proxyContainer ?? state?.proxyContainer ?? DEFAULT_PROXY_CONTAINER,
  };
}

export async function runCertsRenewCommand(
  options: CertsRenewCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;
  const all = options.all === true;

  const scope = resolveCertsScope(options, all);

  const certName = all ? undefined : scope.state?.domain;
  if (!all && certName === undefined) {
    throw new UsageError(
      scope.layout === undefined
        ? `No deployment found under ${options.appsRoot}. Pass --name or --root, or --all to renew every certificate under the proxy.`
        : `The deployment at ${scope.layout.deployRoot} is not published under a domain, so there is nothing of its own to renew. Pass --all to renew every certificate under the proxy.`,
    );
  }

  const result = await renewCertificates({
    proxyRoot: scope.proxyRoot,
    proxyContainer: scope.proxyContainer,
    runCommand: ctx?.runCommand ?? runCommand,
    ...(certName === undefined ? {} : { certName }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(json
      ? {}
      : {
          hooks: {
            onProgress: (message) => void stderr.write(`  ${message}\n`),
            onLog: (line) => void stderr.write(`    ${line}\n`),
          },
        }),
  });

  let cron: { path: string; changed: boolean } | undefined;
  if (options.installCron === true) {
    if (scope.layout === undefined) {
      throw new UsageError(
        'The renewal cron is written on behalf of one app (it names --apps-root and --name). Pass --name or --root.',
      );
    }
    // The state's own layout first: under `--root` the layout's apps root is
    // merely the flag's default, and the cron line must resolve back to THIS
    // app's folder from a shell that has neither flag.
    cron = installRenewalCron({
      name: scope.state?.name ?? scope.layout.name,
      appsRoot: scope.state?.appsRoot ?? scope.layout.appsRoot,
      kvoxPath: ctx?.cliPath ?? defaultCliPath(),
      ...(ctx?.cronDir === undefined ? {} : { cronDir: ctx.cronDir }),
    });
  }

  if (json) {
    stdout.write(
      `${JSON.stringify({
        dryRun: options.dryRun === true,
        argv: result.argv,
        renewed: result.renewed,
        reloaded: result.reloaded,
        ...(cron === undefined ? {} : { cron }),
      })}\n`,
    );
    return;
  }

  const lines = ['', options.dryRun === true ? '  Dry run complete.' : result.reloaded ? `  Renewed ${result.renewed.join(', ') || 'certificate(s)'} and reloaded ${scope.proxyContainer}.` : '  Nothing was due for renewal.'];
  if (cron !== undefined) {
    lines.push(`  ${cron.changed ? 'Wrote' : 'Kept'} ${cron.path}`);
  }
  lines.push('');
  stderr.write(lines.join('\n'));
}

/** No certificates under the proxy: nothing to report on, a usage-level fact. */
export class NoCertificatesError extends CliError {
  readonly exitCode: ExitCode = EXIT.USAGE;
}

export async function runCertsStatusCommand(
  options: CertsStatusCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  // Reading expiries never singles an app out, so "which app" is optional
  // here exactly as it is for `renew --all`.
  const scope = resolveCertsScope(options, true);
  const domains = listCertificates(scope.proxyRoot);
  if (domains.length === 0) {
    throw new NoCertificatesError(
      `No certificates under ${scope.proxyRoot}/letsencrypt/live. Run \`${CLI_NAME} deploy install --domain <domain>\` to issue one, or pass --proxy-root.`,
    );
  }

  const exec = ctx?.runCommand ?? runCommand;
  const expiries: CertificateExpiry[] = [];
  for (const domain of domains) {
    expiries.push(await certificateExpiry({ domain, bindPort: 0, proxyRoot: scope.proxyRoot }, exec));
  }

  const expired = expiries.filter((entry) => entry.daysLeft !== undefined && entry.daysLeft < 0);

  if (json) {
    stdout.write(
      `${JSON.stringify({
        proxyRoot: scope.proxyRoot,
        certificates: expiries.map((entry) => ({
          domain: entry.domain,
          notAfter: entry.notAfter?.toISOString() ?? null,
          daysLeft: entry.daysLeft ?? null,
        })),
      })}\n`,
    );
  } else {
    stderr.write(renderCertificates(expiries, scope.proxyRoot));
  }

  if (expired.length > 0) {
    throw new DeploymentUnhealthyError(
      `${expired.length} certificate(s) expired: ${expired.map((entry) => entry.domain).join(', ')}. Renew with \`${CLI_NAME} deploy certs renew --all\`.`,
    );
  }
}

/** The human report. Exported for its test. */
export function renderCertificates(expiries: readonly CertificateExpiry[], proxyRoot: string): string {
  const lines = ['', `  Certificates under ${proxyRoot}`, ''];
  for (const entry of expiries) {
    const detail =
      entry.daysLeft === undefined || entry.notAfter === undefined
        ? 'expiry could not be read'
        : entry.daysLeft < 0
          ? `EXPIRED ${-entry.daysLeft} day(s) ago (${entry.notAfter.toISOString().slice(0, 10)})`
          : `expires in ${entry.daysLeft} day(s) (${entry.notAfter.toISOString().slice(0, 10)})`;
    lines.push(`  ${entry.domain.padEnd(TITLE_WIDTH)}${detail}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
