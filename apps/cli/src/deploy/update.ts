import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { PreconditionError, UsageError } from '../errors.js';
import { CLI_VERSION } from '../package-info.js';
import {
  ALL_CHECKS,
  DEFAULT_PROXY_CONTAINER,
  DEVNET_CHECK_ID,
  checksPassed,
  runChecks,
  type CheckContext,
} from './checks/index.js';
import { adoptDeployment, renderAdoption, type Adoption, type AdoptionNotice } from './adopt.js';
import {
  ensureDeployInfoDir,
  readDeployInfo,
  updateDeployInfoRemote,
  writeDeployInfo,
  type DeployRemote,
  type DeployRun,
} from './deploy-info.js';
import { ensureComposeEnvLink, envFilePath, readEnvFile, writeEnvFile } from './env-file.js';
import { diffEnv, parseEnvExample, serializeEnvFile } from './env-spec.js';
import { metadataFor } from './env-metadata.js';
import { runEnvWizard } from './env-wizard.js';
import { runCommand as defaultRunCommand } from './executor.js';
import { collectHealth, isHealthy, waitForHealthy } from './health.js';
import type { DeployHooks } from './hooks.js';
import { openJournal, type Journal, type Redactor } from './journal.js';
import { DEFAULT_PROXY_ROOT, projectNameFor } from './layout.js';
import {
  certificateExpiry,
  certificateStatus,
  installVhost,
  issueCertificate,
  renewCertificates,
  type FetchLike,
  type ProxyTarget,
} from './proxy.js';
import {
  compareRevisions,
  ensureCheckout,
  ensureGitHubAuth,
  fetchRemote,
  githubSlug,
  resolveRepoTarget,
  type FetchResult,
  type RepoTarget,
} from './repo.js';
import { collectServerFacts } from './server-facts.js';
import { readState, writeState, type DeployState } from './state.js';
import { pipelineFailure, runPipeline, type DeployStep, type StepContext } from './steps/pipeline.js';
import { composeArgv, composeCwd, secretsFrom } from './install.js';
import type { PromptContext } from '../prompt.js';

// =============================================================================
// `kvox deploy update`  (issue #182, epic #168)
// =============================================================================
//
// Installing is the rare operation; updating is the one performed weekly, often
// while something is already broken. It needs different behaviour from install,
// not a flag on it - the PRECONDITIONS ARE OPPOSITE. Install refuses when a
// deployment is already there; update refuses when one is not. One command with
// two contradictory guards is harder to reason about than two commands.
//
// UPDATE'S HALF OF THAT USED TO BE KEYED ON THE STATE FILE, AND THAT WAS THE
// WRONG FACT (#285). The state file is bookkeeping; the deployment is the
// clone, the .env and the running containers. A server serving HTTPS on a
// certificate this CLI issued could not be updated because `.appctl-deploy
// .json` was missing - and the refusal sent the operator to `install`, whose
// own precondition is the opposite. `update` now asks whether a DEPLOYMENT is
// here, and rebuilds the bookkeeping from the disk when it is: see
// `adopt.ts`, which holds the evidence gate and what each field is read from.
// The refusal is unchanged for a directory that really is not a deployment.
//
// TWO DECISIONS WORTH KNOWING ABOUT:
//
//   1. IT RE-SEEDS BY DEFAULT, which the shell scripts this replaces did not.
//      prisma/seed.ts is entirely upserts, and it is also how NEW PERMISSIONS
//      reach an existing deployment. A release that adds a permission and
//      grants it to the admin role does nothing on a server that never
//      re-seeds; the feature ships, the permission does not exist, and it
//      surfaces as a confusing 403 rather than as a deployment error.
//      --skip-seed restores the old behaviour.
//
//   2. THERE IS NO AUTOMATIC ROLLBACK. A partially-applied migration cannot be
//      undone by checking out the old code, and a tool that claims otherwise
//      causes worse outages than one that stops and reports. A failed update
//      leaves the previous SHA recorded and hands back the command to redeploy
//      it, which is an honest manual recovery path.
//
//   3. IT SHOWS ITS DIFF FIRST, AND `--check` STOPS THERE (issue #123, epic
//      #118 decision 12). The `fetch` step fetches and resolves WITHOUT moving
//      the clone, works out `current -> latest, N commits behind` and the
//      subjects, records `remote` in deploy-info, and only then checks out.
//      With `--check` the pipeline ends at that step: no checkout, no state
//      write, no build - an answer to "is there anything to update?" that a
//      cron, the About page and the TUI's confirmation can all rely on to
//      have changed nothing. Update itself stays a deliberate human action:
//      there is no auto-update when behind, and no update cron.
// =============================================================================

