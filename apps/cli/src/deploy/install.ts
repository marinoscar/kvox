import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { PreconditionError, UsageError } from '../errors.js';
import { CLI_VERSION } from '../package-info.js';
import {
  ALL_CHECKS,
  DEFAULT_PROXY_CONTAINER,
  DEVNET_CHECK_ID,
  DEVNET_NETWORK,
  checksPassed,
  runChecks,
  type CheckContext,
} from './checks/index.js';
import { ensureDeployInfoDir, writeDeployInfo } from './deploy-info.js';
import { ensureComposeEnvLink, envFilePath, readEnvFile, writeEnvFile } from './env-file.js';
import { parseEnvExample, serializeEnvFile } from './env-spec.js';
import { runEnvWizard } from './env-wizard.js';
import type { EnvGroup } from './env-metadata.js';
import { runCommand as defaultRunCommand } from './executor.js';
import { waitForHealthy, collectHealth, isHealthy } from './health.js';
import type { DeployHooks } from './hooks.js';
import { openJournal, type Journal, type SecretEntry } from './journal.js';
import {
  DEFAULT_APPS_ROOT,
  appNameFor,
  appRootFor,
  locateApp,
  siblingBindPorts,
  type ResolvedLayout,
} from './layout.js';
import {
  defaultCliPath,
  installRenewalCron,
  installVhost,
  issueCertificate,
  type FetchLike,
  type ProxyTarget,
} from './proxy.js';
import {
  ensureCheckout,
  ensureGitHubAuth,
  githubSlug,
  resolveRepoTarget,
  type RepoTarget,
} from './repo.js';
import { collectServerFacts } from './server-facts.js';
import { readState, writeState, type DeployState } from './state.js';
import { pipelineFailure, runPipeline, type DeployStep, type StepContext } from './steps/pipeline.js';
import { metadataFor } from './env-metadata.js';
import type { PromptContext } from '../prompt.js';

// =============================================================================
// `kvox deploy install`  (issue #180, epic #168)
// =============================================================================
//
// Takes a prepared VPS from nothing to a running, migrated, seeded, healthy,
// HTTPS deployment.
//
// FOUR THINGS THAT DECIDE WHETHER THIS WORKS AT ALL, all of them learned from
// the code rather than assumed:
//
//   1. MIGRATIONS NEED THE ENVIRONMENT EXPLICITLY. scripts/prisma-env.js only
//      loads dotenv when NODE_ENV !== 'production', and the production stack
//      sets NODE_ENV=production - so POSTGRES_* must be present in the migrate
//      container's environment, not merely in a file it might have read.
//   2. NEVER `npm ci` WITH NODE_ENV=production anywhere in here. It drops
//      @nestjs/cli, the Prisma CLI and ts-node, which build, migrate and seed
//      all need. This has bitten the repository before; ci.yml says so.
//   3. /api/health/ready IS NOT PROOF THAT MIGRATIONS RAN. Its only indicator
//      issues SELECT 1, which passes against an empty database. Step 8's exit
//      status is what proves the schema; the health wait proves the process is
//      up. Do not let a green probe stand in for the migration.
//   4. THE CERTIFICATE IS ISSUED BEFORE THE VHOST IS WRITTEN. A vhost naming a
//      certificate that does not exist fails nginx -t and takes the shared
//      proxy's reload down for every site on the host.
// =============================================================================

const COMPOSE_FILES = ['base.compose.yml', 'prod.compose.yml', 'vps.compose.yml'] as const;

