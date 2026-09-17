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
import {
  databaseFacts,
  describeDatabase,
  dropDatabase,
  droppableDatabase,
  type DatabaseDropOutcome,
  type DatabaseFacts,
} from './database-drop.js';
import {
  describeInventory,
  inventoryStorage,
  purgeStorage,
  storageProblem,
  storageSettings,
  type PurgeStorageResult,
  type StorageInventory,
  type StorageSettings,
} from './storage-purge.js';
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
//
// -----------------------------------------------------------------------------
// THE TWO OPT-IN EXTRAS  (issue #268)
// -----------------------------------------------------------------------------
//
// Refusal 1 above is now qualified rather than absolute: `--drop-database` and
// `--purge-storage` reach OUTSIDE the deployment, at the data, and neither is
// reachable by omission. Without the flag, refusal 1 stands exactly as #261
// wrote it and the `dropdb` command is printed instead. The other three
// refusals are untouched.
//
// FOUR RULES GOVERN THEM, AND EACH ANSWERS A SPECIFIC WAY TO GET THIS WRONG:
//
//   1. EACH EXTRA HAS ITS OWN TYPED CONFIRMATION OF THAT RESOURCE'S REAL NAME
//      - the database name for the drop, the bucket name for the purge. A word
//      typed for one can never authorise the other, which is the API's own
//      convention (`confirmation: "RESTORE"` / `"ROLLBACK"`, and the Danger
//      Zone's rule that THE CONFIRMATION IS THE SCOPE, UPPERCASED). One shared
//      "yes, delete the data too" would be a single keystroke authorising two
//      unrelated, unrecoverable acts against two different systems.
//   2. THE INVENTORY IS READ BEFORE ANY CONFIRMATION IS ASKED FOR. Object
//      count and bytes per prefix, anything in the bucket that is not ours,
//      the database's name, host, size and open sessions. An operator cannot
//      consent to a number they were never shown - so the read happens in
//      `runUninstall`, ahead of every prompt, and `--dry-run` prints the same
//      thing while confirming nothing.
//   3. THE ORDER IS FIXED: containers down, then storage, then the database,
//      then the deployment. Containers first because nothing may write an
//      object or open a connection mid-teardown. STORAGE BEFORE THE DATABASE
//      because the deployment's own rows are the only thing that could ever
//      reconcile an object the purge missed, and once the database is gone
//      that reconciliation is impossible. THE DEPLOYMENT LAST because its
//      `.env` holds the credentials the other two steps need - deleting it
//      first would leave the extras with nothing to authenticate with.
//   4. A FAILED EXTRA DOES NOT FAIL THE UNINSTALL. It is recorded as a warning
//      the operator has to act on. The deployment was going whatever the
//      bucket said, and an abort here would leave an arbitrary amount done
//      with the containers already stopped.
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
  /** Also `DROP DATABASE`. Off by default; needs `confirmDatabase`. (#268) */
  dropDatabase?: boolean | undefined;
  /** The database's own name, typed. `--confirm-database <name>`. */
  confirmDatabase?: string | undefined;
  /** Also empty this app's six prefixes in the bucket. Off by default. (#268) */
  purgeStorage?: boolean | undefined;
  /** The bucket's own name, typed. `--confirm-bucket <name>`. */
  confirmBucket?: string | undefined;
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
  kind: 'compose-project' | 'path' | 'certificate' | 'vhost' | 'cron' | 'bucket-prefix' | 'database';
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
  /**
   * What the object store held, and what was removed from it. Present only
   * when `--purge-storage` was passed - reading a bucket costs money and time,
   * so an ordinary uninstall never touches it at all. (#268)
   */
  storage?: StorageExtraResult | undefined;
  /** Likewise for the database, under `--drop-database`. (#268) */
  database?: DatabaseExtraResult | undefined;
}

