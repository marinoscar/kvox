import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { UsageError } from '../errors.js';
import { canPrompt, prompt, type PromptContext } from '../prompt.js';
import { DEFAULT_PROXY_CONTAINER } from './checks/index.js';
import { ENV_FILENAME } from './env-file.js';
import { runCommand as defaultRunCommand } from './executor.js';
import type { DeployHooks } from './hooks.js';
import { composeArgv, composeCwd } from './install.js';
import { nullJournal, openJournal, type Journal } from './journal.js';
import {
  DEFAULT_APPS_ROOT,
  DEFAULT_PROXY_ROOT,
  listInstalledApps,
  locateInstalledApp,
  type ResolvedLayout,
} from './layout.js';
import {
  certbotArgv,
  listRenewalCrons,
  renewalCronPath,
  removeVhost,
  vhostPath,
  type ProxyTarget,
} from './proxy.js';
import { readEnvBytes, backupEnvFile, removeDeployRoot, removePath, type EnvBackup } from './teardown.js';
import { readState, type DeployState } from './state.js';
import { pipelineFailure, runPipeline, type DeployStep, type StepContext } from './steps/pipeline.js';

// =============================================================================
// `kvox deploy uninstall`  (issue #261, epic #168)
// =============================================================================
//
// The command that was missing. `install` creates a deployment, `update`
// advances one, and until this file nothing removed one - so "I'll start over"
// meant `docker compose down` plus `rm -rf repo`, which leaves behind the
// `.env`, the state file, `deploy-info/`, the journal, the compose project's
// named volumes, the vhost in the shared proxy and the renewal cron. #259 is
// what that costs: a corrupt `.env` outside `repo/` survived three consecutive
// installs and produced a failure whose symptom pointed nowhere near its cause.
//
// WHAT IT REFUSES TO REMOVE IS AS MUCH OF THE DESIGN AS WHAT IT REMOVES. Four
// deliberate refusals, each recorded at its own step below and in
// docs/specs/vps-deploy.md §21:
//
//   1. THE EXTERNAL DATABASE. Decision 4 of §1 is that deploy VALIDATES the
//      database and never manages it - the one narrow exception being #238's
//      explicit `CREATE DATABASE`, which §20 bounds precisely and which has no
//      symmetric drop ("an empty database created in error is recoverable by
//      deleting it by hand; the inverse is not"). It holds the operator's data
//      and usually lives on another host. The `dropdb` command is PRINTED.
//   2. THE `devnet` NETWORK, shared with every other app on the server.
//   3. THE SHARED PROXY CONTAINER, likewise. Its vhost for THIS app is
//      removed, and the proxy is reloaded, never restarted.
//   4. TLS CERTIFICATES, by default. Let's Encrypt's duplicate-certificate
//      limit is 5 per week per identical hostname set; an operator iterating
//      on a broken install who destroys and re-requests each time locks
//      themselves out of their own domain for a week - and re-issuing a
//      certificate is exactly what a reinstall does. `--certs` opts in.
//
// TWO SAFETY RULES, BOTH NON-NEGOTIABLE:
//
//   - A TYPED CONFIRMATION OF THE APP NAME, not y/N, matching the convention
//     the API already holds for destructive actions (`confirmation:
//     "RESTORE"`, `"ROLLBACK"`, `"REMOVE"`, the Danger Zone's uppercased
//     scope). Under `--non-interactive` it must be supplied as `--confirm
//     <name>`: a destructive default reachable by omission is not a default,
//     it is a trap. THE TUI HAS NO TYPED-CONFIRMATION COMPONENT TODAY -
//     `tui/components/confirm-dialog.tsx` is a two-item select - so this
//     command is deliberately not on the `deploy` TUI menu; adding it there
//     means adding that component first, and a y/N dialog standing in for a
//     typed confirmation would quietly weaken the guarantee.
//
//   - `--dry-run` WRITES NOTHING AND CHANGES NO DOCKER STATE. Not "mostly
//     nothing": the journal itself is replaced with `nullJournal()`, because
//     `openJournal` creates `<deployRoot>/logs/` and two files in it before
//     the first line.
//
// AND IT IS RESILIENT TO A DEPLOYMENT SOMEBODY ALREADY TOOK APART. Every step
// treats "already gone" as an ordinary outcome and says so, because the
// operator reaching for this command has, more often than not, already tried
// to do it by hand.
// =============================================================================