export interface UpdateOptions {
  deployRoot: string;
  ref?: string | undefined;
  force?: boolean | undefined;
  noCache?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  skipSeed?: boolean | undefined;
  skipProxy?: boolean | undefined;
  /** `--skip-github`: never consult `gh`; see InstallOptions.skipGithub. */
  skipGithub?: boolean | undefined;
  /**
   * `--check`: fetch, compare and report, then stop. Nothing is checked out,
   * built or written except deploy-info's `remote`.
   */
  check?: boolean | undefined;
  /** `--proxy-container`; otherwise the state's, else the preflight's find. */
  proxyContainer?: string | undefined;
  /** `--no-ipv6`: render the vhost without `[::]` listeners. */
  ipv6?: boolean | undefined;
  runCommand?: typeof defaultRunCommand | undefined;
  hooks?: DeployHooks | undefined;
  promptContext?: PromptContext | undefined;
  cwd?: string | undefined;
  /** Values collected elsewhere; see InstallOptions.answers. */
  answers?: ReadonlyMap<string, string> | undefined;
  /** Injected so the routing self-probe is testable without public DNS. */
  fetch?: FetchLike | undefined;
}

interface UpdateContext extends StepContext {
  options: UpdateOptions;
  runCommand: typeof defaultRunCommand;
  journal: Journal;
  state: DeployState;
  /** The compose project name, from the state (or the directory, pre-#119). */
  name: string;
  target?: RepoTarget | undefined;
  previousSha?: string | undefined;
  commitSha?: string | undefined;
  /** What the fetch found, before anything moved (#123). */
  check?: UpdateCheck | undefined;
  env?: Map<string, string> | undefined;
  /** Set when the remote has not moved, so the rest of the pipeline stands down. */
  unchanged?: boolean | undefined;
  /** Written by the preflight from the `proxy-container` check (#122). */
  proxyContainer?: string | undefined;
  /** Written by the preflight from the `proxy-ipv6` check (#122). */
  ipv6?: boolean | undefined;
}

/**
 * Certificates are renewed within this window, not on every deploy.
 *
 * Let's Encrypt issues for 90 days and recommends renewing at 60; a deploy
 * that lands inside the last 30 renews rather than leaving it to the cron,
 * because "the cron was never installed" is a failure this catches for free.
 */
const RENEW_WITHIN_DAYS = 30;

/**
 * Whether the certificate on disk expires within RENEW_WITHIN_DAYS. Exported
 * for its test. Unreadable is `false`: the publish step then leaves renewal
 * to the cron rather than guessing.
 */
export async function certificateDueForRenewal(
  target: ProxyTarget,
  run: typeof defaultRunCommand,
  now: Date = new Date(),
): Promise<boolean> {
  const expiry = await certificateExpiry(target, run, now);
  return expiry.daysLeft !== undefined && expiry.daysLeft <= RENEW_WITHIN_DAYS;
}

/**
 * Read from the state rather than derived from the deploy root (#119): the
 * proxy is a host-wide fixture whose location has nothing to do with where
 * this app happens to live. A state written before the field existed gets
 * the default the install would have used.
 */
function proxyRootFor(state: DeployState): string {
  return state.proxyRoot ?? DEFAULT_PROXY_ROOT;
}

async function compose(
  context: UpdateContext,
  extra: readonly string[],
  options?: { timeoutMs?: number },
): Promise<void> {
  const result = await context.runCommand(composeArgv(context.name, extra), {
    cwd: composeCwd(context.options.deployRoot),
    timeoutMs: options?.timeoutMs ?? 30 * 60_000,
    redact: context.journal.redact,
    ...(context.hooks?.onLog === undefined
      ? {}
      : { onLine: (line: string) => context.hooks?.onLog?.(line) }),
  });
  context.journal.command(result);
}

/** Every step after `fetch` stands down when the remote has not moved. */
function skipWhenUnchanged(context: UpdateContext): string | undefined {
  return context.unchanged === true ? 'already up to date' : undefined;
}

// ---------------------------------------------------------------------------
// What an update would bring  (issue #123)
// ---------------------------------------------------------------------------

/** The answer to "is there anything to update, and what?" */
export interface UpdateCheck {
  /** The deployed commit, from the state. */
  current: string;
  /** What the ref resolves to on the remote now. */
  latest: string;
  /** `git rev-list --count current..latest`. */
  commitsBehind: number;
  /** The newest 50 non-merge commits in that range, newest first. */
  commits: { sha: string; subject: string }[];
  /** ISO-8601 UTC. */
  checkedAt: string;
}

/** The `remote` deploy-info records for a check. */
export function remoteFromCheck(check: UpdateCheck): DeployRemote {
  return { sha: check.latest, commitsBehind: check.commitsBehind, checkedAt: check.checkedAt };
}

export interface UpdateCheckOptions {
  deployRoot: string;
  state: DeployState;
  runCommand: typeof defaultRunCommand;
  /** A ref other than the deployed one; `--ref`. */
  ref?: string | undefined;
  cwd?: string | undefined;
  hooks?: DeployHooks | undefined;
  /** The run journal's redactor. See `CheckoutOptions.redact` (issue #156). */
  redact?: Redactor | undefined;
  /** Bounds the fetch; `status` gives it ten seconds, a deploy does not. */
  fetchTimeoutMs?: number | undefined;
  /** Refuse to clone; `status` must not create a checkout to answer. */
  requireExisting?: boolean | undefined;
}

