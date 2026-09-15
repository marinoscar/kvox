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
import { writeDeployInfo } from './deploy-info.js';
import { ensureComposeEnvLink, envFilePath, readEnvFile, writeEnvFile } from './env-file.js';
import { diffEnv, parseEnvExample, serializeEnvFile } from './env-spec.js';
import { metadataFor } from './env-metadata.js';
import { runEnvWizard } from './env-wizard.js';
import { runCommand as defaultRunCommand } from './executor.js';
import { collectHealth, isHealthy, waitForHealthy } from './health.js';
import type { DeployHooks } from './hooks.js';
import { openJournal, type Journal } from './journal.js';
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
import { ensureCheckout, resolveRepoTarget, type RepoTarget } from './repo.js';
import { collectServerFacts } from './server-facts.js';
import { requireState, writeState, type DeployState } from './state.js';
import { runPipeline, type DeployStep, type StepContext } from './steps/pipeline.js';
import { composeArgv, composeCwd, secretsFrom } from './install.js';
import type { PromptContext } from '../prompt.js';

// =============================================================================
// `kvox deploy update`  (issue #182, epic #168)
// =============================================================================
//
// Installing is the rare operation; updating is the one performed weekly, often
// while something is already broken. It needs different behaviour from install,
// not a flag on it - the PRECONDITIONS ARE OPPOSITE. Install refuses when state
// exists; update refuses when it does not. One command with two contradictory
// guards is harder to reason about than two commands.
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
// =============================================================================

export interface UpdateOptions {
  deployRoot: string;
  ref?: string | undefined;
  force?: boolean | undefined;
  noCache?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  skipSeed?: boolean | undefined;
  skipProxy?: boolean | undefined;
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

export function buildUpdateSteps(): DeployStep<UpdateContext>[] {
  return [
    {
      id: 'preflight',
      title: 'Check the essentials',
      async run(context) {
        // A LIGHT preflight, not the full doctor. DNS and certificate checks
        // are install-time concerns; a site that is already serving does not
        // need them re-litigated on every update.
        const wanted = new Set([
          'docker-installed',
          'docker-daemon',
          'docker-compose-v2',
          // Update does not create it (install does); a missing network would
          // otherwise surface as `up -d` failing halfway through the pipeline.
          DEVNET_CHECK_ID,
          'git-installed',
          'disk-space',
          // The publish step talks to the proxy container and decides on
          // IPv6 (#125); both answers come from these two checks, which
          // stand down (`skip`) for a deployment that is not published.
          'proxy-container',
          'proxy-ipv6',
        ]);

        // Held in a variable because the proxy checks WRITE to it.
        const checkContext: CheckContext = {
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          name: context.name,
          bindPort: context.state.bindPort,
          proxyRoot: proxyRootFor(context.state),
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
      id: 'fetch',
      title: 'Look for a new revision',
      async run(context) {
        const target = await resolveRepoTarget({
          cwd: context.options.cwd ?? process.cwd(),
          runCommand: context.runCommand,
          state: context.state,
          ...(context.options.ref === undefined ? {} : { refFlag: context.options.ref }),
        });

        const checkout = await ensureCheckout(target, {
          deployRoot: context.options.deployRoot,
          runCommand: context.runCommand,
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
          ...(context.options.force === undefined ? {} : { force: context.options.force }),
        });

        context.target = target;
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
}

export async function runUpdate(options: UpdateOptions): Promise<UpdateResult> {
  // The precondition install does not have, and the reason this is its own
  // command: nothing to update is a different situation from nothing installed.
  const state = requireState(options.deployRoot);
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
    runCommand: options.runCommand ?? defaultRunCommand,
    journal,
    hooks: options.hooks,
    completed: new Set<string>(),
    state,
    name: projectNameFor(state, options.deployRoot),
    ...(env === undefined ? {} : { env }),
  };

  const result = await runPipeline(buildUpdateSteps(), context);

  if (result.failed !== undefined) {
    journal.finish('failure', `${result.failed.id}: ${result.failed.detail ?? ''}`);
    const previous = context.previousSha ?? state.commitSha;

    throw new Error(
      `${result.failed.title} failed: ${result.failed.detail ?? 'unknown error'}\n` +
        `The full log is at ${journal.path}\n` +
        // An honest manual recovery path. A partially-applied migration cannot
        // be undone by checking out the old code, so this does not pretend to.
        `To go back to the previous revision: ${CLI_NAME} deploy update --ref ${previous} --force`,
    );
  }

  if (context.unchanged === true) {
    // Nothing was deployed, so the state stands - but deploy-info is still
    // refreshed from it: the host facts may have moved (a kernel upgrade), and
    // a deployment from before #120 gets its first info.json here rather than
    // only once the remote moves.
    await refreshDeployInfo(context, state);
    journal.finish('success', 'already up to date');
    return {
      changed: false,
      commitSha: context.commitSha ?? state.commitSha,
      journalPath: journal.path,
      durationMs: Date.now() - startedAt,
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
  };
}

/** Writes deploy-info from the state, after `writeState` - never before. */
async function refreshDeployInfo(context: UpdateContext, state: DeployState): Promise<void> {
  const path = writeDeployInfo(
    context.options.deployRoot,
    state,
    await collectServerFacts({ runCommand: context.runCommand, root: context.options.deployRoot }),
  );
  context.journal.line(`Wrote ${path}`);
}

export { RENEW_WITHIN_DAYS };