export interface UninstallOptions {
  appsRoot?: string | undefined;
  name?: string | undefined;
  deployRoot?: string | undefined;
  /** The app name, typed by the operator. `--confirm <name>`. */
  confirmation?: string | undefined;
  /** List everything; touch nothing. */
  dryRun?: boolean | undefined;
  /** Also delete this app's TLS certificate. Off by default; see rule 4. */
  certs?: boolean | undefined;
  /** Leave `<deployRoot>/.env` in place. The backup is still taken. */
  keepEnv?: boolean | undefined;
  /** Never prompt; `--confirm <name>` is then the only authorisation there is. */
  nonInteractive?: boolean | undefined;
  /** Do not touch the shared proxy at all (no vhost removal, no reload). */
  skipProxy?: boolean | undefined;
  proxyRoot?: string | undefined;
  proxyContainer?: string | undefined;
  /** Where the renewal cron lives; default /etc/cron.d, tests point it away. */
  cronDir?: string | undefined;
  runCommand?: typeof defaultRunCommand | undefined;
  hooks?: DeployHooks | undefined;
  promptContext?: PromptContext | undefined;
  now?: (() => Date) | undefined;
}

export type ResolvedUninstallOptions = UninstallOptions & ResolvedLayout;

/** One thing removed, or that would be. `kind` is what an operator reads first. */
export interface RemovedItem {
  kind: 'compose-project' | 'path' | 'certificate' | 'vhost' | 'cron';
  target: string;
  /** False when it was already gone. Reported, never an error. */
  existed: boolean;
}

/** One thing deliberately left alone, and why. */
export interface KeptItem {
  target: string;
  reason: string;
}

export interface UninstallResult {
  name: string;
  deployRoot: string;
  dryRun: boolean;
  removed: RemovedItem[];
  kept: KeptItem[];
  /** Where the `.env` was copied to. Absent when there was none. */
  envBackupPath?: string | undefined;
  /** The journal, when one was opened (never under `--dry-run`). */
  journalPath?: string | undefined;
  /**
   * The command that would drop this deployment's database, for the operator
   * to run themselves. NEVER RUN HERE - see refusal 1.
   */
  databaseCommand?: string | undefined;
  /** Anything that could not be done and is now the operator's to finish. */
  warnings: string[];
}

interface UninstallContext extends StepContext {
  options: ResolvedUninstallOptions;
  runCommand: typeof defaultRunCommand;
  journal: Journal;
  state: DeployState | undefined;
  removed: RemovedItem[];
  kept: KeptItem[];
  warnings: string[];
  backup?: EnvBackup | undefined;
  databaseCommand?: string | undefined;
}

function record(context: UninstallContext, item: RemovedItem): void {
  context.removed.push(item);
  const verb = context.options.dryRun === true ? 'would remove' : item.existed ? 'removed' : 'already gone:';
  context.journal.line(`${verb} ${item.target}`);
  context.hooks?.onProgress?.(`${verb} ${item.target}`);
}

/**
 * The `dropdb` an operator would run, built from the deployment's own `.env`.
 *
 * READ BEFORE ANYTHING IS DELETED, which is why it happens in the very first
 * step: after the deploy root is gone there is nothing left that knows which
 * database this deployment used, and "you'll have to look up your own database
 * name" is the least helpful possible parting message.
 *
 * No password anywhere in it. `dropdb` prompts, or reads ~/.pgpass, and a
 * connection string on a command line is a credential in the shell history of
 * whoever pastes it.
 */
export function dropDatabaseCommand(env: ReadonlyMap<string, string>): string | undefined {
  const database = env.get('POSTGRES_DB');
  if (database === undefined || database === '') return undefined;

  const argv = ['dropdb'];
  const host = env.get('POSTGRES_HOST');
  const port = env.get('POSTGRES_PORT');
  const user = env.get('POSTGRES_USER');
  if (host !== undefined && host !== '') argv.push('-h', host);
  if (port !== undefined && port !== '') argv.push('-p', port);
  if (user !== undefined && user !== '') argv.push('-U', user);
  argv.push(database);
  return argv.join(' ');
}