export interface UpdateCheckResult {
  target: RepoTarget;
  fetched: FetchResult;
  check: UpdateCheck;
}

/**
 * Fetches, resolves the ref, and compares it with what is deployed - without
 * moving the clone. Shared by the update pipeline's `fetch` step and by
 * `status`, so the two never disagree about how far behind a server is.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const target = await resolveRepoTarget({
    cwd: options.cwd ?? process.cwd(),
    runCommand: options.runCommand,
    state: options.state,
    ...(options.ref === undefined ? {} : { refFlag: options.ref }),
  });

  const fetched = await fetchRemote(target, {
    deployRoot: options.deployRoot,
    runCommand: options.runCommand,
    ...(options.redact === undefined ? {} : { redact: options.redact }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: options.fetchTimeoutMs }),
    ...(options.requireExisting === undefined ? {} : { requireExisting: options.requireExisting }),
  });

  const current = options.state.commitSha;
  const comparison = await compareRevisions(
    { cwd: fetched.path, runCommand: options.runCommand },
    current,
    fetched.resolved,
  );

  return {
    target,
    fetched,
    check: {
      current,
      latest: fetched.resolved,
      ...comparison,
      checkedAt: new Date().toISOString(),
    },
  };
}

/** Twelve characters, the same width `status` shows the revision at. */
function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * The human rendering of a check: a headline, then one line per commit.
 * Used by the pipeline (through the hooks, before `build`), by `update
 * --check`, and by the TUI's confirmation.
 */
export function renderUpdateCheck(check: UpdateCheck): string[] {
  if (check.commitsBehind === 0 && check.current === check.latest) {
    return [`already up to date at ${shortSha(check.current)}`];
  }
  const noun = check.commitsBehind === 1 ? 'commit' : 'commits';
  return [
    `current ${shortSha(check.current)} → latest ${shortSha(check.latest)}, ${check.commitsBehind} ${noun} behind`,
    ...check.commits.map((commit) => `${commit.sha}  ${commit.subject}`),
  ];
}

/**
 * Records the check in deploy-info (epic #118 decision 7: `remote` is
 * refreshed by `update --check` and `status`, never by the API). An existing
 * file is patched so nothing the last deploy wrote is rebuilt. A deployment
 * from before #120 has no file: `--check` writes its first one from the
 * unchanged state, while a real update leaves that to the deploy itself, so
 * a failed update still creates nothing the application could misread.
 */
async function recordUpdateCheck(context: UpdateContext, check: UpdateCheck): Promise<void> {
  const remote = remoteFromCheck(check);
  let path = updateDeployInfoRemote(context.options.deployRoot, remote);
  if (path === undefined && context.options.check === true) {
    path = writeDeployInfo(
      context.options.deployRoot,
      context.state,
      await collectServerFacts({ runCommand: context.runCommand, root: context.options.deployRoot }),
      { remote },
    );
  }
  if (path !== undefined) {
    context.journal.line(`Recorded remote ${shortSha(remote.sha)} (${remote.commitsBehind} behind) in ${path}`);
  }
}