export interface InstallOptions {
  /**
   * The app-folder layout (#119): the deployment lives at `<appsRoot>/<name>`
   * and `<name>` is the compose project. `name` defaults to the repository's
   * own name; `deployRoot` is the explicit full override and wins outright.
   */
  appsRoot?: string | undefined;
  name?: string | undefined;
  deployRoot?: string | undefined;
  domain?: string | undefined;
  bindPort: number;
  proxyRoot: string;
  repo?: string | undefined;
  ref?: string | undefined;
  nonInteractive?: boolean | undefined;
  all?: boolean | undefined;
  groups?: readonly EnvGroup[] | undefined;
  reinstall?: boolean | undefined;
  resume?: boolean | undefined;
  skipDoctor?: boolean | undefined;
  skipProxy?: boolean | undefined;
  /**
   * `--create-database`: create the PostgreSQL database when it is absent
   * (#238). With a terminal the operator is still asked and this only sets
   * the default; under `--non-interactive` it is the only authorisation
   * there can be, so without it an unattended run reports the missing
   * database and stops, exactly as it does today.
   */
  createDatabase?: boolean | undefined;
  skipSeed?: boolean | undefined;
  /**
   * `--skip-github`: never consult `gh`, even for a GitHub remote. CI's
   * `file://` remote is skipped anyway (not on GitHub); this is for a box
   * that reaches GitHub some other way and must not be asked to log in.
   */
  skipGithub?: boolean | undefined;
  noCache?: boolean | undefined;
  force?: boolean | undefined;
  email?: string | undefined;
  staging?: boolean | undefined;
  /**
   * The shared proxy's container (`--proxy-container`). Otherwise the
   * `proxy-container` preflight check finds it, and with `--skip-doctor` the
   * conventional name is assumed - the same order doctor resolves it in.
   */
  proxyContainer?: string | undefined;
  /** `--no-ipv6`: render the vhost without `[::]` listeners. */
  ipv6?: boolean | undefined;
  /**
   * `--install-cron` / `--no-install-cron`. Undefined means "when a
   * certificate was issued by this run": a fresh certificate with nobody to
   * renew it is a 90-day timer on an outage, while an existing one is
   * presumably already somebody's job.
   */
  installCron?: boolean | undefined;
  /** The command the renewal cron runs; defaults to this binary. */
  cliPath?: string | undefined;
  /** Where the cron file goes; default /etc/cron.d, tests point it elsewhere. */
  cronDir?: string | undefined;
  runCommand?: typeof defaultRunCommand | undefined;
  hooks?: DeployHooks | undefined;
  promptContext?: PromptContext | undefined;
  cwd?: string | undefined;
  /** Injected so the routing self-probe is testable without public DNS. */
  fetch?: FetchLike | undefined;
  /**
   * Values collected elsewhere, merged in ahead of the wizard.
   *
   * The ink screen (#184) needs this: readline cannot ask a question while
   * ink holds stdin in raw mode, so the TUI collects the fields with its own
   * text input and hands them over, then runs the wizard non-interactively.
   */
  answers?: ReadonlyMap<string, string> | undefined;
}

/** InstallOptions once the layout has been decided; every step reads this. */
export type ResolvedInstallOptions = InstallOptions & ResolvedLayout;

interface InstallContext extends StepContext {
  options: ResolvedInstallOptions;
  runCommand: typeof defaultRunCommand;
  journal: Journal;
  target?: RepoTarget | undefined;
  checkoutPath?: string | undefined;
  commitSha?: string | undefined;
  env?: Map<string, string> | undefined;
  /** Written by the preflight from the `proxy-container` check (#122). */
  proxyContainer?: string | undefined;
  /** Written by the preflight from the `proxy-ipv6` check (#122). */
  ipv6?: boolean | undefined;
  /** Whether the publish step issued a certificate (rather than found one). */
  certificateIssued?: boolean | undefined;
}

/**
 * The checks the preflight runs: every required one except devnet (the
 * `network` step right after creates it, so failing on its absence here would
 * refuse the very install that fixes it), plus `proxy-ipv6`, which is only
 * recommended but whose answer decides whether the vhost may bind `[::]`.
 */
export const PREFLIGHT_EXTRA_CHECK_IDS: readonly string[] = ['proxy-ipv6'];

export function composeCwd(deployRoot: string): string {
  // The relative build contexts in base.compose.yml (`../..`, `../nginx`)
  // resolve against the COMPOSE FILE's directory, so this is not incidental.
  return join(deployRoot, 'repo', 'infra', 'compose');
}

export function composeArgv(name: string, extra: readonly string[]): string[] {
  // `-p <name>` pins the compose PROJECT (#119). Without it the project is
  // named after the compose directory, which is `compose` for every app built
  // from this template, so a second app's `up -d` replaces the first's
  // containers. The same name is written to .env as COMPOSE_PROJECT_NAME so a
  // hand-run `docker compose` in that directory agrees with the CLI.
  return [
    'docker',
    'compose',
    '-p',
    name,
    ...COMPOSE_FILES.flatMap((file) => ['-f', file]),
    ...extra,
  ];
}