/** The storage extra, whether it ran, was rehearsed, or could not start. */
export interface StorageExtraResult {
  /** What was found. Absent when the bucket could not be read at all. */
  inventory?: StorageInventory | undefined;
  /** The purge. Absent when it never started. */
  purge?: PurgeStorageResult | undefined;
  /** Why nothing happened - no bucket configured, no credentials, unreachable. */
  problem?: string | undefined;
}

/** The database extra, same three shapes. */
export interface DatabaseExtraResult {
  facts?: DatabaseFacts | undefined;
  outcome?: DatabaseDropOutcome | undefined;
  problem?: string | undefined;
}

/**
 * Everything the extras need, read ONCE before any confirmation (rule 2).
 *
 * Carried into the pipeline rather than re-read there, so the numbers the
 * operator consented to are the numbers the purge acts on - a second listing
 * between the prompt and the delete could differ, and consent given to the
 * first would be silently spent on the second.
 */
interface ExtrasPlan {
  storage?:
    | { settings: StorageSettings; inventory: StorageInventory }
    | { problem: string }
    | undefined;
  database?:
    | { settings: import('./checks/database.js').DatabaseSettings; facts: DatabaseFacts }
    | { problem: string }
    | undefined;
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
  plan: ExtrasPlan;
  storage?: StorageExtraResult | undefined;
  database?: DatabaseExtraResult | undefined;
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
  // NARROWED TO A RECORDED SURVIVOR ON PURPOSE (#285). `listInstalledApps` now
  // also reports deployments recognised by evidence alone, which is right for
  // discovery and wrong here: the command below is
  // `certs renew --install-cron --name <survivor>`, and that command resolves
  // its certificate lineage from the survivor's RECORDED DOMAIN. A survivor
  // with no state file has none, so naming it would hand the operator a
  // pasteable command that fails with "is not published under a domain" - the
  // exact opposite of this warning's whole purpose.
  const survivor = listInstalledApps(appsRoot).find(
    (app) =>
      app.state !== undefined &&
      app.name !== name &&
      app.deployRoot !== context.options.deployRoot,
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
        //
        // Refusal 1 is SKIPPED when `--drop-database` was passed and accepted:
        // the operator has typed the database's own name, so reporting it as
        // "not removed" in the same run that removes it would be the one thing
        // worse than not reporting it at all. Every other refusal is
        // unconditional, exactly as #261 left them.
        if (context.options.dropDatabase !== true) {
          context.kept.push({
            target: env.get('POSTGRES_DB') ?? 'the external database',
            reason:
              context.databaseCommand === undefined
                ? 'this deployment never manages the database; drop it yourself if you want it gone'
                : `never removed by ${CLI_NAME}; drop it yourself with: ${context.databaseCommand}`,
          });
        }
        if (context.options.purgeStorage !== true) {
          const bucket = env.get('S3_BUCKET') ?? '';
          context.kept.push({
            target: bucket === '' ? 'the object storage bucket' : `${bucket} (object storage)`,
            reason:
              'never emptied by default; it holds uploads, transcripts, notes and backups. ' +
              'Pass --purge-storage to empty this application\'s own prefixes in it.',
          });
        }
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
    // -------------------------------------------------------------------------
    // The two opt-in extras (#268), between the containers and the deployment.
    //
    // HERE AND NOWHERE ELSE, for the ordering argument in the file header:
    // AFTER `compose-down`, so nothing of this app's is writing objects or
    // holding connections; BEFORE `deploy-root`, whose `.env` holds the
    // credentials both of them authenticate with. Storage first, because the
    // deployment's own rows are the only thing that could ever reconcile an
    // object this purge missed, and the drop below destroys them.
    // -------------------------------------------------------------------------
    {
      id: 'purge-storage',
      title: 'Empty this application\'s prefixes in the object store',
      skip(context) {
        if (context.options.purgeStorage !== true) return 'not asked for; pass --purge-storage';
        return undefined;
      },
      async run(context) {
        const plan = context.plan.storage;
        if (plan === undefined || 'problem' in plan) {
          const problem = plan?.problem ?? 'no bucket is configured in this deployment\'s .env';
          context.storage = { problem };
          context.warnings.push(
            `The object store was NOT emptied: ${problem}\n` +
              'Nothing in the bucket was read or changed. Empty it yourself if you want it gone.',
          );
          return;
        }

        const result = await purgeStorage(context, plan.settings, plan.inventory, {
          ...(context.options.dryRun === true ? { dryRun: true } : {}),
          onProgress: (message) => {
            context.journal.line(message);
            context.hooks?.onProgress?.(message);
          },
        });
        context.storage = { inventory: plan.inventory, purge: result };

        for (const entry of result.deleted) {
          record(context, {
            kind: 'bucket-prefix',
            target: `s3://${plan.settings.bucket}/${entry.prefix} (${entry.keys} key(s))`,
            existed: entry.keys > 0,
          });
        }

        // Rule 4: a failed prefix is a warning, never a failed uninstall.
        if (result.failures.length > 0) {
          context.warnings.push(
            [
              `${result.failures.length} prefix(es) of ${plan.settings.bucket} could NOT be emptied:`,
              ...result.failures.map((failure) => `  ${failure}`),
              ...(result.versionsRemain === undefined ? [] : ['', result.versionsRemain]),
              '',
              'The deployment was removed anyway. Those objects are still there and still billed.',
            ].join('\n'),
          );
        }

        // Said on EVERY successful purge, not only a partial one: "emptied"
        // means something different on a shared bucket, and the operator who
        // needs to hear it is the one whose run went perfectly.
        if (plan.inventory.foreign.length > 0) {
          context.kept.push({
            target: `${plan.inventory.foreign.length} other item(s) in ${plan.settings.bucket}`,
            reason:
              'not written by this application, so neither inspected nor deleted: ' +
              plan.inventory.foreign.map((entry) => entry.key).join(', '),
          });
        }
        context.kept.push({
          target: `the bucket ${plan.settings.bucket} itself`,
          reason: 'emptied of this application\'s objects, never deleted - the bucket is yours',
        });
      },
    },
    {
      id: 'drop-database',
      title: 'Drop the database',
      skip(context) {
        if (context.options.dropDatabase !== true) return 'not asked for; pass --drop-database';
        return undefined;
      },
      async run(context) {
        const plan = context.plan.database;
        if (plan === undefined || 'problem' in plan) {
          const problem = plan?.problem ?? 'no database is named in this deployment\'s .env';
          context.database = { problem };
          context.warnings.push(
            `The database was NOT dropped: ${problem}\n` +
              (context.databaseCommand === undefined
                ? 'Nothing was changed on the database server.'
                : `Nothing was changed on the database server. Drop it yourself with: ${context.databaseCommand}`),
          );
          return;
        }

        if (context.options.dryRun === true) {
          context.database = { facts: plan.facts };
          record(context, {
            kind: 'database',
            target: `DROP DATABASE "${plan.settings.database}" on ${plan.settings.host}:${plan.settings.port}`,
            existed: plan.facts.problem === undefined,
          });
          return;
        }

        const outcome = await dropDatabase(context, plan.settings);
        context.database = { facts: plan.facts, outcome };

        if (outcome.ok) {
          if (outcome.terminated > 0) {
            // Reported, always. Ending somebody else's session is defensible
            // (see database-drop.ts's header) and it is never silent.
            context.journal.line(
              `Ended ${outcome.terminated} open session(s) against ${plan.settings.database} to drop it.`,
            );
            context.hooks?.onProgress?.(
              `ended ${outcome.terminated} open session(s) against ${plan.settings.database}`,
            );
          }
          record(context, {
            kind: 'database',
            target: `${plan.settings.database} on ${plan.settings.host}:${plan.settings.port}`,
            existed: !outcome.detail.includes('already gone'),
          });
          return;
        }

        context.warnings.push(
          [
            `The database was NOT dropped: ${outcome.detail}`,
            outcome.remedy,
            '',
            'The deployment was removed anyway. The data is still there.',
          ].join('\n'),
        );
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

/**
 * The typed confirmation for ONE destructive extra (#268).
 *
 * ⚠ THE VALUE IS THAT RESOURCE'S OWN REAL NAME - the database's name for the
 * drop, the bucket's name for the purge - and it is compared against nothing
 * else. That is the whole guarantee: `--confirm-bucket my-bucket` reaches only
 * this function with `expected` set to the bucket name, so it can never
 * satisfy the database drop, and vice versa. A shared "--yes-delete-data"
 * would be one keystroke authorising two unrecoverable acts against two
 * different systems, which is exactly what the API's own convention (the
 * Danger Zone's "the confirmation IS the scope, uppercased") exists to stop.
 *
 * `--dry-run` confirms nothing, for `requireConfirmation`'s reason: making an
 * operator type a name to be TOLD what would happen teaches them to type it
 * without reading.
 */
export async function requireResourceConfirmation(options: {
  /** `database` or `bucket` - what the flag is called, for the message. */
  resource: 'database' | 'bucket';
  /** The exact name that must be typed. */
  expected: string;
  /** What it is and where, so the operator can check they mean this one. */
  description: string;
  confirmation?: string | undefined;
  dryRun?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  promptContext?: PromptContext | undefined;
}): Promise<void> {
  if (options.dryRun === true) return;
  const flag = options.resource === 'database' ? '--confirm-database' : '--confirm-bucket';

  if (options.confirmation !== undefined) {
    if (options.confirmation.trim() === options.expected) return;
    throw new UsageError(
      `${flag} ${JSON.stringify(options.confirmation)} does not name the ${options.resource} being destroyed ` +
        `(${options.description}).\n` +
        `Type its own name to authorise this: ${flag} ${options.expected}`,
    );
  }

  if (options.nonInteractive === true || !canPrompt(options.promptContext)) {
    throw new UsageError(
      `Destroying ${options.description} is irreversible and needs the ${options.resource}'s own name typed to authorise it.\n` +
        `There is no terminal to ask on, so pass it as a flag: ${flag} ${options.expected}\n` +
        `Or see exactly what would be destroyed first, which needs no confirmation: \`${CLI_NAME} deploy uninstall --dry-run\``,
    );
  }

  const typed = await prompt(
    `Type ${options.expected} to destroy ${options.description}: `,
    options.promptContext,
  );
  if (typed.trim() !== options.expected) {
    throw new UsageError(`That is not ${options.expected}. Nothing was removed.`);
  }
}

/**
 * Reads what the extras would destroy, BEFORE any confirmation (rule 2).
 *
 * ⚠ EVERY CALL ON THIS PATH IS READ-ONLY. `inventoryStorage` lists; `database
 * Facts` runs two SELECTs. Nothing here deletes, drops, creates or terminates
 * - it runs under `--dry-run` and it runs before the operator has decided.
 *
 * A failure to READ is never a failure to run: a bucket this key may not list
 * and a database this role may not size are both recorded as a `problem` the
 * step reports as a warning. Refusing to uninstall a deployment because its
 * bucket could not be inspected would be the same mistake `readEnvQuietly`
 * already avoids about a `.env` that will not parse.
 */
async function planExtras(
  options: ResolvedUninstallOptions,
  env: ReadonlyMap<string, string>,
  runCommand: typeof defaultRunCommand,
): Promise<ExtrasPlan> {
  const plan: ExtrasPlan = {};

  if (options.purgeStorage === true) {
    const settings = storageSettings(env);
    if (settings === undefined) {
      plan.storage = { problem: 'S3_BUCKET is not set in this deployment\'s .env' };
    } else {
      const problem = storageProblem(settings);
      if (problem !== undefined) {
        plan.storage = { problem };
      } else {
        try {
          plan.storage = { settings, inventory: await inventoryStorage({ runCommand }, settings) };
        } catch (error) {
          plan.storage = {
            problem: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
  }

  if (options.dropDatabase === true) {
    const target = droppableDatabase(env);
    if (target === undefined) {
      plan.database = { problem: 'POSTGRES_DB is not set in this deployment\'s .env' };
    } else {
      const facts = await databaseFacts({ runCommand }, target.settings);
      plan.database = { settings: target.settings, facts };
    }
  }

  return plan;
}

/** The inventory, as the operator sees it before being asked to consent. */
export function describeExtras(plan: ExtrasPlan): string[] {
  const lines: string[] = [];
  if (plan.storage !== undefined) {
    lines.push('', 'Object storage');
    lines.push(
      ...('problem' in plan.storage
        ? [`Could not be read: ${plan.storage.problem}`, 'Nothing in it will be touched.']
        : describeInventory(plan.storage.inventory)),
    );
  }
  if (plan.database !== undefined) {
    lines.push('', 'Database');
    lines.push(
      ...('problem' in plan.database
        ? [`Could not be read: ${plan.database.problem}`, 'Nothing on the server will be touched.']
        : describeDatabase(plan.database.facts)),
    );
  }
  return lines;
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

  // RULE 2, AND IT IS THE REASON THIS RUNS HERE RATHER THAN IN A STEP: the
  // inventory has to exist before the FIRST confirmation is asked for, and the
  // pipeline does not start until the last one is answered. Read-only, and
  // skipped entirely when neither extra was asked for - an ordinary uninstall
  // never lists a bucket or connects to a database.
  const env = readEnvQuietly(options.deployRoot);
  const plan = await planExtras(options, env, runCommand);
  const inventory = describeExtras(plan);
  if (inventory.length > 0) {
    for (const line of inventory) options.hooks?.onProgress?.(line);
  }

  await requireConfirmation({
    name: options.name,
    deployRoot: options.deployRoot,
    ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
    ...(dryRun ? { dryRun: true } : {}),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.promptContext === undefined ? {} : { promptContext: options.promptContext }),
  });

  // THEN one confirmation per extra, in the order they will run. Asked after
  // the app name because that one gates the uninstall itself: there is no
  // point consenting to a bucket being emptied by a command that is about to
  // refuse. Asked SEPARATELY because rule 1 says a word typed for one resource
  // may never authorise the other.
  //
  // A resource that could not be READ is not confirmed at all - there is no
  // real name to type, and the step will report the problem as a warning
  // rather than destroying something it could not describe.
  if (plan.storage !== undefined && !('problem' in plan.storage)) {
    await requireResourceConfirmation({
      resource: 'bucket',
      expected: plan.storage.settings.bucket,
      description:
        `every object under ${plan.storage.inventory.prefixes.length} prefix(es) of ` +
        `${plan.storage.settings.bucket} (${plan.storage.inventory.objects} object(s))`,
      ...(options.confirmBucket === undefined ? {} : { confirmation: options.confirmBucket }),
      ...(dryRun ? { dryRun: true } : {}),
      ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
      ...(options.promptContext === undefined ? {} : { promptContext: options.promptContext }),
    });
  }
  if (plan.database !== undefined && !('problem' in plan.database)) {
    await requireResourceConfirmation({
      resource: 'database',
      expected: plan.database.settings.database,
      description: `the database ${plan.database.settings.database} on ${plan.database.settings.host}:${plan.database.settings.port}`,
      ...(options.confirmDatabase === undefined ? {} : { confirmation: options.confirmDatabase }),
      ...(dryRun ? { dryRun: true } : {}),
      ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
      ...(options.promptContext === undefined ? {} : { promptContext: options.promptContext }),
    });
  }

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
    plan,
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
    ...(context.storage === undefined ? {} : { storage: context.storage }),
    ...(context.database === undefined ? {} : { database: context.database }),
  };
}