/** Parses the `.env` far enough to name the database. Never throws. */
function readEnvQuietly(deployRoot: string): Map<string, string> {
  try {
    const found = readEnvBytes(deployRoot);
    if (found === undefined) return new Map();
    return parseEnv(found.contents);
  } catch {
    return new Map();
  }
}

/**
 * A deliberately minimal `.env` read.
 *
 * `parseEnvFile` is the real parser and is used everywhere else. It is not
 * used here because this call happens on a deployment being deleted, whose
 * `.env` may be the very file that could not be parsed (#259) - and the three
 * values wanted are needed only to print a command the operator runs by hand.
 * A refusal to uninstall because the file it was about to delete would not
 * parse is the worst available outcome.
 */
function parseEnv(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of contents.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === undefined) continue;
    const value = (match[2] ?? '').trim();
    const unquoted = /^(['"])(.*)\1$/.exec(value);
    values.set(match[1], unquoted?.[2] ?? value);
  }
  return values;
}

/**
 * The warning when this app held the LAST certificate renewal entry (#261).
 *
 * Written to be read by somebody who did not know the entries were shared -
 * which is everybody, because the sharing lives in a comment in `proxy.ts`.
 * Three things it must say, in this order: that automatic renewal has stopped,
 * that this is NOT limited to the app just removed, and the exact command that
 * puts it back.
 *
 * The command names a REAL surviving deployment where one exists
 * (`listInstalledApps` minus this one), because a command that can be pasted
 * beats one the operator has to fill in while working out what the blank
 * means. When this was the only app on the box there is nothing to point at
 * and the message says so instead of printing a placeholder that cannot work.
 */
function lastRenewalCronWarning(context: UninstallContext): string {
  const { appsRoot, name, cronDir } = context.options;

  // Still readable at this point: the `deploy-root` step runs after this one.
  // Filtered by BOTH name and path so `--root` pointing at a folder whose
  // state records a different name cannot suggest the app being removed.
  const survivor = listInstalledApps(appsRoot).find(
    (app) => app.name !== name && app.deployRoot !== context.options.deployRoot,
  );

  const reinstate =
    survivor === undefined
      ? [
          `There is no other deployment under ${appsRoot} to reinstate it from.`,
          `The next \`${CLI_NAME} deploy install\` writes an entry only when it ISSUES`,
          'a certificate - which a reinstall onto an existing one does not do - so',
          'pass --install-cron explicitly if you want the schedule back.',
        ]
      : [
          'Reinstate it against a deployment that is staying:',
          `  ${CLI_NAME} deploy certs renew --install-cron --apps-root ${appsRoot} --name ${survivor.name}`,
        ];

  // HARD-WRAPPED, not left to the terminal. The renderer indents this by four
  // and an operator's eye skips a wall of reflowed text - which is the exact
  // outcome this warning exists to avoid.
  return [
    'WARNING: automatic certificate renewal has STOPPED for this whole server.',
    '',
    renewalCronPath(name, cronDir),
    'was the last renewal entry on this box, and every such entry runs',
    '`certs renew --all` - so ONE entry renews EVERY certificate behind the',
    "shared proxy, not only this app's. Removing the last one therefore affects",
    'every other app on this server, and it surfaces in 60-90 days as expired',
    'certificates with nothing pointing back at this uninstall.',
    '',
    'It was removed rather than left behind because it named the deploy root',
    'this run deletes, so it would have failed on every run from now on.',
    '',
    ...reinstate,
  ].join('\n');
}

/** The proxy target this app publishes under, when it publishes at all. */
function proxyTargetFor(context: UninstallContext): ProxyTarget | undefined {
  const domain = context.state?.domain;
  if (domain === undefined || domain === '') return undefined;
  return {
    domain,
    bindPort: context.state?.bindPort ?? 0,
    proxyRoot:
      context.options.proxyRoot ?? context.state?.proxyRoot ?? DEFAULT_PROXY_ROOT,
  };
}