/** Secrets for the journal's redactor, from the metadata rather than a guess. */
export function secretsFrom(env: ReadonlyMap<string, string>): SecretEntry[] {
  return [...env.entries()]
    .filter(([key]) => metadataFor(key).secret === true)
    .map(([key, value]) => ({ key, value }));
}

/**
 * The repository to deploy, resolved once. `runInstall` resolves it at entry
 * when the app name has to come from it; otherwise the first step that needs
 * it (`auth`, then `checkout`) does, and later ones read it back.
 */
async function resolveTarget(context: InstallContext): Promise<RepoTarget> {
  if (context.target !== undefined) return context.target;
  const target = await resolveRepoTarget({
    cwd: context.options.cwd ?? process.cwd(),
    appsRoot: context.options.appsRoot,
    runCommand: context.runCommand,
    ...(context.options.repo === undefined ? {} : { repoFlag: context.options.repo }),
    ...(context.options.ref === undefined ? {} : { refFlag: context.options.ref }),
  });
  context.target = target;
  return target;
}

async function compose(
  context: InstallContext,
  extra: readonly string[],
  options?: { timeoutMs?: number },
): Promise<void> {
  const result = await context.runCommand(composeArgv(context.options.name, extra), {
    cwd: composeCwd(context.options.deployRoot),
    timeoutMs: options?.timeoutMs ?? 30 * 60_000,
    redact: context.journal.redact,
    ...(context.hooks?.onLog === undefined
      ? {}
      : { onLine: (line: string) => context.hooks?.onLog?.(line) }),
  });
  context.journal.command(result);
}

