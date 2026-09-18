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
import { collectInventory, renderInventory } from '../deploy/inventory.js';
import { NotInstalledError, readState, type DeployState } from '../deploy/state.js';
import { resolveRepoTarget } from '../deploy/repo.js';
import { runInstall, type InstallOptions, type InstallResult } from '../deploy/install.js';
import { describeDatabase } from '../deploy/database-drop.js';
import { describeInventory } from '../deploy/storage-purge.js';
import { runUninstall, type UninstallOptions, type UninstallResult } from '../deploy/uninstall.js';
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
  type UpdateResult,
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
  /** Injected so the uninstall flags can be tested without removing anything. */
  uninstall?: typeof runUninstall | undefined;
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
    .option('--fresh', "Discard this app's prior .env, state file and deploy-info first")
    .option('--resume', 'Continue from the step that failed')
    .option('--skip-doctor', 'Skip the prerequisite checks')
    .option('--skip-proxy', 'Do not touch the reverse proxy or request a certificate')
    .option('--skip-seed', 'Do not run the database seed')
    .option('--create-database', 'Create the PostgreSQL database when it does not exist')
    .option('--skip-github', 'Never consult the GitHub CLI, even for a GitHub remote')
    .option('--no-cache', 'Rebuild images without the layer cache')
    .option('--app-version <semver>', 'Version to deploy; default is a patch bump of the current one')
    .option('--no-version-bump', 'Deploy without changing the application version')
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
        '--fresh discards this app\'s prior LOCAL state first - the .env, the',
        'state file and deploy-info/ - and installs clean, after copying the old',
        `.env to <apps-root>/<name>.env.<timestamp>.bak (0600). It implies`,
        '--reinstall, and it deliberately does NOT touch the proxy vhost, the',
        `certificate, the database or the containers; \`${CLI_NAME} deploy uninstall\``,
        'is the command that removes a deployment outright.',
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
    deploy
      .command('uninstall')
      .description('Remove this deployment from this server'),
  )
    .option('--confirm <name>', 'Type the app\'s own name to authorise the removal')
    .option('--drop-database', 'ALSO drop the database this deployment used (off by default)')
    .option('--confirm-database <name>', 'Type the database\'s own name to authorise the drop')
    .option('--purge-storage', 'ALSO empty this application\'s prefixes in the bucket (off by default)')
    .option('--confirm-bucket <name>', 'Type the bucket\'s own name to authorise the purge')
    .option('--dry-run', 'List everything that would be removed; change nothing')
    .option('--certs', "Also delete the TLS certificate (see the rate limit below)")
    .option('--keep-env', 'Leave the .env in place; a backup is taken either way')
    .option('--non-interactive', 'Never prompt; every --confirm* the run needs is then required')
    .option('--skip-proxy', 'Do not touch the shared reverse proxy')
    .option('--proxy-root <path>', `Shared reverse proxy directory (default: the app's, else ${DEFAULT_PROXY_ROOT})`)
    .option('--proxy-container <name>', `Proxy container to reload (default: the app's, else ${DEFAULT_PROXY_CONTAINER})`)
    .option('--json', 'Print a machine-readable result on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy uninstall --dry-run`,
        `  ${CLI_NAME} deploy uninstall --confirm myapp`,
        `  ${CLI_NAME} deploy uninstall --non-interactive --confirm myapp`,
        `  ${CLI_NAME} deploy uninstall --confirm myapp --keep-env`,
        `  ${CLI_NAME} deploy uninstall --dry-run --drop-database --purge-storage`,
        `  ${CLI_NAME} deploy uninstall --confirm myapp \\`,
        `      --purge-storage --confirm-bucket my-bucket \\`,
        `      --drop-database --confirm-database appdb`,
        '',
        'Exit codes:',
        '  0  removed (or, with --dry-run, listed)',
        '  2  nothing is installed, or a confirmation was missing or wrong',
        '     (the app\'s, the bucket\'s or the database\'s)',
        '',
        'Removes: the compose project (containers, project networks and named',
        'volumes, via `down -v --remove-orphans`), the deploy root (repo/, .env,',
        'logs/, data/, deploy-info/ and the state file), this app\'s vhost in the',
        'shared proxy - then reloads it - and this app\'s certificate renewal',
        'cron.',
        '',
        'Does NOT remove unless you ask for it by name:',
        '  - THE DATABASE, with --drop-database. Without it, the database is',
        '    validated by deploy and never managed by it, and the `dropdb`',
        '    command is printed for you to run yourself.',
        '  - THE OBJECT STORAGE, with --purge-storage. That empties the six',
        '    prefixes this application writes (avatars/, database-backups/,',
        '    node-outputs/, notes/, transcripts/, uploads/) and REPORTS',
        '    anything else in the bucket without reading into it or touching',
        '    it - complete for a dedicated bucket, safe for a shared one. The',
        '    bucket itself is never deleted. A versioned bucket has its',
        '    versions and delete markers removed BY ID, because a plain delete',
        '    there keeps the bytes and the bill behind a marker.',
        '',
        '  Each takes its OWN typed confirmation of that resource\'s real name',
        '  - --confirm-database <database> and --confirm-bucket <bucket> - so a',
        '  word typed for one can never authorise the other. Both print a full',
        '  inventory (objects and bytes per prefix, the database\'s size and',
        '  open sessions) BEFORE asking, and --dry-run prints it while',
        '  destroying nothing.',
        '',
        'Does NOT remove, ever:',
        '  - THE devnet NETWORK and THE SHARED PROXY CONTAINER. Both are shared',
        '    with every other app on this server.',
        '  - TLS CERTIFICATES, unless --certs. Let\'s Encrypt allows only 5',
        '    duplicate certificates per week for the same hostname set, so an',
        '    operator iterating on a broken install who destroys and re-requests',
        '    one each time locks themselves out of their own domain for a week.',
        '',
        'The app\'s name must be typed to authorise this - it is not a y/N - and',
        'under --non-interactive it must be supplied as --confirm <name>, because',
        'a destructive default reachable by omission is not a default. The same',
        'rule applies to each extra above, against its OWN resource\'s name.',
        '',
        'The order is fixed: the containers stop, then the storage is purged,',
        'then the database is dropped, then the deployment is removed. The',
        'deployment goes last because its .env holds the credentials the two',
        'steps before it authenticate with. A failed extra is reported under',
        '"Action required:" and does NOT fail the uninstall.',
        '',
        'The .env is copied to <apps-root>/<name>.env.<timestamp>.bak (0600)',
        'before it is deleted, outside the directory being removed: it holds',
        'generated secrets that may exist nowhere else.',
        '',
        '--dry-run needs no confirmation and writes nothing at all, the run log',
        'included. A half-removed deployment - no containers, or no deploy root -',
        'uninstalls cleanly and reports what was not there.',
        '',
        `To start over on the same server, follow this with \`${CLI_NAME} deploy install\`,`,
        `or use \`${CLI_NAME} deploy install --fresh\`, which discards only this app's`,
        'local state and leaves the proxy and the certificate alone.',
      ].join('\n'),
    )
    .action(async (options: UninstallCommandOptions) => {
      await runUninstallCommand(options, ctx);
    });

  withLayoutOptions(
    deploy.command('update').description('Bring this server up to the latest revision'),
  )
    .option('--check', 'Report what an update would apply, then stop; nothing is changed')
    .option('--ref <ref>', 'Branch, tag or commit to move to')
    .option('--force', 'Rebuild even when the revision has not changed')
    .option('--no-cache', 'Rebuild images without the layer cache')
    .option('--app-version <semver>', 'Version to deploy; default is a patch bump of the current one')
    .option('--no-version-bump', 'Deploy without changing the application version')
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

  deploy
    .command('list')
    .description('List every app deployed under the apps root')
    .option('--apps-root <dir>', 'Directory that holds one folder per app', DEFAULT_APPS_ROOT)
    .option('--json', 'Print the inventory on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy list`,
        `  ${CLI_NAME} deploy list --json | jq -r '.apps[].name'`,
        '',
        'Exit codes:',
        '  0  at least one app is installed',
        '  2  nothing is installed under --apps-root',
        '',
        'Read from the filesystem alone - each app\'s own state file, or its',
        '.env when it has no state file. No container, no network and no git',
        'process is consulted, so it answers the same way when Docker is down.',
        'An app with no state file therefore reports no revision; a',
        `\`${CLI_NAME} deploy update\` on it rebuilds the record, after which it`,
        'reports like any other.',
        '',
        'There is deliberately no --name/--root here: this is the inventory,',
        'and both flags name one app.',
      ].join('\n'),
    )
    .action(async (options: ListCommandOptions) => {
      await runListCommand(options, ctx);
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

    // The one exception to "one revision line, and no more" (#267). A state
    // file now exists for an install that FAILED, so the revision above may
    // name a commit that was never deployed - and an operator reading this
    // report must not have to infer that from a probe that times out.
    if (report.deployed.lastOutcome === 'failure') {
      const where =
        report.deployed.lastFailedStep === undefined ? '' : ` at ${report.deployed.lastFailedStep}`;
      lines.push(
        `  ${'Last outcome'.padEnd(TITLE_WIDTH)}the last install failed${where}; re-run \`${CLI_NAME} deploy install --resume\` to continue\n`,
      );
    }
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
// `kvox deploy list`  (issue #290)
// ---------------------------------------------------------------------------

export interface ListCommandOptions {
  appsRoot: string;
  json?: boolean | undefined;
}

/**
 * The inventory, read from the distributed registry the apps root already is.
 *
 * "Nothing installed" is a usage-level fact, not an empty success, the same
 * standing `certs status` gives "no certificates under the proxy": a script
 * written as `deploy list && ...` should not proceed on a host where this CLI
 * has deployed nothing.
 */
export async function runListCommand(
  options: ListCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;

  const report = collectInventory(options.appsRoot);

  if (options.json === true) {
    stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    stderr.write(renderInventory(report));
  }

  if (report.apps.length === 0) {
    throw new NotInstalledError(
      `Nothing is installed under ${options.appsRoot}. Run \`${CLI_NAME} deploy install\` first, or pass --apps-root if the apps live somewhere else.`,
    );
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

export interface UninstallCommandOptions extends LayoutCommandOptions {
  /** `--confirm <name>`: the app's own name, typed. */
  confirm?: string | undefined;
  /** `--drop-database` + `--confirm-database <name>`, the database's own name. */
  dropDatabase?: boolean | undefined;
  confirmDatabase?: string | undefined;
  /** `--purge-storage` + `--confirm-bucket <name>`, the bucket's own name. */
  purgeStorage?: boolean | undefined;
  confirmBucket?: string | undefined;
  dryRun?: boolean | undefined;
  certs?: boolean | undefined;
  keepEnv?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  skipProxy?: boolean | undefined;
  proxyRoot?: string | undefined;
  proxyContainer?: string | undefined;
  json?: boolean | undefined;
}

/**
 * `kvox deploy uninstall` (issue #261).
 *
 * The thin command layer: flags in, `runUninstall` does the work, and the
 * report is rendered here - never inside `src/deploy/`, which writes to no
 * terminal (hooks.ts's rule).
 *
 * THE "NOT REMOVED" BLOCK IS PRINTED EVERY TIME, including on success. An
 * operator who has just removed a deployment is exactly the person about to
 * assume the database went with it.
 */
export async function runUninstallCommand(
  options: UninstallCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  const uninstallOptions: UninstallOptions = {
    appsRoot: options.appsRoot,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.root === undefined ? {} : { deployRoot: options.root }),
    ...(options.confirm === undefined ? {} : { confirmation: options.confirm }),
    ...(options.dropDatabase === undefined ? {} : { dropDatabase: options.dropDatabase }),
    ...(options.confirmDatabase === undefined ? {} : { confirmDatabase: options.confirmDatabase }),
    ...(options.purgeStorage === undefined ? {} : { purgeStorage: options.purgeStorage }),
    ...(options.confirmBucket === undefined ? {} : { confirmBucket: options.confirmBucket }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.certs === undefined ? {} : { certs: options.certs }),
    ...(options.keepEnv === undefined ? {} : { keepEnv: options.keepEnv }),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.skipProxy === undefined ? {} : { skipProxy: options.skipProxy }),
    ...(options.proxyRoot === undefined ? {} : { proxyRoot: options.proxyRoot }),
    ...(options.proxyContainer === undefined ? {} : { proxyContainer: options.proxyContainer }),
    ...(ctx?.cronDir === undefined ? {} : { cronDir: ctx.cronDir }),
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

  const result = await (ctx?.uninstall ?? runUninstall)(uninstallOptions);

  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  stderr.write(renderUninstall(result));
}

/** The report. Exported so its wording is pinned by a test, not by a screenshot. */
export function renderUninstall(result: UninstallResult): string {
  const lines: string[] = [''];

  lines.push(result.dryRun ? `  Dry run - nothing was changed.` : `  Removed ${result.name}.`);
  lines.push('');

  // WARNINGS COME FIRST, before the inventory (#261). They used to sit at the
  // bottom, after a removed list that can run to a dozen paths, which is the
  // one place a notice that automatic certificate renewal has stopped for the
  // whole server will not be read. A warning here is something the operator
  // has to act on; everything below it is a record of what happened.
  if (result.warnings.length > 0) {
    lines.push('  Action required:');
    for (const warning of result.warnings) {
      // An empty line stays empty: indenting it leaves trailing whitespace
      // that shows up in a diff, a paste and `cat -A`.
      for (const line of warning.split('\n')) lines.push(line === '' ? '' : `    ${line}`);
      lines.push('');
    }
  }

  const verb = result.dryRun ? 'Would remove' : 'Removed';
  lines.push(`  ${verb}:`);
  if (result.removed.length === 0) {
    lines.push('    (nothing was there)');
  }
  for (const item of result.removed) {
    lines.push(`    ${item.target}${item.existed ? '' : '   (already gone)'}`);
  }

  lines.push('');
  lines.push('  NOT removed:');
  for (const item of result.kept) {
    lines.push(`    ${item.target}`);
    lines.push(`      ${item.reason}`);
  }

  // The two extras' own inventories, AFTER the removed list and before the
  // .env note: they describe another system, and a reader scanning "Removed:"
  // for paths should not have to step over a bucket listing to finish it.
  if (result.storage !== undefined) {
    lines.push('');
    lines.push('  Object storage:');
    if (result.storage.problem !== undefined) {
      lines.push(`    NOT emptied: ${result.storage.problem}`);
    } else if (result.storage.inventory !== undefined) {
      for (const line of describeInventory(result.storage.inventory)) {
        lines.push(line === '' ? '' : `    ${line}`);
      }
      const purge = result.storage.purge;
      if (purge !== undefined) {
        lines.push(
          `    ${purge.dryRun ? 'Would delete' : 'Deleted'} ${purge.keys} key(s)` +
            (purge.failures.length === 0 ? '.' : `, ${purge.failures.length} prefix(es) failed.`),
        );
      }
    }
  }

  if (result.database !== undefined) {
    lines.push('');
    lines.push('  Database:');
    if (result.database.problem !== undefined) {
      lines.push(`    NOT dropped: ${result.database.problem}`);
    } else if (result.database.facts !== undefined) {
      for (const line of describeDatabase(result.database.facts)) lines.push(`    ${line}`);
      const outcome = result.database.outcome;
      if (outcome !== undefined && outcome.ok) lines.push(`    ${outcome.detail}`);
      else if (outcome !== undefined) lines.push(`    NOT dropped: ${outcome.detail}`);
      else if (result.dryRun) lines.push('    Would be dropped.');
    }
  }

  if (result.envBackupPath !== undefined) {
    lines.push('');
    lines.push(`  .env ${result.dryRun ? 'would be copied' : 'backed up'} to ${result.envBackupPath}`);
  }

  if (result.journalPath !== undefined) {
    lines.push('');
    lines.push(`  Log  ${result.journalPath}`);
  }

  lines.push('');
  return lines.join('\n');
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
  /** `--fresh`: discard the prior local state before installing (#261). */
  fresh?: boolean | undefined;
  resume?: boolean | undefined;
  skipDoctor?: boolean | undefined;
  skipProxy?: boolean | undefined;
  skipSeed?: boolean | undefined;
  createDatabase?: boolean | undefined;
  skipGithub?: boolean | undefined;
  cache: boolean;
  /** `--app-version <semver>` (#295). */
  appVersion?: string | undefined;
  /** `--no-version-bump` arrives as false; commander defaults it to true. */
  versionBump: boolean;
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
    ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.skipDoctor === undefined ? {} : { skipDoctor: options.skipDoctor }),
    ...(options.skipProxy === undefined ? {} : { skipProxy: options.skipProxy }),
    ...(options.skipSeed === undefined ? {} : { skipSeed: options.skipSeed }),
    ...(options.createDatabase === undefined ? {} : { createDatabase: options.createDatabase }),
    ...(options.skipGithub === undefined ? {} : { skipGithub: options.skipGithub }),
    ...(options.cache === false ? { noCache: true } : {}),
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.versionBump === false ? { versionBump: false } : {}),
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

  stderr.write(renderInstall(result));
}

/**
 * The install report. Exported so its wording is pinned by a test.
 *
 * `Action required:` comes FIRST, the shape `renderUninstall` established and
 * for the same reason (#261, #265): a warning is something the operator has to
 * act on, and everything under it is a record of what happened. The one that
 * lands here today is a renewal cron the CLI could not write - an install that
 * completed without a renewal schedule must never be silent, because the only
 * other notice of it is an expired certificate 60-90 days later.
 *
 * `nextStep` stays LAST and stays one line: it is the thing nobody else can do
 * (log in and claim the Admin role), not a list of leftovers.
 */
export function renderInstall(result: InstallResult): string {
  const lines: string[] = ['', '  Installed.', ''];

  if (result.warnings.length > 0) {
    lines.push('  Action required:');
    for (const warning of result.warnings) {
      // An empty line stays empty: indenting it leaves trailing whitespace
      // that shows up in a diff, a paste and `cat -A`.
      for (const line of warning.split('\n')) lines.push(line === '' ? '' : `    ${line}`);
      lines.push('');
    }
  }

  lines.push(
    `  App        ${result.name} at ${result.deployRoot}`,
    ...(result.appVersion === undefined
      ? []
      : [`  Version    ${versionLine(result.appVersion)}`]),
    `  Revision   ${result.commitSha.slice(0, 12)}`,
    `  Log        ${result.journalPath}`,
    '',
    `  ${result.nextStep}`,
    '',
  );

  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// `kvox deploy update`  (issue #182)
// ---------------------------------------------------------------------------

export interface UpdateCommandOptions extends LayoutCommandOptions {
  check?: boolean | undefined;
  ref?: string | undefined;
  force?: boolean | undefined;
  cache: boolean;
  /** `--app-version <semver>` (#295). */
  appVersion?: string | undefined;
  /** `--no-version-bump` arrives as false; commander defaults it to true. */
  versionBump: boolean;
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
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.versionBump === false ? { versionBump: false } : {}),
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

  // ADOPTION IS NEVER SILENT, INCLUDING UNDER --json (#285). On a terminal the
  // hooks above already printed it before the pipeline ran; with --json no
  // hooks are wired at all, so it is written here instead - to stderr, which
  // keeps stdout pure JSON. It also covers `--check --json`, whose stdout is
  // the check object alone and has nowhere to put it.
  if (json && result.adopted !== undefined) {
    stderr.write(`\n  ${result.adopted.headline}\n`);
    for (const line of result.adopted.detail) stderr.write(`    ${line}\n`);
    stderr.write('\n');
  }

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

  stderr.write(renderUpdate(result));
}

/**
 * The update report. Exported so its wording is pinned by a test.
 *
 * `Action required:` comes FIRST, the shape `renderUninstall` and
 * `renderInstall` established (#261, #265) and for the same reason. The one
 * warning that lands here today is a version bump that could not be published
 * to the repository (#295) — the deployment is complete and serving, and this
 * is the only notice that the repository does not know its number.
 */
export function renderUpdate(result: UpdateResult): string {
  const lines: string[] = ['', '  Updated.', ''];

  if (result.warnings.length > 0) {
    lines.push('  Action required:');
    for (const warning of result.warnings) {
      // An empty line stays empty: indenting it leaves trailing whitespace
      // that shows up in a diff, a paste and `cat -A`.
      for (const line of warning.split('\n')) lines.push(line === '' ? '' : `    ${line}`);
      lines.push('');
    }
  }

  lines.push(
    `  ${(result.previousSha ?? 'unknown').slice(0, 12)} -> ${result.commitSha.slice(0, 12)}`,
    ...(result.appVersion === undefined
      ? []
      : [`  Version    ${versionLine(result.appVersion)}`]),
    `  Took       ${Math.round(result.durationMs / 1000)}s`,
    `  Log        ${result.journalPath}`,
    '',
  );

  return lines.join('\n');
}

/**
 * `1.2.3` — or `1.2.3 (not published to the repository)`.
 *
 * The parenthetical is NOT a duplicate of the warning above it. The warning
 * says what to do; this says which number the line is talking about, for
 * somebody scanning the summary rather than reading it.
 */
function versionLine(version: { version: string; published: boolean }): string {
  return version.published
    ? version.version
    : `${version.version} (not published to the repository)`;
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