export function buildUpdateSteps(): DeployStep<UpdateContext>[] {
  return [
    {
      id: 'preflight',
      title: 'Check the essentials',
      async run(context) {
        // A LIGHT preflight, not the full doctor. DNS and certificate checks
        // are install-time concerns; a site that is already serving does not
        // need them re-litigated on every update. That reasoning still holds,
        // which is why this stays a named set and does not become
        // `requiredChecks(ALL_CHECKS)`.
        //
        // THE DATABASE CHAIN IS A DIFFERENT CATEGORY, and belongs here (#179).
        // It is not an install-time concern being re-litigated - it is a
        // PRECONDITION OF A STEP THIS VERY PIPELINE RUNS three steps later.
        // `update` migrates: `migrate` stops the api container and runs
        // `prisma:migrate` against this database. A preflight that omits the
        // database is checking everything except the thing the pipeline is
        // about to change. `database-vector-extension` (#179) is the reason
        // this was noticed - an existing deployment is exactly the population
        // that RECEIVES the pgvector migration, so shipping that check to
        // install only would ship it to the one path that does not need it.
        //
        // It also fixes a bug that predates #179: until now an update against
        // an unreachable database, a rotated password or a dropped database
        // failed INSIDE `migrate` too, as a Prisma stack trace, with the api
        // container already stopped. All four are cheap - one TCP connect and
        // three single-statement psql calls - and they run against the same
        // database the migration is about to write to.
        //
        // All four, in dependency order: `runChecks` honours `requires` by
        // POSITION, so `database-vector-extension` without the three ahead of
        // it reports `skip` and checks nothing at all.
        const wanted = new Set([
          'docker-installed',
          'docker-daemon',
          'docker-compose-v2',
          // Update does not create it (install does); a missing network would
          // otherwise surface as `up -d` failing halfway through the pipeline.
          DEVNET_CHECK_ID,
          'git-installed',
          'disk-space',
          'database-reachable',
          'database-credentials',
          'database-exists',
          'database-vector-extension',
          // The publish step talks to the proxy container and decides on
          // IPv6 (#125); both answers come from these two checks, which
          // stand down (`skip`) for a deployment that is not published.
          'proxy-container',
          'proxy-ipv6',
        ]);

        // The deployment's own .env, read (never written - checks are read-only,
        // checks/types.ts rule 4) so the database checks above have something
        // to connect to. Absent or unreadable, they report `skip` rather than
        // inventing a failure, exactly as they do before a first install.
        const env = readEnvFile(context.options.deployRoot);

        // Held in a variable because the proxy checks WRITE to it.
        const checkContext: CheckContext = {
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          name: context.name,
          bindPort: context.state.bindPort,
          proxyRoot: proxyRootFor(context.state),
          ...(env === undefined ? {} : { env }),
          ...(context.options.proxyContainer ?? context.state.proxyContainer) === undefined
            ? {}
            : { proxyContainer: context.options.proxyContainer ?? context.state.proxyContainer },
          ...(context.options.skipProxy === true || context.state.domain === undefined
            ? { skipProxy: true }
            : {}),
        };
        const results = await runChecks(
          ALL_CHECKS.filter((check) => wanted.has(check.id)),
          checkContext,
        );

        for (const result of results) {
          context.journal.line(`${result.status} ${result.id}: ${result.detail}`);
        }

        context.proxyContainer = checkContext.proxyContainer;
        context.ipv6 = checkContext.ipv6;

        if (!checksPassed(results)) {
          throw new PreconditionError(
            results
              .filter((result) => result.status === 'fail')
              .map((result) => `${result.id}: ${result.detail}`)
              .join('\n'),
          );
        }
      },
    },
    {
      id: 'auth',
      title: 'Authenticate with GitHub',
      skip: (context) => {
        if (context.options.skipGithub === true) return 'skipped with --skip-github';
        if (githubSlug(context.state.repoUrl) === null) return 'not a GitHub remote';
        return undefined;
      },
      async run(context) {
        // Every update, not only the install: `gh auth setup-git` is
        // idempotent, and a server whose git config was reset heals here
        // rather than stalling on git's own prompt in the fetch (#123).
        const auth = await ensureGitHubAuth({
          runCommand: context.runCommand,
          repoUrl: context.state.repoUrl,
          cwd: context.options.deployRoot,
          // Rule 5 of executor.ts: wherever `hooks` are wired, the redactor
          // travels with them, or the terminal shows what the log masks.
          redact: context.journal.redact,
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
        });
        if (auth !== undefined) {
          context.journal.line(`git reaches ${auth.slug} through gh's credential helper`);
        }
      },
    },
    {
      id: 'fetch',
      title: 'Look for a new revision',
      async run(context) {
        // Fetch and compare BEFORE anything moves, so what an update is about
        // to apply is shown first - and, with --check, is all that happens.
        const { target, fetched, check } = await checkForUpdate({
          deployRoot: context.options.deployRoot,
          state: context.state,
          runCommand: context.runCommand,
          redact: context.journal.redact,
          ...(context.options.ref === undefined ? {} : { ref: context.options.ref }),
          ...(context.options.cwd === undefined ? {} : { cwd: context.options.cwd }),
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
        });
        context.target = target;
        context.check = check;

        const [headline, ...subjects] = renderUpdateCheck(check);
        context.journal.line(headline ?? '');
        context.hooks?.onProgress?.(headline ?? '');
        for (const line of subjects) {
          context.journal.line(`  ${line}`);
          context.hooks?.onLog?.(line);
        }

        await recordUpdateCheck(context, check);

        if (context.options.check === true) {
          // The clone stays where it was; runUpdate ends the pipeline here.
          return;
        }

        const checkout = await ensureCheckout(target, {
          deployRoot: context.options.deployRoot,
          runCommand: context.runCommand,
          redact: context.journal.redact,
          fetched,
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
          ...(context.options.force === undefined ? {} : { force: context.options.force }),
        });

        context.previousSha = checkout.previousSha;
        context.commitSha = checkout.sha;

        // The clone is in place, so the .env link into it can be. This is
        // also where a deployment installed before #120 - its .env a regular
        // file inside the clone - is moved to the app root, once.
        const link = ensureComposeEnvLink(context.options.deployRoot);
        if (link.migrated) {
          const message = `Moved .env from the clone to ${envFilePath(context.options.deployRoot)} and linked it back`;
          context.journal.line(message);
          context.hooks?.onProgress?.(message);
        }

        const moved = checkout.changed;
        const rebuildAnyway = context.options.force === true || context.options.noCache === true;

        if (!moved && !rebuildAnyway) {
          // Several minutes of build and a restart for a no-op is exactly the
          // friction that stops people updating often.
          context.unchanged = true;
          context.journal.line(`Already at ${checkout.sha}; nothing to do.`);
          return;
        }

        context.journal.line(
          `${checkout.previousSha ?? 'unknown'} -> ${checkout.sha} (${target.ref})`,
        );

        // Recorded BEFORE anything is mutated, so a failed update still leaves
        // behind what it was replacing. `lastDeployedAt` is NOT touched here:
        // nothing has been deployed yet, and a failed update stamping a
        // deploy time that never happened is the bug #120 fixed. The attempt
        // itself is what gets a timestamp.
        writeState({
          ...context.state,
          previousSha: checkout.previousSha,
          lastAttemptAt: new Date().toISOString(),
        } as DeployState);
      },
    },
    {
      id: 'environment-drift',
      title: 'Check for new environment variables',
      skip: skipWhenUnchanged,
      async run(context) {
        const templatePath = join(composeCwd(context.options.deployRoot), '.env.example');
        const onDisk = readEnvFile(context.options.deployRoot);

        if (!existsSync(templatePath) || onDisk === undefined) return;

        const specs = parseEnvExample(readFileSync(templatePath, 'utf8'));
        // DEPLOY_ROOT is the CLI's own carry-through key (#120), like
        // COMPOSE_PROJECT_NAME: a deployment installed before it existed gets
        // it on its first update, so the deploy-info mount resolves the same
        // way a fresh install's does.
        const current = new Map(onDisk);
        const pinned = current.get('DEPLOY_ROOT') !== context.options.deployRoot;
        current.set('DEPLOY_ROOT', context.options.deployRoot);

        const { missing, unknown } = diffEnv(specs, current);

        if (unknown.length > 0) {
          // Carried through, never dropped: it may be a fork's own variable.
          context.journal.line(`Keeping ${unknown.length} variable(s) not in the template`);
        }

        if (missing.length === 0) {
          if (pinned) {
            writeEnvFile(context.options.deployRoot, serializeEnvFile(current, specs));
            context.env = current;
          }
          return;
        }

        const needsAnswer = missing.filter((spec) => {
          const metadata = metadataFor(spec.key);
          return metadata.essential === true || metadata.secret === true;
        });

        context.journal.line(
          `This revision adds ${missing.length} variable(s); ${needsAnswer.length} need a value.`,
        );

        if (needsAnswer.length === 0) {
          // Everything new has a usable default; add them and say so.
          const merged = new Map(current);
          for (const spec of missing) {
            if (!spec.optional) merged.set(spec.key, spec.defaultValue);
          }
          writeEnvFile(context.options.deployRoot, serializeEnvFile(merged, specs));
          context.env = merged;
          return;
        }

        const domain = context.state.domain;
        if (domain === undefined) {
          throw new UsageError(
            'This revision needs new environment values, but no domain is recorded for this deployment. Re-run install, or set them by hand.',
          );
        }

        const { values } = await runEnvWizard({
          specs,
          domain,
          existing:
            context.options.answers === undefined
              ? current
              : new Map([...current, ...context.options.answers]),
          ...(context.options.nonInteractive === undefined
            ? {}
            : { nonInteractive: context.options.nonInteractive }),
          ...(context.options.promptContext === undefined
            ? {}
            : { ctx: context.options.promptContext }),
        });

        writeEnvFile(context.options.deployRoot, serializeEnvFile(values, specs));
        context.env = values;
      },
    },
    {
      id: 'build',
      title: 'Build images',
      skip: skipWhenUnchanged,
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
      skip: skipWhenUnchanged,
      async run(context) {
        // The api container is stopped first so two instances cannot race the
        // same migration, and brought back if the migration fails - leaving a
        // working deployment down because a migration failed would turn a
        // failed update into an outage.
        await compose(context, ['stop', 'api'], { timeoutMs: 5 * 60_000 });

        try {
          await compose(
            context,
            ['run', '--rm', '--no-deps', 'api', 'npm', 'run', 'prisma:migrate'],
            { timeoutMs: 10 * 60_000 },
          );
        } catch (error) {
          await compose(context, ['start', 'api'], { timeoutMs: 5 * 60_000 }).catch(
            () => undefined,
          );
          throw error;
        }
      },
    },
    {
      id: 'seed',
      title: 'Refresh roles and permissions',
      skip: (context) =>
        skipWhenUnchanged(context) ??
        (context.options.skipSeed === true ? 'skipped with --skip-seed' : undefined),
      async run(context) {
        // Idempotent, and the only way new permissions reach an existing
        // deployment. See the header.
        await compose(
          context,
          ['run', '--rm', '--no-deps', 'api', 'npm', 'run', 'prisma:seed'],
          { timeoutMs: 10 * 60_000 },
        );
      },
    },
    {
      id: 'restart',
      title: 'Restart the stack',
      skip: skipWhenUnchanged,
      async run(context) {
        await compose(context, ['up', '-d']);
        // nginx caches the api container's address, and a rebuilt container
        // gets a new one, so a stale resolution outlives the update.
        await compose(context, ['restart', 'nginx'], { timeoutMs: 5 * 60_000 });
      },
    },
    {
      id: 'health',
      title: 'Wait for the API',
      skip: skipWhenUnchanged,
      async run(context) {
        const probe = await waitForHealthy({
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          name: context.name,
          bindPort: context.state.bindPort,
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
      title: 'Refresh the vhost and certificate',
      skip: (context) => {
        if (context.unchanged === true) return 'already up to date';
        if (context.options.skipProxy === true) return 'skipped with --skip-proxy';
        if (context.state.domain === undefined) return 'this deployment is not published';
        return undefined;
      },
      async run(context) {
        const target: ProxyTarget = {
          domain: context.state.domain as string,
          bindPort: context.state.bindPort,
          proxyRoot: proxyRootFor(context.state),
        };

        // The flag, else the state written by install, else what the
        // preflight found, else the conventional name (#122, #125).
        const proxyContainer =
          context.options.proxyContainer ??
          context.state.proxyContainer ??
          context.proxyContainer ??
          DEFAULT_PROXY_CONTAINER;
        context.proxyContainer = proxyContainer;
        const ipv6 = context.options.ipv6 ?? context.ipv6;

        const status = certificateStatus(target);
        if (!status.exists) {
          const email = context.env?.get('INITIAL_ADMIN_EMAIL') ?? '';
          if (email !== '') {
            await issueCertificate(target, {
              runCommand: context.runCommand,
              proxyContainer,
              email,
              redact: context.journal.redact,
              ...(context.options.fetch === undefined ? {} : { fetch: context.options.fetch }),
              ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
            });
          }
        } else if (await certificateDueForRenewal(target, context.runCommand)) {
          // Within the window: renew now rather than trust that a cron exists.
          // Reloads the proxy only if certbot actually renewed something.
          context.journal.line(`Certificate for ${target.domain} expires within ${RENEW_WITHIN_DAYS} days; renewing`);
          await renewCertificates({
            proxyRoot: target.proxyRoot,
            proxyContainer,
            runCommand: context.runCommand,
            certName: target.domain,
            redact: context.journal.redact,
            ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
          });
        }

        // Rewritten and re-validated so a change to the template reaches an
        // existing deployment; identical content is a no-op with no reload.
        // maxBodyBytes travels too, or every update would silently reset the
        // upload limit to the default and reload for nothing.
        await installVhost(target, {
          runCommand: context.runCommand,
          proxyContainer,
          ...(ipv6 === undefined ? {} : { ipv6 }),
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
          ...(context.env?.get('MAX_FILE_SIZE') === undefined
            ? {}
            : { maxBodyBytes: Number(context.env.get('MAX_FILE_SIZE')) }),
        });
      },
    },
    {
      id: 'verify',
      title: 'Verify the deployment',
      skip: skipWhenUnchanged,
      async run(context) {
        const report = await collectHealth({
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          name: context.name,
          bindPort: context.state.bindPort,
          ...(context.state.domain === undefined || context.options.skipProxy === true
            ? {}
            : { domain: context.state.domain }),
        });

        if (!isHealthy(report)) {
          throw new Error(
            `The stack restarted but is not healthy. Run \`${CLI_NAME} deploy status\` for the detail.`,
          );
        }
      },
    },
  ];
}

export interface UpdateResult {
  changed: boolean;
  previousSha?: string | undefined;
  commitSha: string;
  journalPath: string;
  durationMs: number;
  /** What the fetch found; the whole answer under `--check`. */
  check?: UpdateCheck | undefined;
  /**
   * Present when this run ADOPTED the deployment - rebuilt a missing state
   * file from the disk (#285).
   *
   * On a terminal the operator has already seen this through the hooks,
   * before the pipeline ran, so it survives a run that then fails. It is
   * carried here as well because `--json` wires no hooks at all, and a
   * machine caller must be able to tell an adoption from an ordinary update.
   */
  adopted?: AdoptionNotice | undefined;
}

/**
 * Under `--check` the pipeline is the steps up to and including `fetch`,
 * literally - not the full list with the rest skipped - so the hooks count
 * `[3/3]` rather than announcing seven steps that were never going to run.
 */
function stepsFor(options: UpdateOptions): DeployStep<UpdateContext>[] {
  const steps = buildUpdateSteps();
  if (options.check !== true) return steps;
  const fetch = steps.findIndex((step) => step.id === 'fetch');
  return steps.slice(0, fetch + 1);
}

export async function runUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const runCommand = options.runCommand ?? defaultRunCommand;

  // The precondition install does not have, and the reason this is its own
  // command: nothing to update is a different situation from nothing
  // installed. Since #285 it is asked of the DEPLOYMENT rather than of the
  // CLI's notes about it - `adoptDeployment` rebuilds the record when the
  // deployment is demonstrably there, and raises the same `NotInstalledError`
  // with the same message when it is not.
  const recorded = readState(options.deployRoot);
  const adoption: Adoption | undefined =
    recorded === undefined
      ? await adoptDeployment({
          deployRoot: options.deployRoot,
          runCommand,
          ...(options.ref === undefined ? {} : { ref: options.ref }),
          ...(options.proxyContainer === undefined
            ? {}
            : { proxyContainer: options.proxyContainer }),
        })
      : undefined;
  const state = recorded ?? (adoption as Adoption).state;

  // BEFORE the pipeline, and that ordering is the whole point (#159).
  //
  // `update` used to pre-create nothing: the first thing to touch deploy-info
  // was `refreshDeployInfo` at the very END of a successful run, long after
  // `restart` had run the `compose up` that makes the Docker daemon create the
  // missing bind source as root:root. A deployment first installed by a CLI
  // from before #155 already has that root-owned directory, so a non-root
  // update spent a full build, migrate, restart and health check only to die
  // on `EACCES … deploy-info/info.json.<pid>.tmp` with every step green.
  //
  // Creating it here fixes both halves: the directory exists before any
  // compose command, so Docker never gets to invent it, and a directory this
  // CLI cannot make right is refused NOW with the `chown` to paste - not after
  // the deployment has already been applied. `--check` reaches
  // `recordUpdateCheck` before any compose command and so was already safe by
  // accident; it is safe on purpose from here.
  ensureDeployInfoDir(options.deployRoot);

  const startedAt = Date.now();

  // Read through `readEnvFile` rather than a fixed path: a deployment from
  // before #120 still has its .env inside the clone until `fetch` moves it.
  const env = readEnvFile(options.deployRoot);
  const journal = openJournal({
    deployRoot: options.deployRoot,
    command: 'update',
    secrets: secretsFrom(env ?? new Map()),
  });

  const context: UpdateContext = {
    options,
    runCommand,
    journal,
    hooks: options.hooks,
    completed: new Set<string>(),
    state,
    name: projectNameFor(state, options.deployRoot),
    ...(env === undefined ? {} : { env }),
  };

  if (adoption !== undefined) {
    // WRITTEN NOW, BEFORE THE PIPELINE. The bookkeeping is recovered whatever
    // this run then does: a preflight failure, a `--check`, or an "already up
    // to date" must not each need the adoption performed again. It is written
    // after the journal is open so the write itself is journaled, the same
    // ordering #267's failure-path state write follows.
    writeState(adoption.state);
    // ANNOUNCED HERE TOO, NOT IN THE EPILOGUE, so an operator whose run then
    // fails at `preflight` still learns that their state file was rebuilt.
    // NOT under `Action required:` (#264/#265), which is for something the
    // operator must go and do: this is a notice about something already done,
    // and putting it there would teach people to skim that heading.
    const [headline, ...detail] = renderAdoption(adoption.notice);
    journal.line(headline ?? '');
    options.hooks?.onProgress?.(headline ?? '');
    for (const line of detail) {
      journal.line(line);
      options.hooks?.onLog?.(line.trim());
    }
  }
  const adopted = adoption?.notice;

  const result = await runPipeline(stepsFor(options), context);

  if (result.failed !== undefined) {
    // ==========================================================================
    // `deploy-info` IS REFRESHED ONCE `health` HAS PASSED, ON THIS PATH TOO.
    // ==========================================================================
    // (issue #283, the update half of the rule install.ts states in full)
    //
    // An update that fails after `health` has ALREADY deployed the new
    // revision: `restart` brought the stack up on it and the API answered on
    // it. Leaving the last successful deploy's document in place would then
    // name the OLD commit as what is running, and a deployment that never had
    // one - a pre-#120 install, or the run that first created this root -
    // would keep reporting nothing at all.
    //
    // NOTHING HERE STAMPS A DEPLOY TIME THAT DID NOT HAPPEN. The state is not
    // written (this command writes it at `fetch` and on success, and #120's
    // rule that `lastDeployedAt` belongs only to a run that finished is
    // untouched), and the record below is derived from an in-memory state
    // whose `lastDeployedAt` is carried forward from the previous success -
    // so `updatedAt` still means "when the last deploy succeeded" while
    // `app.commitSha` says which revision is actually serving, and `run` says
    // the run that put it there did not finish.
    if (result.completed.includes('health')) {
      // ONE INSTANT for both fields, the same rule `runInstall`'s epilogue
      // follows: two `new Date()` calls can land a millisecond apart and the
      // record would carry two answers to one question.
      const attemptedAt = new Date().toISOString();
      try {
        await refreshDeployInfo(
          context,
          {
            ...state,
            ref: context.target?.ref ?? state.ref,
            commitSha: context.commitSha ?? state.commitSha,
            ...(context.previousSha === undefined ? {} : { previousSha: context.previousSha }),
            ...((context.proxyContainer ?? state.proxyContainer) === undefined
              ? {}
              : { proxyContainer: context.proxyContainer ?? state.proxyContainer }),
            envPath: envFilePath(options.deployRoot),
            lastAttemptAt: attemptedAt,
            lastCommand: 'update',
            appctlVersion: CLI_VERSION,
          } as DeployState,
          { completed: false, failedStep: result.failed.id, attemptedAt },
        );
      } catch (error) {
        // Never in place of the operator's actual problem, which is the
        // pipeline's own error three lines below.
        journal.line(
          `Could not refresh deploy-info: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    journal.finish('failure', `${result.failed.id}: ${result.failed.detail ?? ''}`);
    const previous = context.previousSha ?? state.commitSha;

    // A precondition (a logged-out gh) keeps its exit code 6.
    throw pipelineFailure(
      result,
      `${result.failed.title} failed: ${result.failed.detail ?? 'unknown error'}\n` +
        `The full log is at ${journal.path}\n` +
        // An honest manual recovery path. A partially-applied migration cannot
        // be undone by checking out the old code, so this does not pretend to.
        `To go back to the previous revision: ${CLI_NAME} deploy update --ref ${previous} --force`,
    );
  }

  if (options.check === true) {
    // Nothing was checked out or deployed, so the state is not written and
    // `previousSha` is not touched: the file's mtime is the proof.
    journal.finish('success', 'check only');
    return {
      changed: false,
      commitSha: state.commitSha,
      journalPath: journal.path,
      durationMs: Date.now() - startedAt,
      ...(context.check === undefined ? {} : { check: context.check }),
      ...(adopted === undefined ? {} : { adopted }),
    };
  }

  if (context.unchanged === true) {
    // Nothing was deployed, so the state stands - but deploy-info is still
    // refreshed from it: the host facts may have moved (a kernel upgrade), and
    // a deployment from before #120 gets its first info.json here rather than
    // only once the remote moves.
    //
    // TWO THINGS COME FROM THE CLONE AND THE EXISTING RECORD, NOT THE STATE
    // (#283). A run that failed AFTER `health` left the new revision checked
    // out and serving while the state still names the old one - `update`
    // records a commit only on success - so this run's "already up to date"
    // would otherwise rewrite the document backwards, from the revision that
    // is actually running to the one that is not, and mark it complete. It
    // deployed nothing, so it has nothing to say about how any run ended:
    // the previous document's `run` is carried through unchanged rather than
    // replaced with a completion this run did not observe.
    await refreshDeployInfo(
      context,
      { ...state, commitSha: context.commitSha ?? state.commitSha } as DeployState,
      existingDeployRun(context),
    );
    journal.finish('success', 'already up to date');
    return {
      changed: false,
      commitSha: context.commitSha ?? state.commitSha,
      journalPath: journal.path,
      durationMs: Date.now() - startedAt,
      ...(context.check === undefined ? {} : { check: context.check }),
      ...(adopted === undefined ? {} : { adopted }),
    };
  }

  // Stamped ONLY here, once every step has run: this is the moment something
  // was actually deployed. `installedAt` rides through untouched.
  const now = new Date().toISOString();
  const deployed = {
    ...state,
    ref: context.target?.ref ?? state.ref,
    commitSha: context.commitSha ?? state.commitSha,
    previousSha: context.previousSha,
    ...((context.proxyContainer ?? state.proxyContainer) === undefined
      ? {}
      : { proxyContainer: context.proxyContainer ?? state.proxyContainer }),
    envPath: envFilePath(options.deployRoot),
    lastDeployedAt: now,
    lastAttemptAt: now,
    lastCommand: 'update',
    appctlVersion: CLI_VERSION,
  } as DeployState;
  writeState(deployed);
  await refreshDeployInfo(context, deployed);

  journal.finish('success');

  return {
    changed: true,
    ...(context.previousSha === undefined ? {} : { previousSha: context.previousSha }),
    commitSha: context.commitSha ?? state.commitSha,
    journalPath: journal.path,
    durationMs: Date.now() - startedAt,
    ...(context.check === undefined ? {} : { check: context.check }),
    ...(adopted === undefined ? {} : { adopted }),
  };
}

/**
 * Writes deploy-info from the state, after `writeState` - never before.
 *
 * `remote` is what this very run found: the deployed commit now IS the
 * latest the fetch resolved, so it is recorded as zero behind rather than
 * dropped to null - an About page that said "never checked" right after an
 * update would be wrong about the one moment it is certainly current.
 */
async function refreshDeployInfo(
  context: UpdateContext,
  state: DeployState,
  run?: DeployRun,
): Promise<void> {
  const remote: DeployRemote | null =
    context.check === undefined
      ? null
      : { sha: state.commitSha, commitsBehind: 0, checkedAt: context.check.checkedAt };
  const path = writeDeployInfo(
    context.options.deployRoot,
    state,
    await collectServerFacts({ runCommand: context.runCommand, root: context.options.deployRoot }),
    { remote, ...(run === undefined ? {} : { run }) },
  );
  context.journal.line(
    run === undefined || run.completed
      ? `Wrote ${path}`
      : `Wrote ${path}; the record is marked incomplete at ${run.failedStep}.`,
  );
}

/**
 * The `run` block already on disk, for a refresh that deployed nothing (#283).
 *
 * Undefined when there is no document or it cannot be read - `writeDeployInfo`
 * then defaults to a completed run, which is what a deployment with no record
 * at all has always been assumed to be. Never allowed to throw: refusing to
 * refresh host facts because an unrelated field is unreadable would make a
 * corrupt document permanent.
 */
function existingDeployRun(context: UpdateContext): DeployRun | undefined {
  try {
    return readDeployInfo(context.options.deployRoot)?.run;
  } catch {
    return undefined;
  }
}

export { RENEW_WITHIN_DAYS };