export function buildInstallSteps(): DeployStep<InstallContext>[] {
  return [
    {
      id: 'preflight',
      title: 'Check prerequisites',
      skip: (context) =>
        context.options.skipDoctor === true
          ? 'skipped with --skip-doctor'
          : undefined,
      async run(context) {
        const checks = ALL_CHECKS.filter(
          (check) =>
            (check.severity === 'required' || PREFLIGHT_EXTRA_CHECK_IDS.includes(check.id)) &&
            check.id !== DEVNET_CHECK_ID,
        );
        // Held in a variable because the checks WRITE to it: `proxy-container`
        // records the container it found and `proxy-ipv6` whether [::] may be
        // bound, and the publish step reads both back.
        const checkContext: CheckContext = {
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          name: context.options.name,
          bindPort: context.options.bindPort,
          proxyRoot: context.options.proxyRoot,
          ...(context.options.domain === undefined
            ? {}
            : { domain: context.options.domain }),
          ...(context.options.proxyContainer === undefined
            ? {}
            : { proxyContainer: context.options.proxyContainer }),
          // --skip-proxy is the only way to run this pipeline where there is
          // no proxy (CI, #133); a preflight that fails on the proxy it was
          // told to ignore would make the flag useless. The proxy checks
          // report `skip` and the journal shows it.
          ...(context.options.skipProxy === undefined
            ? {}
            : { skipProxy: context.options.skipProxy }),
          // --skip-github has to reach the CHECKS, not only the `auth` step
          // below (#133). The three `gh-*` checks are `required`, and
          // `gh-authenticated` fails outright on a box where `gh` is
          // installed but nobody has logged in - which is every CI runner.
          // Without this line the flag silently covered half of what it
          // says it covers: the step stood down and the preflight failed
          // anyway, so an install could never complete unattended against a
          // remote that is not on GitHub. Doctor already passes it through
          // (`runDoctorCommand`); this makes install agree with doctor.
          ...(context.options.skipGithub === undefined
            ? {}
            : { skipGithub: context.options.skipGithub }),
        };
        const results = await runChecks(checks, checkContext);

        for (const result of results) {
          context.journal.line(`${result.status} ${result.id}: ${result.detail}`);
        }

        context.proxyContainer = checkContext.proxyContainer;
        context.ipv6 = checkContext.ipv6;

        if (!checksPassed(results)) {
          const failed = results.filter((result) => result.status === 'fail');
          // Aborts BEFORE anything is cloned or written.
          throw new PreconditionError(
            `Prerequisites not met:\n` +
              failed
                .map((result) => `  - ${result.id}: ${result.detail}\n    ${result.remedy ?? ''}`)
                .join('\n') +
              `\nRun \`${CLI_NAME} deploy doctor\` for the full report.`,
          );
        }
      },
    },
    {
      id: 'network',
      title: `Ensure the ${DEVNET_NETWORK} network`,
      async run(context) {
        // base.compose.yml declares devnet `external: true`, so compose never
        // creates it. Idempotent, and - with the directories - the one thing
        // install is allowed to create that the doctor only reports.
        const run = (argv: readonly string[]) =>
          context.runCommand(argv, {
            cwd: context.options.deployRoot,
            timeoutMs: 60_000,
            redact: context.journal.redact,
          });

        try {
          context.journal.command(await run(['docker', 'network', 'inspect', DEVNET_NETWORK]));
          context.journal.line(`${DEVNET_NETWORK} already exists`);
          return;
        } catch {
          // Absent; created below.
        }

        context.journal.command(await run(['docker', 'network', 'create', DEVNET_NETWORK]));
        context.hooks?.onProgress?.(`Created the ${DEVNET_NETWORK} network`);
      },
    },
    {
      id: 'auth',
      title: 'Authenticate with GitHub',
      skip: (context) => {
        if (context.options.skipGithub === true) return 'skipped with --skip-github';
        // Decided here when the remote is already known; otherwise `run`
        // resolves it and stands down itself for another forge.
        const url = context.options.repo ?? context.target?.url;
        if (url !== undefined && githubSlug(url) === null) return 'not a GitHub remote';
        return undefined;
      },
      async run(context) {
        // On the server the credential is `gh` (#123, epic #118 decision 1):
        // stop here, with the login command, rather than at git's own prompt
        // for a password that no longer exists - and BEFORE the clone.
        const target = await resolveTarget(context);
        const auth = await ensureGitHubAuth({
          runCommand: context.runCommand,
          repoUrl: target.url,
          cwd: context.options.deployRoot,
          // Rule 5 of executor.ts: wherever `hooks` are wired, the redactor
          // travels with them, or the terminal shows what the log masks.
          redact: context.journal.redact,
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
        });
        context.journal.line(
          auth === undefined
            ? `${target.url} is not a GitHub remote; plain git will be used`
            : `git reaches ${auth.slug} through gh's credential helper`,
        );
      },
    },
    {
      id: 'checkout',
      title: 'Fetch the application',
      async run(context) {
        const target = await resolveTarget(context);

        context.journal.line(`Deploying ${target.url} @ ${target.ref} (${target.source})`);

        const checkout = await ensureCheckout(target, {
          deployRoot: context.options.deployRoot,
          runCommand: context.runCommand,
          redact: context.journal.redact,
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
          ...(context.options.force === undefined ? {} : { force: context.options.force }),
        });

        context.target = target;
        context.checkoutPath = checkout.path;
        context.commitSha = checkout.sha;
        context.journal.line(`Checked out ${checkout.sha}`);
      },
    },
    {
      id: 'environment',
      title: 'Configure the environment',
      async run(context) {
        const templatePath = join(
          context.options.deployRoot,
          'repo',
          'infra',
          'compose',
          '.env.example',
        );
        const specs = parseEnvExample(readFileSync(templatePath, 'utf8'));

        // The clone exists (the checkout step just ran), so the link into it
        // can be made - and an install from before #120, whose .env is a
        // regular file inside the clone, is moved to the app root here, once.
        const link = ensureComposeEnvLink(context.options.deployRoot);
        if (link.migrated) {
          const message = `Moved .env from the clone to ${envFilePath(context.options.deployRoot)} and linked it back`;
          context.journal.line(message);
          context.hooks?.onProgress?.(message);
        }

        const path = envFilePath(context.options.deployRoot);
        const onDisk = readEnvFile(context.options.deployRoot);

        // Answers supplied by a caller win over what is on disk: they are the
        // more recent statement of intent.
        const existing =
          context.options.answers === undefined
            ? onDisk
            : new Map([...(onDisk ?? new Map()), ...context.options.answers]);

        // The wizard's server-derived suggestions (#127): what this machine
        // is, and which ports the other apps under the apps root hold - from
        // their state files, so a stopped sibling still counts.
        const facts = await collectServerFacts({
          runCommand: context.runCommand,
          root: context.options.deployRoot,
        });
        const siblingPorts = siblingBindPorts(context.options.appsRoot, context.options.deployRoot);

        const result = await runEnvWizard({
          specs,
          // Asked in the wizard's own domain step when not given (#127); an
          // unattended run without one is reported there as unresolved.
          ...(context.options.domain === undefined ? {} : { domain: context.options.domain }),
          ...(existing === undefined ? {} : { existing }),
          facts,
          siblingPorts,
          // The domain and database steps verify their answers before the
          // next question, with the same registry the preflight ran.
          inlineChecks: {
            context: {
              runCommand: context.runCommand,
              deployRoot: context.options.deployRoot,
              name: context.options.name,
              bindPort: context.options.bindPort,
              proxyRoot: context.options.proxyRoot,
              ...(context.options.skipProxy === undefined
                ? {}
                : { skipProxy: context.options.skipProxy }),
              ...((context.options.proxyContainer ?? context.proxyContainer) === undefined
                ? {}
                : { proxyContainer: context.options.proxyContainer ?? context.proxyContainer }),
            },
          },
          ...(context.options.createDatabase === undefined
            ? {}
            : { createDatabase: context.options.createDatabase }),
          ...(context.options.all === undefined ? {} : { all: context.options.all }),
          ...(context.options.nonInteractive === undefined
            ? {}
            : { nonInteractive: context.options.nonInteractive }),
          ...(context.options.groups === undefined ? {} : { groups: context.options.groups }),
          ...(context.options.promptContext === undefined
            ? {}
            : { ctx: context.options.promptContext }),
        });
        const { values } = result;

        for (const check of result.checks) {
          context.journal.line(`${check.status} ${check.id}: ${check.detail}`);
        }

        if (context.options.domain === undefined && result.domain !== '') {
          context.options.domain = result.domain;
          context.journal.line(`Domain ${result.domain} (from the wizard)`);
        }

        // The wizard's APP_BIND_PORT - suggested from the server or typed -
        // is the port every later step binds, probes and publishes; an
        // explicit --port arrives here as an answer, so it still wins.
        const chosenPort = Number(values.get('APP_BIND_PORT'));
        if (Number.isInteger(chosenPort) && chosenPort > 0 && chosenPort < 65536) {
          context.options.bindPort = chosenPort;
        } else {
          values.set('APP_BIND_PORT', String(context.options.bindPort));
        }
        // Not in .env.example, and deliberately not in ENV_METADATA either:
        // serializeEnvFile carries it under its "not in the template" banner.
        // It is what makes a hand-run `docker compose ... ps` in this
        // directory see the same project the CLI's `-p <name>` does.
        values.set('COMPOSE_PROJECT_NAME', context.options.name);
        // Same standing as COMPOSE_PROJECT_NAME: vps.compose.yml mounts
        // `${DEPLOY_ROOT:-../../..}/deploy-info` into the api container, and
        // writing the resolved root here keeps an explicit --root honest even
        // when the compose directory is not three levels below it.
        values.set('DEPLOY_ROOT', context.options.deployRoot);

        // 0600, at the app root: it holds the database password, the JWT
        // secret and the OAuth client secret, and it must survive `rm -rf repo`.
        writeEnvFile(context.options.deployRoot, serializeEnvFile(values, specs));

        context.env = values;
        context.journal.line(`Wrote ${path} (${values.size} variables)`);
      },
    },
    {
      id: 'validate-environment',
      title: 'Validate the environment',
      async run(context) {
        if (context.env === undefined) return;

        const results = await runChecks(
          ALL_CHECKS.filter((check) => check.id.startsWith('database-')),
          {
            runCommand: context.runCommand,
            deployRoot: context.options.deployRoot,
            name: context.options.name,
            bindPort: context.options.bindPort,
            proxyRoot: context.options.proxyRoot,
            env: context.env,
          },
        );

        for (const result of results) {
          context.journal.line(`${result.status} ${result.id}: ${result.detail}`);
        }

        if (!checksPassed(results)) {
          throw new PreconditionError(
            `The database is not usable with these settings:\n` +
              results
                .filter((result) => result.status === 'fail')
                .map((result) => `  - ${result.detail}\n    ${result.remedy ?? ''}`)
                .join('\n'),
          );
        }
      },
    },
    {
      id: 'build',
      title: 'Build images',
      async run(context) {
        await compose(context, [
          'build',
          ...(context.options.noCache === true ? ['--no-cache'] : []),
        ]);
      },
    },
    {
      id: 'migrate',
      title: 'Apply migrations',
      async run(context) {
        // `run --rm` rather than `exec`: the stack is not up yet, and this must
        // not depend on the api container already running.
        await compose(context, [
          'run', '--rm', '--no-deps', 'api',
          'npm', 'run', 'prisma:migrate',
        ], { timeoutMs: 10 * 60_000 });
      },
    },
    {
      id: 'seed',
      title: 'Seed roles and permissions',
      skip: (context) =>
        context.options.skipSeed === true ? 'skipped with --skip-seed' : undefined,
      async run(context) {
        await compose(context, [
          'run', '--rm', '--no-deps', 'api',
          'npm', 'run', 'prisma:seed',
        ], { timeoutMs: 10 * 60_000 });
      },
    },
    {
      id: 'start',
      title: 'Start the stack',
      async run(context) {
        await compose(context, ['up', '-d']);
      },
    },
    {
      id: 'health',
      title: 'Wait for the API',
      async run(context) {
        const probe = await waitForHealthy({
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          name: context.options.name,
          bindPort: context.options.bindPort,
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
        });

        if (!probe.ok) {
          throw new Error(
            `The API did not become ready: ${probe.error ?? `HTTP ${probe.status ?? '?'}`}`,
          );
        }
      },
    },
    {
      id: 'publish',
      title: 'Publish over HTTPS',
      skip: (context) => {
        if (context.options.skipProxy === true) return 'skipped with --skip-proxy';
        if (context.options.domain === undefined) return 'no --domain given';
        return undefined;
      },
      async run(context) {
        const target: ProxyTarget = {
          domain: context.options.domain as string,
          bindPort: context.options.bindPort,
          proxyRoot: context.options.proxyRoot,
        };

        const email =
          context.options.email ?? context.env?.get('INITIAL_ADMIN_EMAIL') ?? '';
        if (email === '') {
          throw new UsageError(
            'A registration email is required for the certificate. Pass --email, or set INITIAL_ADMIN_EMAIL.',
          );
        }

        // The flag, else what the preflight found, else the conventional
        // name - the order doctor itself resolves it in (#122). Recorded in
        // the state so update talks to the same container.
        const proxyContainer =
          context.options.proxyContainer ?? context.proxyContainer ?? DEFAULT_PROXY_CONTAINER;
        context.proxyContainer = proxyContainer;
        // `--no-ipv6` outranks the probe; without either, [::] is rendered.
        const ipv6 = context.options.ipv6 ?? context.ipv6;
        context.journal.line(
          `Publishing through ${proxyContainer}${ipv6 === false ? ' without IPv6 listeners' : ''}`,
        );

        // Certificate FIRST. See rule 4 in the header. The routing self-probe
        // inside it fails before certbot when the domain does not reach here.
        const certificate = await issueCertificate(target, {
          runCommand: context.runCommand,
          proxyContainer,
          email,
          redact: context.journal.redact,
          ...(context.options.staging === undefined ? {} : { staging: context.options.staging }),
          ...(context.options.fetch === undefined ? {} : { fetch: context.options.fetch }),
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
        });
        context.certificateIssued = certificate.issued;

        await installVhost(target, {
          runCommand: context.runCommand,
          proxyContainer,
          ...(ipv6 === undefined ? {} : { ipv6 }),
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
          ...(context.env?.get('MAX_FILE_SIZE') === undefined
            ? {}
            : { maxBodyBytes: Number(context.env.get('MAX_FILE_SIZE')) }),
        });

        if (context.options.installCron ?? certificate.issued) {
          const cron = installRenewalCron({
            name: context.options.name,
            appsRoot: context.options.appsRoot,
            kvoxPath: context.options.cliPath ?? defaultCliPath(),
            ...(context.options.cronDir === undefined ? {} : { cronDir: context.options.cronDir }),
          });
          context.journal.line(`${cron.changed ? 'Wrote' : 'Kept'} ${cron.path}`);
          context.hooks?.onProgress?.(
            cron.changed ? `Installed the renewal cron at ${cron.path}` : `Renewal cron at ${cron.path} is current`,
          );
        }
      },
    },
    {
      id: 'verify',
      title: 'Verify the deployment',
      async run(context) {
        const report = await collectHealth({
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          name: context.options.name,
          bindPort: context.options.bindPort,
          ...(context.options.domain === undefined || context.options.skipProxy === true
            ? {}
            : { domain: context.options.domain }),
        });

        context.journal.line(
          `containers=${report.containers.length} ready=${report.local.ready.ok} frontend=${report.local.frontend.ok} migrations=${report.migrations.known ? report.migrations.pending.length : 'unknown'}`,
        );

        if (!isHealthy(report)) {
          throw new Error(
            'The stack is up but not healthy. Run `' +
              CLI_NAME +
              ' deploy status` for the detail.',
          );
        }
      },
    },
  ];
}

