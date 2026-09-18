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
import { isLoopbackPortFree } from './checks/types.js';
import { ensureDeployInfoDir, writeDeployInfo } from './deploy-info.js';
import { dockerPortClaims, type DockerPortClaim } from './docker-ports.js';
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
  locateAppFromCwd,
  siblingBindPorts,
  type ResolvedLayout,
} from './layout.js';
import {
  defaultCliPath,
  hasRenewalCron,
  installRenewalCron,
  installVhost,
  issueCertificate,
  renderRenewalCron,
  renewalCronPath,
  stageRenewalCron,
  type FetchLike,
  type ProxyTarget,
  type RenewalCronOptions,
} from './proxy.js';
import {
  ensureCheckout,
  ensureGitHubAuth,
  githubSlug,
  resolveRepoTarget,
  type RepoTarget,
} from './repo.js';
import { collectServerFacts } from './server-facts.js';
import {
  DEPLOY_STATE_VERSION,
  deployStatePath,
  readState,
  writeState,
  type DeployState,
} from './state.js';
import { discardLocalState } from './teardown.js';
import { pipelineFailure, runPipeline, type DeployStep, type StepContext } from './steps/pipeline.js';
import { metadataFor } from './env-metadata.js';
import {
  publishVersion,
  runVersionStep,
  type VersionPlan,
  type VersionStepIo,
} from './version-step.js';
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
  /**
   * `--fresh` (#261): discard this app's prior LOCAL state - the `.env`, the
   * state file and `deploy-info/` - and install clean, after backing the
   * `.env` up outside the deploy root.
   *
   * THE CONVENIENCE PATH FOR THE CASE THAT CAUSED #259, and deliberately much
   * narrower than `deploy uninstall`: it does not touch the containers, the
   * proxy vhost, the certificate or the database, so it needs no typed
   * confirmation - nothing irreversible is destroyed, because the backup is
   * taken first and the clone is re-fetched anyway.
   *
   * It implies `--reinstall`: discarding the state file and then refusing
   * because a state file exists would be a contradiction one line apart.
   */
  fresh?: boolean | undefined;
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
  /**
   * `--app-version <semver>` (#295): the version to deploy, explicitly. Wins
   * over the prompt and over the suggestion; refused if it is not SemVer or
   * does not sort above the current version.
   */
  appVersion?: string | undefined;
  /**
   * `--no-version-bump` sets this false: deploy without touching the version.
   * Undefined means "bump" — see `chooseVersion` for why the unattended
   * default is the suggestion rather than a refusal.
   */
  versionBump?: boolean | undefined;
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
   * `--install-cron` / `--no-install-cron`. Undefined means "when this
   * deployment has no renewal entry yet" (#265) - NOT "when this run issued a
   * certificate", which is what it used to mean and which made `--resume`
   * after a failed cron write report success over a certificate nothing
   * renews. An existing certificate with no entry is precisely the state that
   * needs one; `--install-cron` still forces the write either way.
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
   * The loopback bind probe the pre-`up -d` re-check uses (#257). Injected by
   * tests; the real one binds 127.0.0.1, which a unit test must not do.
   */
  portFree?: ((port: number) => Promise<boolean>) | undefined;
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
  /**
   * What the `version` step decided (#295); undefined with
   * `--no-version-bump`, and on a `--resume` that skipped that step.
   */
  version?: VersionPlan | undefined;
  /** Whether `publish-version` got the bump commit onto the deployed branch. */
  versionPublished?: boolean | undefined;
  /**
   * Work the run could not do and the operator now has to (#265). Surfaced at
   * the END of the run, beside `nextStep`, not only in the journal: an install
   * that completed without a renewal schedule must never be silent about it.
   */
  warnings: string[];
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

/**
 * The port was free when it was chosen. Is it still?  (issue #257)
 *
 * Between the wizard and this line sit the build, the migration and the seed -
 * four minutes in a real install, and nothing re-checked in between. A port
 * taken during that window surfaces today as `up -d` failing with docker's own
 * message, or worse as a health timeout six steps later, neither of which says
 * "something else took your port".
 *
 * IT DOES NOT RE-PICK. The operator may already have pointed DNS or an external
 * proxy at that port; a port that changes underneath them is worse than a clear
 * refusal, so this raises a UsageError naming the port, the container holding
 * it where docker can say, and the flag that overrides it.
 *
 * THE APP'S OWN CONTAINERS ARE NOT A COLLISION. A `--resume` after a failed
 * health step - or a plain reinstall - finds this deployment's own nginx still
 * holding the port, which `up -d` is about to recreate. They are told apart by
 * the compose PROJECT label, which is the app name (`COMPOSE_PROJECT_NAME`),
 * and they also suppress the bind probe: our own container is listening, and
 * that is not evidence of anybody else.
 *
 * Docker being unreachable answers an empty list, exactly as it does in the
 * scan, and the bind probe alone decides. This must not become the step that
 * makes docker a hard requirement of a command whose next line runs docker.
 */
async function assertBindPortStillFree(context: InstallContext): Promise<void> {
  const port = context.options.bindPort;
  const claims = await dockerPortClaims({
    cwd: context.options.deployRoot,
    runCommand: context.runCommand,
  });

  const onPort = claims.filter((claim) => claim.port === port);
  const ours = onPort.filter((claim) => claim.project === context.options.name);
  const foreign = onPort.filter((claim) => claim.project !== context.options.name);

  if (foreign.length > 0) {
    throw new UsageError(refusal(port, foreign));
  }

  // Our own container holds it and is about to be recreated on the same port.
  if (ours.length > 0) {
    context.journal.line(
      `Port ${port} is held by this deployment's own container(s) ${ours
        .map((claim) => claim.name)
        .join(', ')}; recreating them.`,
    );
    return;
  }

  const portFree = context.options.portFree ?? isLoopbackPortFree;
  if (!(await portFree(port))) {
    throw new UsageError(refusal(port, []));
  }
}

function refusal(port: number, holders: readonly DockerPortClaim[]): string {
  const who =
    holders.length === 0
      ? 'Something is listening on it that was not there when the port was chosen'
      : `It is held by container ${holders.map((claim) => claim.name).join(', ')}`;
  return (
    `Port ${port} was free when it was chosen and is not free now. ${who}.\n` +
    `Nothing was started, and the port was NOT changed automatically: an external proxy ` +
    `or DNS record may already point at it.\n` +
    `Free the port, or re-run with --answer APP_BIND_PORT=<n> to publish on another one.`
  );
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
        // The third source (#257): every host port docker has promised any
        // container, STOPPED ONES INCLUDED. Neither of the two above can see a
        // stopped container this CLI did not install. An empty answer - no
        // docker, no socket, a timeout - is ordinary and costs only what it
        // was going to catch.
        const dockerPorts = await dockerPortClaims({
          cwd: context.options.deployRoot,
          runCommand: context.runCommand,
        });

        const result = await runEnvWizard({
          specs,
          // Asked in the wizard's own domain step when not given (#127); an
          // unattended run without one is reported there as unresolved.
          ...(context.options.domain === undefined ? {} : { domain: context.options.domain }),
          ...(existing === undefined ? {} : { existing }),
          facts,
          siblingPorts,
          dockerPorts,
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
      id: 'version',
      title: 'Set the application version',
      async run(context) {
        // Resolved rather than read off the context: a `--resume` that skips
        // `checkout` leaves `context.target` unset, and the publish step needs
        // the REF to decide whether there is a branch to push to. `resolveTarget`
        // caches, so this costs nothing on an ordinary run.
        await resolveTarget(context);
        // AFTER the environment, not merely after the checkout (#295 places it
        // "after checkout and before build"). The number has to reach the
        // deployment's `.env` as `APP_VERSION`, and on a first install that
        // file does not exist until the `environment` step writes it — setting
        // it any earlier would write into nothing.
        context.version = await runVersionStep(versionIo(context));
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
        await assertBindPortStillFree(context);
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

        const cronOptions: RenewalCronOptions = {
          name: context.options.name,
          appsRoot: context.options.appsRoot,
          kvoxPath: context.options.cliPath ?? defaultCliPath(),
          ...(context.options.cronDir === undefined ? {} : { cronDir: context.options.cronDir }),
        };

        // "Does this deployment have a renewal schedule?", not "did this run
        // issue a certificate?" (#265). `--install-cron` still forces it.
        const wanted =
          context.options.installCron ??
          !hasRenewalCron(context.options.name, context.options.cronDir);

        if (wanted) ensureRenewalCron(context, cronOptions);
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
    {
      id: 'publish-version',
      title: 'Publish the version to the repository',
      skip: (context) =>
        context.version === undefined
          ? 'no version bump was made on this run'
          : undefined,
      async run(context) {
        await publishVersionFor(context);
      },
    },
  ];
}

/** The `version` step's view of an install. */
function versionIo(context: InstallContext): VersionStepIo {
  return {
    deployRoot: context.options.deployRoot,
    ref: context.target?.ref ?? context.options.ref ?? '',
    command: 'install',
    runCommand: context.runCommand,
    journal: context.journal,
    ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
    ...(context.env === undefined ? {} : { env: context.env }),
    ...(context.options.appVersion === undefined
      ? {}
      : { appVersion: context.options.appVersion }),
    ...(context.options.versionBump === undefined
      ? {}
      : { versionBump: context.options.versionBump }),
    ...(context.options.nonInteractive === undefined
      ? {}
      : { nonInteractive: context.options.nonInteractive }),
    ...(context.options.promptContext === undefined
      ? {}
      : { promptContext: context.options.promptContext }),
  };
}

/**
 * Pushes the version bump, and NEVER lets that decide the install (#295, #265).
 *
 * The identical shape — and the identical reason — as `ensureRenewalCron`
 * below: the deployment is complete when this runs. It is built, migrated,
 * seeded, healthy, published behind the proxy and verified. Recording the
 * number in the repository afterwards is bookkeeping, and bookkeeping must
 * never take a finished deployment down with it. A fork with no push access,
 * a tag deploy with no branch to push to and a race lost to another server
 * are all NORMAL, and each becomes a warning the operator reads at the end of
 * the run rather than a failed install of a server that is already serving.
 */
async function publishVersionFor(context: InstallContext): Promise<void> {
  const plan = context.version;
  if (plan === undefined) return;

  const outcome = await publishVersion(versionIo(context), plan);
  context.versionPublished = outcome.published;
  // ⚠ THE DEPLOYED COMMIT BECOMES THE BUMP COMMIT, and this is a
  // correctness fix rather than bookkeeping. The images were built with
  // HEAD at the bump commit — the `version` step commits BEFORE `build`
  // — so its tree is exactly what is deployed. Leaving the state naming
  // the PRE-bump commit while origin now points at the bump commit would
  // make every server permanently report `1 commit behind` itself, and
  // the next `update` would rebuild byte-identical code and bump again,
  // for ever.
  //
  // Only on a SUCCESSFUL push. When the publish is declined the bump
  // commit is rolled back out of the clone and exists nowhere, so the
  // pre-bump commit stays the honest answer.
  if (outcome.published) context.commitSha = plan.commitSha;

  if (outcome.warning !== undefined) {
    context.warnings.push(outcome.warning);
    context.hooks?.onProgress?.(
      `v${plan.next} is deployed but was not published to the repository`,
    );
  }
}

/**
 * Writes the renewal cron, and NEVER lets that decide the install.  (issue #265)
 *
 * THE DEPLOYMENT IS COMPLETE WHEN THIS RUNS. The certificate has been issued
 * and the vhost is live and reloaded; the only thing left is scheduling a
 * renewal 60-90 days out. `/etc/cron.d` is root:root and this CLI is
 * deliberately never run as root (#236: sudo resets HOME, which logs `gh`
 * out), so on a standard server this write fails - and it used to take the
 * whole step, and with it the whole install, down with it. Worse, the obvious
 * retry was `--resume`, which then re-ran `publish` and called certbot again
 * against a rate limit for a certificate that already existed.
 *
 * So the failure is recorded rather than thrown. NOT swallowed: it becomes a
 * warning carrying the error as reported, the staged file, and the one line
 * that installs it - and that warning is printed at the end of the run, next
 * to `nextStep`, where the operator is looking.
 *
 * Every error is caught, not only EACCES. A cron directory that is read-only
 * (EROFS), a path that is not a directory (ENOTDIR) or anything else leaves
 * exactly the same deployment behind: complete, serving, unscheduled. Naming
 * one errno here would make every other one fail an install that succeeded.
 */
function ensureRenewalCron(context: InstallContext, options: RenewalCronOptions): void {
  try {
    const cron = installRenewalCron(options);
    context.journal.line(`${cron.changed ? 'Wrote' : 'Kept'} ${cron.path}`);
    context.hooks?.onProgress?.(
      cron.changed ? `Installed the renewal cron at ${cron.path}` : `Renewal cron at ${cron.path} is current`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const target = renewalCronPath(options.name, options.cronDir);
    context.journal.line(`Could not write ${target}: ${reason}`);
    context.warnings.push(renewalCronWarning(context, options, reason));
    context.hooks?.onProgress?.(
      `Could not write ${target}; the install continues and says how to finish it`,
    );
  }
}

/**
 * The hand-installation instructions, hard-wrapped rather than left to the
 * terminal - the renderer indents this, and an operator's eye skips a wall of
 * reflowed text, which is the outcome this warning exists to avoid (#261).
 */
function renewalCronWarning(
  context: InstallContext,
  options: RenewalCronOptions,
  reason: string,
): string {
  const target = renewalCronPath(options.name, options.cronDir);

  let howTo: string[];
  try {
    // Into the deploy root: this run has been writing there all along, and
    // `uninstall` removes that directory entry by entry, so the staged copy
    // does not outlive the deployment it belongs to.
    const staged = stageRenewalCron(options, context.options.deployRoot);
    howTo = [
      `The exact file has been written to ${staged.path}.`,
      'Put it in place with:',
      '',
      `  ${staged.command}`,
    ];
  } catch {
    // The deploy root is writable in every ordinary case; if it is not, the
    // contents are still worth having, even though they have to be typed.
    howTo = [
      `Create ${target}, mode 0644, owned by root, containing:`,
      '',
      ...renderRenewalCron(options).replace(/\n$/, '').split('\n').map((line) => `  ${line}`),
    ];
  }

  return [
    'WARNING: automatic certificate renewal is NOT scheduled.',
    '',
    'The certificate was issued and the site is serving HTTPS - the install',
    'itself is complete. What is missing is the entry that renews the',
    'certificate in 60-90 days, because writing',
    '',
    `  ${target}`,
    '',
    `needs root, and ${CLI_NAME} is deliberately never run under sudo (it resets`,
    'HOME, which logs `gh` out). It reported:',
    '',
    `  ${reason}`,
    '',
    ...howTo,
    '',
    'Then confirm it is there:',
    '',
    `  ls ${options.cronDir ?? '/etc/cron.d'}/${CLI_NAME}-certs-*`,
  ].join('\n');
}

export interface InstallResult {
  deployRoot: string;
  /** The app folder and compose project name. */
  name: string;
  commitSha: string;
  journalPath: string;
  domain?: string | undefined;
  /**
   * The application version this run deployed (#295); absent with
   * `--no-version-bump`. `published` says whether it also reached the
   * repository — false is normal (a fork, a tag deploy, a lost race) and is
   * accompanied by a warning.
   */
  appVersion?: { version: string; published: boolean } | undefined;
  /** The one thing the operator still has to do. */
  nextStep: string;
  /**
   * Work this run could not finish, each entry ready to be printed as-is
   * (#265). Empty on an ordinary install. A renewal cron the CLI could not
   * write lands here rather than failing the run, so the operator is told at
   * the end instead of finding out when the certificate expires.
   */
  warnings: string[];
}

/**
 * Decides where the app lives BEFORE anything is read or written there.
 *
 * The state file and the journal both live under the deploy root, so the root
 * has to be known at entry - which means the name has to be, and by default
 * the name is the repository's. `resolveRepoTarget` only reads git config, so
 * running it here rather than in the `checkout` step costs nothing; the target
 * it returns is kept so that step does not ask twice.
 *
 * Three ranks, strongest first:
 *
 *   1. `--root`/`--name`, and `--repo` for the repository itself.
 *   2. THE DEPLOYMENT cwd IS STANDING IN (#266) - a state file at cwd or at an
 *      ancestor below the apps root.
 *   3. The git checkout around cwd.
 *
 * RANK 2 EXISTS BECAUSE RANK 3 ANSWERED A QUESTION IT COULD NOT ANSWER. Run
 * from `/opt/infra/apps/<app>` - a deploy root, with a state file naming the
 * repository, the ref and the name - the walk went straight past it into the
 * server's own infrastructure repository at `/opt/infra` and tripped #247's
 * guard, telling the operator to re-supply with `--repo` what was already on
 * disk one directory away. That is the circularity #249 documented and did
 * not fix: the deploy root is derived before any state is read, so the most
 * natural place to run `--resume` was the one place it could not work.
 *
 * A state file is not an inference. This CLI wrote it, and it names the
 * deployment outright - which is why it outranks a git remote, and why it
 * settles the deploy root as well as the target. Deriving the root from the
 * state's repository URL instead would be a second guess on top of a fact: a
 * deployment installed with `--name <app>-staging` lives in a directory its
 * repository's name does not spell.
 */
async function resolveInstallLayout(
  options: InstallOptions,
  runCommand: typeof defaultRunCommand,
): Promise<{ layout: ResolvedLayout; target?: RepoTarget | undefined }> {
  const appsRoot = options.appsRoot ?? DEFAULT_APPS_ROOT;
  const cwd = options.cwd ?? process.cwd();

  if (options.deployRoot !== undefined || options.name !== undefined) {
    const layout = locateApp({ appsRoot, name: options.name, root: options.deployRoot });
    if (layout === undefined) {
      // Unreachable: locateApp only answers undefined when neither is given.
      throw new Error('could not resolve the deployment directory');
    }
    return { layout };
  }

  // `--repo` names a repository the operator may be standing nowhere near, and
  // it has always decided the deploy root through `appNameFor`. It keeps that:
  // rank 2 is what happens when NOTHING was named.
  if (options.repo === undefined) {
    const here = locateAppFromCwd({ appsRoot, cwd });
    if (here !== undefined) {
      // Through `resolveRepoTarget`'s own `state` rank rather than by building
      // a target by hand, so `--ref` still overrides the recorded ref in the
      // one place that rule is written down. It runs no command: a state file
      // answers before git is consulted.
      const target = await resolveRepoTarget({
        cwd,
        appsRoot,
        runCommand,
        state: here.state,
        ...(options.ref === undefined ? {} : { refFlag: options.ref }),
      });
      return { layout: here.layout, target };
    }
  }

  const target = await resolveRepoTarget({
    cwd,
    appsRoot,
    runCommand,
    ...(options.repo === undefined ? {} : { repoFlag: options.repo }),
    ...(options.ref === undefined ? {} : { refFlag: options.ref }),
  });
  const name = appNameFor(target.url);

  return { layout: { name, appsRoot, deployRoot: appRootFor(appsRoot, name) }, target };
}

/**
 * How the deployment directory was decided, for the resume refusal (#249).
 *
 * Exported for its own test: three of the four wordings are reachable through
 * `runInstall`, and the fourth - the state file - deliberately is not, because
 * finding one is exactly what stops that refusal from firing. It is still
 * rendered honestly rather than left to fall through to the guess, and it
 * names the file, since "an existing deployment state" and a path an operator
 * can `cat` are not the same answer.
 */
export function describeLayoutSource(
  target: RepoTarget | undefined,
  deployRoot: string,
): string {
  if (target === undefined) return 'taken from --name/--root';
  switch (target.source) {
    case 'flag':
      return 'derived from --repo';
    case 'state':
      return `taken from the deployment state at ${deployStatePath(deployRoot)}`;
    case 'git-remote':
      return 'GUESSED from the git checkout around the current directory';
  }
}

/** Everything `buildInstallState` needs that is not the run's own ending. */
interface InstallStateInput {
  options: ResolvedInstallOptions;
  context: InstallContext;
  /** The state this run found at entry, or undefined for a first install. */
  existingState: DeployState | undefined;
  /** Step ids that completed, as the pipeline reported them. */
  completed: readonly string[];
  /** One instant for the whole epilogue, so two fields cannot disagree. */
  now: string;
}

/**
 * The install's state record - ONE BUILDER, both endings (#267).
 *
 * A success and a failure differ in exactly three things: whether
 * `lastDeployedAt` is stamped, and the two fields that name the failure. Every
 * other field has to be identical, because the failure record's entire job is
 * to be the file `--resume` reads back - and two object literals fifty lines
 * apart would drift the moment one of them gained a field. (The success
 * literal this replaces had already gained `proxyContainer` and `envPath`
 * since it was written.)
 *
 * THE THREE IDENTITY FIELDS FALL BACK TO THE EXISTING STATE, and that is not
 * defensive padding. A resumed run skips the `checkout` step, so
 * `context.commitSha` and `context.target` are never set on that path: without
 * the fallback the run that finally SUCCEEDS would record an empty commit and
 * an empty repository URL, and `deploy-info` would publish them - the state
 * file's only job being to say what is deployed here.
 *
 * `existingState` is read after `--fresh` has already discarded the old
 * record, so nothing here can resurrect what `--fresh` deliberately removed.
 */
function buildInstallState(
  input: InstallStateInput,
  ending:
    | { outcome: 'success' }
    | { outcome: 'failure'; failedStep: string },
): DeployState {
  const { options, context, existingState, completed, now } = input;
  const proxyContainer = context.proxyContainer ?? existingState?.proxyContainer;

  return {
    version: DEPLOY_STATE_VERSION,
    repoUrl: context.target?.url ?? existingState?.repoUrl ?? '',
    ref: context.target?.ref ?? existingState?.ref ?? '',
    commitSha: context.commitSha ?? existingState?.commitSha ?? '',
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    bindPort: options.bindPort,
    deployRoot: options.deployRoot,
    name: options.name,
    appsRoot: options.appsRoot,
    proxyRoot: options.proxyRoot,
    // Resolved once, here; update reads it back rather than detecting again.
    ...(proxyContainer === undefined ? {} : { proxyContainer }),
    envPath: envFilePath(options.deployRoot),
    installedAt: existingState?.installedAt ?? now,
    // STAMPED ONLY ON SUCCESS. A failed run carries forward whatever earlier
    // success there was, and a FIRST failed install carries nothing at all -
    // absent means "no deploy has ever completed here". Stamping `now` on a
    // failure is precisely the lie #120 removed from `update`, and the
    // "already exists" refusal in `runInstall` reads this field to tell a
    // half-finished first install from a real deployment.
    ...(ending.outcome === 'success'
      ? { lastDeployedAt: now }
      : existingState?.lastDeployedAt === undefined
        ? {}
        : { lastDeployedAt: existingState.lastDeployedAt }),
    ...(ending.outcome === 'success' ? {} : { lastAttemptAt: now }),
    lastCommand: 'install',
    lastOutcome: ending.outcome,
    ...(ending.outcome === 'failure' ? { lastFailedStep: ending.failedStep } : {}),
    appctlVersion: CLI_VERSION,
    completedSteps: [...completed],
  } as DeployState;
}

export async function runInstall(input: InstallOptions): Promise<InstallResult> {
  const runCommand = input.runCommand ?? defaultRunCommand;
  const { layout, target } = await resolveInstallLayout(input, runCommand);
  const options: ResolvedInstallOptions = { ...input, ...layout };

  // BEFORE the state is read: `--fresh` means this deployment's prior local
  // state is not consulted at all, and the refusal below keys on exactly that
  // state. Reading it first and discarding it after would leave `reinstall`
  // deciding whether a state file we are about to delete blocks the install.
  if (options.fresh === true) {
    const discarded = discardLocalState({
      appsRoot: options.appsRoot,
      name: options.name,
      deployRoot: options.deployRoot,
    });
    if (discarded.backup !== undefined) {
      // Not through the journal: it has not been opened yet, and it lives
      // under the very deploy root this is clearing part of.
      input.hooks?.onProgress?.(`Backed up the previous .env to ${discarded.backup.path}`);
    }
    for (const outcome of discarded.removed.filter((entry) => entry.existed)) {
      input.hooks?.onProgress?.(`Discarded ${outcome.path}`);
    }
  }

  const existingState = readState(options.deployRoot);

  // `--resume` means "continue the run that failed". If there is nothing to
  // continue, saying so is the only honest answer (#249).
  //
  // Silently carrying on made this the worst kind of wrong: the deploy root
  // above is derived from the repository, and without --repo/--name/--root
  // that comes from the `origin` of whatever checkout walking up from cwd
  // happens to find. So a --resume that found no state did not resume - it
  // started a BRAND-NEW install against a repository nobody had named, and
  // reported it only as a permission error on a directory the operator had
  // never heard of.
  //
  // Note the ordering this message has to explain: the deploy root is derived
  // BEFORE any state is read, so `--resume` cannot locate a state file unless
  // the caller has already identified the deployment. That is why the remedy
  // names the flags rather than suggesting the command be re-run as-is.
  if (options.resume === true && existingState === undefined) {
    throw new UsageError(
      `Nothing to resume: no deployment state at ${options.deployRoot}.\n` +
        `That directory was ${describeLayoutSource(target, options.deployRoot)}, and the state file is looked for inside it — ` +
        `so a resume can only find the run you mean once that run's deployment is named.\n` +
        `Name it with --name <app> (or --root <dir>, or --repo <url>), or drop --resume to start a new install.`,
    );
  }

  // A HALF-FINISHED FIRST INSTALL IS NOT "A DEPLOYMENT ALREADY EXISTS" (#267).
  //
  // Since this run now writes a state file when the pipeline FAILS, the file
  // alone stopped meaning "something is deployed here" - and without this
  // clause the fix would have broken the ordinary retry it exists to enable:
  // install fails, the operator fixes the cause, re-runs `install` with no
  // flags, and is told to pass --reinstall to start over a deployment that
  // never happened.
  //
  // The test is `lastDeployedAt`, not `lastOutcome`, and the difference
  // matters. A failed run carries an earlier success's `lastDeployedAt`
  // forward, so a failed REINSTALL over a real deployment still has one and is
  // still refused - the containers, the certificate and the database it would
  // clobber are all still there. Only a root where no deploy has ever
  // completed is let through.
  if (
    existingState !== undefined &&
    existingState.lastDeployedAt !== undefined &&
    options.reinstall !== true &&
    options.fresh !== true &&
    options.resume !== true
  ) {
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
    warnings: [],
  };

  const result = await runPipeline(buildInstallSteps(), context);
  const now = new Date().toISOString();
  const stateInput: InstallStateInput = {
    options,
    context,
    existingState,
    completed: result.completed,
    now,
  };

  if (result.failed !== undefined) {
    // ==========================================================================
    // THE STATE IS WRITTEN ON THIS PATH TOO, AND THAT IS THE WHOLE OF #267.
    // ==========================================================================
    //
    // `--resume` reads `completedSteps` out of the state file, and the state
    // file used to be written only after the pipeline had finished - so
    // `--resume` could only ever resume a run that had nothing left to
    // resume. `result.completed` was computed right here and thrown away on
    // exactly the path that needed it, while the message three lines below
    // told the operator to use the flag it had just made useless. The answer
    // was always "Nothing to resume: no deployment state at <root>".
    //
    // It is written BEFORE `journal.finish`, so a failure to write it is
    // itself journaled - and it must never replace the pipeline's own error,
    // which is the operator's actual problem. A full disk that stops the
    // record being kept is a worse second run, not a different first failure.
    try {
      const path = writeState(
        buildInstallState(stateInput, { outcome: 'failure', failedStep: result.failed.id }),
      );
      journal.line(
        `Recorded ${result.completed.length} completed step(s) in ${path}; ` +
          `\`--resume\` will re-enter at ${result.failed.id}.`,
      );
    } catch (error) {
      journal.line(
        `Could not record the completed steps: ${error instanceof Error ? error.message : String(error)}. ` +
          `A re-run will start from the beginning.`,
      );
    }

    // ==========================================================================
    // AND `deploy-info` TOO, BUT ONLY ONCE `health` HAS PASSED (#283).
    // ==========================================================================
    //
    // #267 withheld this document from every failed run: "it is what the
    // running application reports about itself, and an install that did not
    // finish has not deployed what it would claim." That holds for a failure
    // at `build`, `migrate` or `start` - nothing is serving, and a record
    // would describe a deployment that does not exist.
    //
    // It stops holding the moment the API answers. A real install failed at
    // `publish`, after the stack was up, migrated, seeded and healthy and the
    // certificate was issued - and the About page told the administrator
    // "this instance was not deployed with the deploy CLI", which is a worse
    // lie than "deployed, and the run did not finish" by exactly the margin
    // between a wrong fact and a missing one.
    //
    // THE GATE IS `health`, NOT `verify`. `health` IS the claim this document
    // makes - `waitForHealthy` polls `/api/health/ready` until the
    // application answers, so a run past it has a deployment that demonstrably
    // exists. `verify` is the LAST step, so gating on it would write the
    // document on success and essentially nowhere else, leaving the reported
    // failure (a `publish` that comes between them) reporting nothing at all.
    //
    // `result.completed` is the pipeline's own record, and `health` carries
    // no `skip` guard - it either ran and passed on this run, or it was
    // carried in from the state a previous run left for `--resume`, which is
    // the same claim. A step skipped by a guard is in neither list
    // (steps/pipeline.ts), so this cannot read a `--skip-*` as a pass.
    //
    // Failing to write it must not replace the operator's actual problem,
    // exactly like the state write above - and it comes AFTER that write for
    // the reason the success path states: deploy-info is derived from the
    // state.
    if (result.completed.includes('health')) {
      try {
        const infoPath = writeDeployInfo(
          options.deployRoot,
          buildInstallState(stateInput, { outcome: 'failure', failedStep: result.failed.id }),
          await collectServerFacts({ runCommand, root: options.deployRoot }),
          {
            run: { completed: false, failedStep: result.failed.id, attemptedAt: now },
            ...deployedVersion(context),
          },
        );
        journal.line(`Wrote ${infoPath}, marked incomplete at ${result.failed.id}.`);
      } catch (error) {
        journal.line(
          `Could not write deploy-info: ${error instanceof Error ? error.message : String(error)}. ` +
            `About will report no deployment record.`,
        );
      }
    }

    journal.finish('failure', `${result.failed.id}: ${result.failed.detail ?? ''}`);
    // A precondition (the preflight, a logged-out gh) keeps its exit code 6.
    throw pipelineFailure(
      result,
      `${result.failed.title} failed: ${result.failed.detail ?? 'unknown error'}\n` +
        `The full log is at ${journal.path}\n` +
        `Fix the cause and re-run with --resume to continue from this step.`,
    );
  }

  const state = buildInstallState(stateInput, { outcome: 'success' });
  writeState(state);

  // AFTER the state: deploy-info is derived from it, and it is the document
  // the running application reads about itself (deploy-info.ts).
  const infoPath = writeDeployInfo(
    options.deployRoot,
    state,
    await collectServerFacts({ runCommand, root: options.deployRoot }),
    deployedVersion(context),
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
    // From the state rather than from the context: a resumed run skips the
    // `checkout` step, so `context.commitSha` is unset on exactly the path
    // that now reaches here (#267), and the result would report nothing
    // deployed for a deployment that just came up.
    commitSha: state.commitSha,
    journalPath: journal.path,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    // The seed writes the ALLOWLIST row, not a user account. Nobody is an
    // admin until this login happens, and an install that does not say so
    // looks broken.
    nextStep: `Log in at ${url} as ${admin} to claim the Admin role.`,
    ...(context.version === undefined
      ? {}
      : {
          appVersion: {
            version: context.version.next,
            published: context.versionPublished === true,
          },
        }),
    warnings: context.warnings,
  };
}

/**
 * The version deploy-info must report, when this run chose one (#295).
 *
 * WITHOUT THIS THE RECORD WOULD LIE AFTER A FAILED PUSH. `buildDeployInfo`
 * defaults `app.version` to `readDeployedAppVersion`, which reads the CLONE —
 * and `publishVersion` restores the clone to the pre-bump commit when it
 * cannot publish, so the clone reports the OLD number while the running image
 * and the `.env` carry the new one. The deployment's own record has to say
 * what is deployed.
 *
 * Empty when no version was chosen (`--no-version-bump`, or a `--resume` past
 * the step), which leaves `buildDeployInfo`'s existing default in place.
 */
function deployedVersion(context: InstallContext): { appVersion?: string } {
  return context.version === undefined ? {} : { appVersion: context.version.next };
}

/** The default deploy root for a repository: `<base>/<its name, slugged>`. */
export function defaultRootFor(repoUrl: string, base: string): string {
  return appRootFor(base, appNameFor(repoUrl));
}