export function buildUninstallSteps(): DeployStep<UninstallContext>[] {
  return [
    {
      id: 'inspect',
      title: 'Read what is here',
      async run(context) {
        const env = readEnvQuietly(context.options.deployRoot);
        context.databaseCommand = dropDatabaseCommand(env);

        const domain = context.state?.domain;
        context.journal.line(
          `App ${context.options.name} at ${context.options.deployRoot}` +
            (domain === undefined ? '' : `, published at ${domain}`),
        );

        // Refusals 1-3, recorded here rather than left implicit, so the report
        // says what was NOT touched as clearly as what was.
        context.kept.push({
          target: env.get('POSTGRES_DB') ?? 'the external database',
          reason:
            context.databaseCommand === undefined
              ? 'this deployment never manages the database; drop it yourself if you want it gone'
              : `never removed by ${CLI_NAME}; drop it yourself with: ${context.databaseCommand}`,
        });
        context.kept.push({
          target: 'devnet (docker network)',
          reason: 'shared with every other app on this server',
        });
        context.kept.push({
          target:
            context.options.proxyContainer ??
            context.state?.proxyContainer ??
            DEFAULT_PROXY_CONTAINER,
          reason: 'the shared reverse proxy serves every app on this server',
        });
      },
    },
    {
      id: 'backup-env',
      title: 'Back up the environment file',
      async run(context) {
        // BEFORE the deploy root goes. The backup lands in the apps root, a
        // sibling of the folder being deleted, precisely so it outlives it.
        const backup = backupEnvFile({
          appsRoot: context.options.appsRoot,
          name: context.options.name,
          deployRoot: context.options.deployRoot,
          ...(context.options.now === undefined ? {} : { now: context.options.now }),
          ...(context.options.dryRun === true ? { dryRun: true } : {}),
        });

        if (backup === undefined) {
          context.journal.line('No .env found; nothing to back up.');
          context.hooks?.onProgress?.('No .env found; nothing to back up');
          return;
        }

        context.backup = backup;
        const verb = context.options.dryRun === true ? 'Would copy' : 'Copied';
        context.journal.line(`${verb} ${backup.source} to ${backup.path} (${backup.bytes} bytes, 0600)`);
        context.hooks?.onProgress?.(`${verb} the .env to ${backup.path}`);
      },
    },
    {
      id: 'compose-down',
      title: 'Stop and remove the containers, networks and volumes',
      skip(context) {
        const cwd = composeCwd(context.options.deployRoot);
        if (!existsSync(cwd)) {
          // The clone is already gone - the exact half-removed state this
          // command exists to finish. Compose cannot run without its files, so
          // the operator gets the one command that works without them.
          context.warnings.push(
            `${cwd} is missing, so the compose project could not be torn down. ` +
              `If containers for this app are still running, remove them with:\n` +
              `  docker rm -f $(docker ps -aq --filter label=com.docker.compose.project=${context.options.name})\n` +
              `  docker volume ls -q --filter label=com.docker.compose.project=${context.options.name} | xargs -r docker volume rm`,
          );
          return 'the compose files are already gone';
        }
        return undefined;
      },
      async run(context) {
        // `down -v --remove-orphans` through the SAME `-p <name> -f base -f
        // prod -f vps` invocation install.ts uses, derived from `composeArgv`
        // rather than restated - two copies of that list is exactly how an app
        // ends up with an orphaned volume nobody can name.
        //
        // `-v` removes the project's NAMED volumes, which is the whole point:
        // a "start over" that keeps the volumes is the failure this command
        // exists to stop improvised. It cannot touch a volume declared
        // `external:`, and there are none in these three files.
        const argv = composeArgv(context.options.name, ['down', '-v', '--remove-orphans']);

        if (context.options.dryRun === true) {
          record(context, { kind: 'compose-project', target: argv.join(' '), existed: true });
          return;
        }

        const result = await context.runCommand(argv, {
          cwd: composeCwd(context.options.deployRoot),
          timeoutMs: 10 * 60_000,
          redact: context.journal.redact,
          ...(context.hooks?.onLog === undefined
            ? {}
            : { onLine: (line: string) => context.hooks?.onLog?.(line) }),
        });
        context.journal.command(result);
        record(context, {
          kind: 'compose-project',
          target: `compose project ${context.options.name}`,
          existed: true,
        });
      },
    },
    {
      id: 'vhost',
      title: 'Remove the vhost from the shared proxy and reload it',
      skip(context) {
        if (context.options.skipProxy === true) return 'skipped with --skip-proxy';
        if (proxyTargetFor(context) === undefined) return 'this deployment was never published under a domain';
        return undefined;
      },
      async run(context) {
        const target = proxyTargetFor(context);
        // Unreachable: the skip above covers it. Narrowing for the compiler.
        if (target === undefined) return;

        const path = vhostPath(target);
        const existed = existsSync(path);

        if (context.options.dryRun === true) {
          record(context, { kind: 'vhost', target: path, existed });
          return;
        }

        // `removeVhost` is the existing, exact-path removal - NEVER a glob
        // over conf.d. It refuses a file this CLI did not write (the `#
        // Managed by appctl deploy` marker), returns quietly when there is
        // none, and reloads only when `nginx -t` passes afterwards, so a proxy
        // that was already broken is not restarted into a worse state.
        await removeVhost(target, {
          runCommand: context.runCommand,
          proxyContainer:
            context.options.proxyContainer ??
            context.state?.proxyContainer ??
            DEFAULT_PROXY_CONTAINER,
          redact: context.journal.redact,
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
        });
        record(context, { kind: 'vhost', target: path, existed });
      },
    },
    {
      id: 'cron',
      title: 'Remove the certificate renewal cron',
      skip: (context) =>
        context.options.skipProxy === true ? 'skipped with --skip-proxy' : undefined,
      async run(context) {
        // `/etc/cron.d/<cli>-certs-<name>`, written by install when it issued
        // a certificate.
        //
        // THE ENTRIES ARE NOT INDEPENDENT, AND THAT IS THE WHOLE DIFFICULTY.
        // `renderRenewalCron` emits `deploy certs renew --all` deliberately -
        // "the proxy is shared, and one entry renewing every lineage under it
        // serves every app this CLI manages" - so the LAST surviving entry is
        // renewing every OTHER app's certificates too. Removing it therefore
        // stops automatic renewal for the entire shared proxy, and the bill
        // arrives 60-90 days later as expired certificates across every app on
        // the box, with nothing connecting the outage to the uninstall that
        // caused it.
        //
        // That is the same "shared with every other app" argument this command
        // already accepts for `devnet`, the proxy container and the
        // certificates themselves. So this step asks first.
        //
        // IT STILL REMOVES THE ENTRY EITHER WAY, because leaving it is worse
        // than removing it: the line points `--apps-root <root> --name <name>`
        // at a deploy root this run is about to delete, so it would fail on
        // every single run from here on - a cron that is present, broken and
        // silent is not renewal coverage. What changes is that losing the last
        // one is reported as something the operator must act on, not recorded
        // as a footnote in a spec they will never read.
        const others = listRenewalCrons(context.options.cronDir).filter(
          (name) => name !== context.options.name,
        );

        const path = renewalCronPath(context.options.name, context.options.cronDir);
        const outcome = removePath(path, context.options.dryRun === true);
        record(context, { kind: 'cron', target: outcome.path, existed: outcome.existed });

        // Nothing was there to remove, so nothing stopped. An app installed
        // with `--no-install-cron`, or one that never issued a certificate.
        if (!outcome.existed) return;
        if (others.length > 0) {
          context.journal.line(
            `Renewal is still covered by ${others.length} other entr${others.length === 1 ? 'y' : 'ies'} (${others.join(', ')}), each of which renews every certificate behind this proxy.`,
          );
          return;
        }

        context.warnings.push(lastRenewalCronWarning(context));
      },
    },
    {
      id: 'certificates',
      title: 'Delete the TLS certificate',
      skip(context) {
        if (context.options.certs !== true) {
          const target = proxyTargetFor(context);
          context.kept.push({
            target: target === undefined ? 'TLS certificates' : `certificate for ${target.domain}`,
            reason:
              "kept by default: Let's Encrypt allows 5 duplicate certificates per week, and " +
              'destroying one you are about to re-request is how a broken install locks you ' +
              'out of your own domain. Pass --certs to delete it.',
          });
          return 'kept by default; pass --certs to delete it';
        }
        if (proxyTargetFor(context) === undefined) return 'no domain, so no certificate';
        return undefined;
      },
      async run(context) {
        const target = proxyTargetFor(context);
        if (target === undefined) return;

        // certbot's own `delete`, not `rm -rf` into letsencrypt/live. That
        // directory is three linked trees (live/, archive/, renewal/) and a
        // partial removal leaves certbot unable to renew OR reissue for the
        // name; `delete --cert-name` is the operation that knows all three.
        const argv = certbotArgv(target.proxyRoot, [
          'delete',
          '--non-interactive',
          '--cert-name',
          target.domain,
        ]);

        if (context.options.dryRun === true) {
          record(context, { kind: 'certificate', target: argv.join(' '), existed: true });
          return;
        }

        try {
          context.journal.command(
            await context.runCommand(argv, {
              cwd: context.options.appsRoot,
              timeoutMs: 5 * 60_000,
              redact: context.journal.redact,
              ...(context.hooks?.onLog === undefined
                ? {}
                : { onLine: (line: string) => context.hooks?.onLog?.(line) }),
            }),
          );
          record(context, { kind: 'certificate', target: target.domain, existed: true });
        } catch (error) {
          // A certificate that is not there is the ordinary case on a
          // deployment that never got one, and it must not fail the run -
          // everything after this step is the removal the operator asked for.
          context.warnings.push(
            `certbot could not delete the certificate for ${target.domain}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          record(context, { kind: 'certificate', target: target.domain, existed: false });
        }
      },
    },
    {
      id: 'deploy-root',
      title: 'Remove the deployment directory',
      async run(context) {
        // repo/, .env, logs/, data/, deploy-info/ and the state file - named
        // one by one so `--dry-run` prints a list rather than a promise, and
        // so `--keep-env` can spare exactly one of them.
        // THE JOURNAL LIVES AT `<deployRoot>/logs/`, which this step is about
        // to delete. Its last useful line is written here, while its files
        // still exist, and it is then stood down - otherwise every removal
        // below would append to a file that is gone and trip journal.ts's
        // degraded-mode warning on an otherwise perfectly clean run.
        //
        // So an uninstall's journal survives only a FAILED uninstall, which
        // is exactly the run somebody wants a log of. A successful one
        // deletes its own log along with everything else, by design: `logs/`
        // is part of the deployment being removed.
        context.journal.line(`Removing ${context.options.deployRoot}`);
        context.journal = nullJournal();

        const keep = context.options.keepEnv === true ? [ENV_FILENAME] : [];
        const result = removeDeployRoot({
          deployRoot: context.options.deployRoot,
          keep,
          ...(context.options.dryRun === true ? { dryRun: true } : {}),
        });

        if (!result.existed) {
          context.journal.line(`${context.options.deployRoot} is already gone.`);
          record(context, { kind: 'path', target: context.options.deployRoot, existed: false });
          return;
        }

        for (const outcome of result.removed) {
          record(context, { kind: 'path', target: outcome.path, existed: outcome.existed });
        }
        for (const path of result.kept) {
          context.kept.push({ target: path, reason: 'kept with --keep-env' });
        }
        if (result.removedRoot) {
          record(context, { kind: 'path', target: context.options.deployRoot, existed: true });
        }
      },
    },
  ];
}

/**
 * The typed confirmation.
 *
 * Exported so the command layer and its tests can reach it directly. Three
 * paths, and only three:
 *
 *   - `--dry-run`: nothing is destroyed, so nothing is confirmed. Requiring a
 *     confirmation to be told what WOULD happen is how an operator learns to
 *     type the word without reading the question.
 *   - `--confirm <name>` given: it must be the app's name, exactly. A
 *     mismatch is refused and names both, because the commonest cause is the
 *     operator being in a different deployment than they think.
 *   - nothing given: ask, if there is a terminal. Without one - `--non-
 *     interactive`, a pipe, cron - REFUSE. A destructive command whose
 *     confirmation can be satisfied by the absence of a terminal has no
 *     confirmation.
 */
export async function requireConfirmation(options: {
  name: string;
  deployRoot: string;
  confirmation?: string | undefined;
  dryRun?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  promptContext?: PromptContext | undefined;
}): Promise<void> {
  if (options.dryRun === true) return;

  if (options.confirmation !== undefined) {
    if (options.confirmation.trim() === options.name) return;
    throw new UsageError(
      `--confirm ${JSON.stringify(options.confirmation)} does not name the app being removed. ` +
        `Type the app's own name to authorise this: --confirm ${options.name}`,
    );
  }

  if (options.nonInteractive === true || !canPrompt(options.promptContext)) {
    throw new UsageError(
      `Removing ${options.name} at ${options.deployRoot} is irreversible and needs the app's name typed to authorise it.\n` +
        `There is no terminal to ask on, so pass it as a flag: --confirm ${options.name}\n` +
        `Or see what would be removed first, which needs no confirmation: \`${CLI_NAME} deploy uninstall --dry-run\``,
    );
  }

  const typed = await prompt(
    `Type ${options.name} to remove it and everything under ${options.deployRoot}: `,
    options.promptContext,
  );
  if (typed.trim() !== options.name) {
    throw new UsageError(`That is not ${options.name}. Nothing was removed.`);
  }
}

export async function runUninstall(input: UninstallOptions): Promise<UninstallResult> {
  const runCommand = input.runCommand ?? defaultRunCommand;
  const appsRoot = input.appsRoot ?? DEFAULT_APPS_ROOT;

  // `locateInstalledApp` refuses when nothing is installed and when several
  // apps are installed and none was named - a destructive command must never
  // guess which deployment was meant. `--root` still names one outright, which
  // is what makes a deployment whose state file was already deleted by hand
  // removable at all.
  const layout =
    input.deployRoot === undefined && input.name === undefined
      ? locateInstalledApp({ appsRoot })
      : ({
          appsRoot,
          name: input.name ?? basename(input.deployRoot ?? ''),
          deployRoot: input.deployRoot ?? join(appsRoot, input.name ?? ''),
        } satisfies ResolvedLayout);

  const options: ResolvedUninstallOptions = { ...input, ...layout };
  const dryRun = options.dryRun === true;

  await requireConfirmation({
    name: options.name,
    deployRoot: options.deployRoot,
    ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
    ...(dryRun ? { dryRun: true } : {}),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.promptContext === undefined ? {} : { promptContext: options.promptContext }),
  });

  // An unreadable state file must not stop a removal: `readState` throws on a
  // foreign version or broken JSON, and that is precisely the deployment
  // somebody most wants to be rid of.
  let state: DeployState | undefined;
  try {
    state = readState(options.deployRoot);
  } catch {
    state = undefined;
  }

  // A dry run writes NOTHING, the journal included - see `nullJournal`. Nor
  // does a deployment whose root is already gone: `openJournal` creates
  // `<deployRoot>/logs/`, which would resurrect the very directory this run
  // exists to remove, only to delete it again three steps later.
  const journal =
    dryRun || !existsSync(options.deployRoot)
      ? nullJournal()
      : openJournal({ deployRoot: options.deployRoot, command: 'uninstall' });

  const context: UninstallContext = {
    options,
    runCommand,
    journal,
    state,
    removed: [],
    kept: [],
    warnings: [],
    hooks: options.hooks,
    completed: new Set<string>(),
  };

  const result = await runPipeline(buildUninstallSteps(), context);

  if (result.failed !== undefined) {
    context.journal.finish('failure', `${result.failed.id}: ${result.failed.detail ?? ''}`);
    throw pipelineFailure(
      result,
      `${result.failed.title} failed: ${result.failed.detail ?? 'unknown error'}\n` +
        (journal.path === '' ? '' : `The full log is at ${journal.path}\n`) +
        `Nothing after this step was removed; re-run to continue.`,
    );
  }

  // Through `context.journal`, NOT the `journal` const above: the
  // `deploy-root` step stood the real one down before deleting `logs/`, so
  // this is a no-op on the success path. Finishing the deleted journal
  // instead would append to a file that is gone and print journal.ts's
  // degraded-mode warning at the end of every clean uninstall.
  context.journal.finish('success');

  return {
    name: options.name,
    deployRoot: options.deployRoot,
    dryRun,
    removed: context.removed,
    kept: context.kept,
    ...(context.backup === undefined ? {} : { envBackupPath: context.backup.path }),
    // Reported only when it is still there to read: a successful uninstall
    // deletes `logs/` along with the rest of the deploy root.
    ...(journal.path !== '' && existsSync(journal.path) ? { journalPath: journal.path } : {}),
    ...(context.databaseCommand === undefined ? {} : { databaseCommand: context.databaseCommand }),
    warnings: context.warnings,
  };
}