export interface InstallResult {
  deployRoot: string;
  /** The app folder and compose project name. */
  name: string;
  commitSha: string;
  journalPath: string;
  domain?: string | undefined;
  /** The one thing the operator still has to do. */
  nextStep: string;
}

/**
 * Decides where the app lives BEFORE anything is read or written there.
 *
 * The state file and the journal both live under the deploy root, so the root
 * has to be known at entry - which means the name has to be, and by default
 * the name is the repository's. `resolveRepoTarget` only reads git config, so
 * running it here rather than in the `checkout` step costs nothing; the target
 * it returns is kept so that step does not ask twice.
 */
async function resolveInstallLayout(
  options: InstallOptions,
  runCommand: typeof defaultRunCommand,
): Promise<{ layout: ResolvedLayout; target?: RepoTarget | undefined }> {
  const appsRoot = options.appsRoot ?? DEFAULT_APPS_ROOT;

  if (options.deployRoot !== undefined || options.name !== undefined) {
    const layout = locateApp({ appsRoot, name: options.name, root: options.deployRoot });
    if (layout === undefined) {
      // Unreachable: locateApp only answers undefined when neither is given.
      throw new Error('could not resolve the deployment directory');
    }
    return { layout };
  }

  const target = await resolveRepoTarget({
    cwd: options.cwd ?? process.cwd(),
    appsRoot,
    runCommand,
    ...(options.repo === undefined ? {} : { repoFlag: options.repo }),
    ...(options.ref === undefined ? {} : { refFlag: options.ref }),
  });
  const name = appNameFor(target.url);

  return { layout: { name, appsRoot, deployRoot: appRootFor(appsRoot, name) }, target };
}

export async function runInstall(input: InstallOptions): Promise<InstallResult> {
  const runCommand = input.runCommand ?? defaultRunCommand;
  const { layout, target } = await resolveInstallLayout(input, runCommand);
  const options: ResolvedInstallOptions = { ...input, ...layout };

  const existingState = readState(options.deployRoot);

  if (existingState !== undefined && options.reinstall !== true && options.resume !== true) {
    throw new UsageError(
      `A deployment already exists at ${options.deployRoot} (${existingState.commitSha.slice(0, 12)}). Use \`${CLI_NAME} deploy update\` to bring it up to date, or --reinstall to start over.`,
    );
  }

  mkdirSync(options.deployRoot, { recursive: true });
  // Reserved for bind-mounted persistent data; created empty so the layout is
  // complete from the first run and a compose file can mount it unconditionally.
  mkdirSync(join(options.deployRoot, 'data'), { recursive: true });
  // BEFORE the stack starts, and that ordering is the whole point (#133).
  // `vps.compose.yml` bind-mounts `${DEPLOY_ROOT}/deploy-info` into the api
  // container, and the Docker daemon creates a missing bind source as
  // root:root - after which this run's own `writeDeployInfo` below cannot
  // write its temp file there unless the operator is root. On a VPS `install`
  // runs as root and it never shows; in CI it failed the epilogue with EACCES
  // on `deploy-info/info.json.<pid>.tmp` with all thirteen steps green. The
  // directory is the CLI's to write, so the CLI creates it first.
  //
  // Through `ensureDeployInfoDir` rather than a bare `mkdirSync(…, { mode })`
  // (#159): that mode is umask-masked and is a no-op on a directory that
  // already exists, so a `--reinstall` over a root-owned or 0700 deploy-info
  // silently kept it unreadable. The helper chmods unconditionally and, when
  // it cannot, refuses with the `chown` an operator can paste.
  ensureDeployInfoDir(options.deployRoot);

  const journal = openJournal({
    deployRoot: options.deployRoot,
    command: 'install',
    // Seeded from an existing .env so a resumed run redacts from the first
    // line, before the wizard has run again - and from the answers given up
    // front (--answer, --answers-file, the TUI), which count as typed (#127).
    secrets: secretsFrom(
      new Map([...(readEnvFile(options.deployRoot) ?? new Map()), ...(options.answers ?? new Map())]),
    ),
  });

  journal.line(`App ${options.name} at ${options.deployRoot}`);

  const context: InstallContext = {
    options,
    runCommand,
    journal,
    hooks: options.hooks,
    target,
    completed:
      options.resume === true && existingState !== undefined
        ? new Set(existingState.completedSteps ?? [])
        : new Set<string>(),
  };

  const result = await runPipeline(buildInstallSteps(), context);

  if (result.failed !== undefined) {
    journal.finish('failure', `${result.failed.id}: ${result.failed.detail ?? ''}`);
    // A precondition (the preflight, a logged-out gh) keeps its exit code 6.
    throw pipelineFailure(
      result,
      `${result.failed.title} failed: ${result.failed.detail ?? 'unknown error'}\n` +
        `The full log is at ${journal.path}\n` +
        `Fix the cause and re-run with --resume to continue from this step.`,
    );
  }

  const now = new Date().toISOString();
  const state = {
    version: 1,
    repoUrl: context.target?.url ?? '',
    ref: context.target?.ref ?? '',
    commitSha: context.commitSha ?? '',
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    bindPort: options.bindPort,
    deployRoot: options.deployRoot,
    name: options.name,
    appsRoot: options.appsRoot,
    proxyRoot: options.proxyRoot,
    // Resolved once, here; update reads it back rather than detecting again.
    ...((context.proxyContainer ?? existingState?.proxyContainer) === undefined
      ? {}
      : { proxyContainer: context.proxyContainer ?? existingState?.proxyContainer }),
    envPath: envFilePath(options.deployRoot),
    installedAt: existingState?.installedAt ?? now,
    lastDeployedAt: now,
    lastCommand: 'install',
    appctlVersion: CLI_VERSION,
    completedSteps: result.completed,
  } as DeployState;
  writeState(state);

  // AFTER the state: deploy-info is derived from it, and it is the document
  // the running application reads about itself (deploy-info.ts).
  const infoPath = writeDeployInfo(
    options.deployRoot,
    state,
    await collectServerFacts({ runCommand, root: options.deployRoot }),
  );
  journal.line(`Wrote ${infoPath}`);

  journal.finish('success');

  const admin = context.env?.get('INITIAL_ADMIN_EMAIL') ?? 'the admin address';
  const url =
    options.domain === undefined
      ? `http://127.0.0.1:${options.bindPort}`
      : `https://${options.domain}`;

  return {
    deployRoot: options.deployRoot,
    name: options.name,
    commitSha: context.commitSha ?? '',
    journalPath: journal.path,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    // The seed writes the ALLOWLIST row, not a user account. Nobody is an
    // admin until this login happens, and an install that does not say so
    // looks broken.
    nextStep: `Log in at ${url} as ${admin} to claim the Admin role.`,
  };
}

/** The default deploy root for a repository: `<base>/<its name, slugged>`. */
export function defaultRootFor(repoUrl: string, base: string): string {
  return appRootFor(base, appNameFor(repoUrl));
}
