import { ApiClient, resolveApiBaseUrl, type FetchLike } from '../api-client.js';
import { CLI_NAME } from '../branding.js';
import { resolveConfig, type ConfigContext } from '../config.js';
import {
  readDeployInfo,
  updateDeployInfoRemote,
  type DeployInfo,
  type DeployRemote,
} from './deploy-info.js';
import { runCommand as defaultRunCommand } from './executor.js';
import { locateInstalledApp, type LocateOptions, type ResolvedLayout } from './layout.js';
import { envFilePath } from './env-file.js';
import { collectServerFacts, type ServerFacts } from './server-facts.js';
import { NotInstalledError, readState, type DeployState } from './state.js';
import {
  checkForUpdate as defaultCheckForUpdate,
  remoteFromCheck,
  type UpdateCheckOptions,
  type UpdateCheckResult,
} from './update.js';

// =============================================================================
// `deploy about`: what is deployed here, in one report  (issue #128, epic #118)
// =============================================================================
//
// The same three blocks the web Console's About card renders (#126), assembled
// on the server itself from four sources with four different provenances -
// published side by side so nobody has to guess where a number came from:
//
//   * `deploy-info/info.json` (#120) - AUTHORITATIVE for the timestamps, the
//     app version and the host facts. It is the document the last successful
//     deploy wrote, which is precisely what "when was this deployed, onto
//     what" means. The state file is not: it is the CLI's private 0600 record,
//     it is refused outright on a version mismatch, and a reader that leaned
//     on it would report nothing at all for a deployment one CLI version ahead.
//
//   * the state file - fills the four things the info document deliberately
//     does NOT carry because the API has no business reading them:
//     `completedSteps`, `previousSha`, `envPath` and `proxyContainer`.
//
//   * `server-facts.ts`, read LIVE - so a box whose memory or Docker version
//     changed since the deploy says so, as `now`, beside the recorded value.
//
//   * `GET /api/admin/about` (#124) - the running process's own facts and the
//     database's, which nothing on disk can answer.
//
// THE WHOLE REPORT IS BEST-EFFORT EXCEPT FOR "IS ANYTHING INSTALLED".
// About is informational: it is the command an operator runs when something
// is wrong, so every one of the four sources above may be missing and the
// report still renders, naming what it could not read. Only "nothing is
// installed here" is an error, and it is the same EXIT.USAGE (2) `status`
// raises through the same `locateInstalledApp`, so a script can tell "no
// deployment" from "a deployment with a stopped API".
//
// THAT IS ALSO WHY `about` IS NOT A MODE OF `status` (rejected in #128).
// `status` has exit-code semantics a monitor depends on - 1 means unhealthy -
// and About must never exit non-zero for an unhealthy site.
//
// Every timestamp in the report is the ISO-8601 UTC string, exactly as the
// file carries it; formatting into `2026-09-15 18:02:11 UTC (3 hours ago)` is
// the renderer's job, so `--json` and `jq .deployment.updatedAt` see the
// file's own bytes.
// =============================================================================

/**
 * Five seconds for the API call.
 *
 * Long enough for a warm local container behind the loopback proxy, short
 * enough that About on a box whose API is wedged still prints the three
 * blocks that do not need it before an operator gives up on the command.
 */
export const ABOUT_API_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** What was deployed, merged from the info document and the state file. */
export interface AboutDeployment {
  /** The app folder and compose project name. */
  name: string;
  /** `apps/api/package.json` in the deployed clone, as recorded. */
  version: string | null;
  commitSha: string;
  ref: string;
  repoUrl: string;
  domain: string | null;
  bindPort: number;
  /** ISO-8601 UTC. */
  installedAt: string;
  /** ISO-8601 UTC; equals `installedAt` on a first install. */
  updatedAt: string;
  lastCommand: 'install' | 'update';
  deployedBy: { cli: string; version: string };
  deployRoot: string;
  // --- from the state file only; null when it does not carry them ---
  /** ISO-8601 UTC of the last attempt, successful or not. */
  lastAttemptAt: string | null;
  envPath: string | null;
  proxyContainer: string | null;
  previousSha: string | null;
  completedSteps: string[] | null;
}

/**
 * The machine, as recorded and as it is now.
 *
 * `now` holds ONLY the fields whose live value differs from the recorded one.
 * A live value of `null` is never a difference: a probe that could not answer
 * (no `df` on a minimal image, Docker not on this PATH) means "unknown", and
 * reporting it as a change would tell an operator their server lost its disk.
 */
export interface AboutHost {
  /** The facts the last deploy recorded; null when there is no info document. */
  deployed: ServerFacts | null;
  /** Live values that differ from `deployed` - or all of them when it is null. */
  now: Partial<ServerFacts>;
  /** False when the live probe could not be run at all. */
  probed: boolean;
}

/** The runtime block of `GET /api/admin/about`. */
export interface AboutApiRuntime {
  apiVersion: string;
  nodeVersion: string;
  processStartedAt: string;
  uptimeSeconds: number;
  serverTimeUtc: string;
  environment: string;
}

/** The database block of `GET /api/admin/about`. */
export interface AboutApiDatabase {
  serverVersion: string;
  appliedMigrations: number;
  lastMigrationName: string | null;
  lastMigrationAt: string | null;
}

/** What the running application answered. */
export interface AboutApi {
  /** The URL that was asked, so the report says which API this is. */
  serverUrl: string;
  runtime: AboutApiRuntime;
  database: AboutApiDatabase | null;
  /** Why `database` is null, when it is - the API answers 200 either way. */
  databaseError: string | null;
}

export interface AboutReport {
  /** ISO-8601 UTC: when this report was collected. */
  generatedAt: string;
  deployRoot: string;
  /** The compose project name, from the layout resolution. */
  name: string;
  deployment: AboutDeployment | null;
  /** Why `deployment` is null; null when it is not. */
  deploymentReason: string | null;
  host: AboutHost;
  /** The last recorded remote check; refreshed first when `check` is set. */
  remote: DeployRemote | null;
  /** Why `remote` could not be refreshed. Only ever set with `check`. */
  remoteError: string | null;
  /** `remote.commitsBehind > 0`; null when nothing has ever checked. */
  updateAvailable: boolean | null;
  api: AboutApi | null;
  /** Why `api` is null; null when it is not. */
  apiReason: string | null;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface CollectAboutOptions extends LocateOptions {
  runCommand?: typeof defaultRunCommand | undefined;
  /** Refresh `remote` through #123's update check before reporting it. */
  check?: boolean | undefined;
  /** `--server <url>`: ask this API instead of the one the domain implies. */
  serverUrl?: string | undefined;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: FetchLike | undefined;
  /** Injected for tests; defaults to `checkForUpdate` (#123). */
  checkForUpdate?: ((options: UpdateCheckOptions) => Promise<UpdateCheckResult>) | undefined;
  /** Injected for tests; defaults to `collectServerFacts`. */
  collectFacts?: typeof collectServerFacts | undefined;
  /** Injected for tests, so no test reads the developer's own config file. */
  configContext?: ConfigContext | undefined;
  /** Where `checkForUpdate` resolves the repository from. */
  cwd?: string | undefined;
  apiTimeoutMs?: number | undefined;
  now?: Date | undefined;
}

/**
 * One report for one deployment.
 *
 * Throws only `NotInstalledError` (EXIT.USAGE), and only when there is no
 * state file - see the header. Everything else is reported, never raised.
 */
export async function collectAbout(options: CollectAboutOptions): Promise<AboutReport> {
  const layout: ResolvedLayout = locateInstalledApp({
    appsRoot: options.appsRoot,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.root === undefined ? {} : { root: options.root }),
  });

  const state = readState(layout.deployRoot);
  if (state === undefined) {
    throw new NotInstalledError(
      `No deployment found at ${layout.deployRoot}. Run \`${CLI_NAME} deploy install\` first, or pass --name or --root.`,
    );
  }

  const exec = options.runCommand ?? defaultRunCommand;
  const now = options.now ?? new Date();

  // `--check` FIRST, so the `remote` the rest of the report carries is the one
  // that was just written rather than the one that was there a moment ago.
  const refreshed =
    options.check === true
      ? await refreshRemote(layout.deployRoot, state, exec, options)
      : { remote: undefined, error: null };

  const { info, reason: infoReason } = readInfo(layout.deployRoot);

  const deployment = info === undefined ? null : mergeDeployment(info, state, layout);
  const remote = refreshed.remote ?? info?.remote ?? null;

  const host = await collectHost(info, layout.deployRoot, exec, options);
  const api = await collectApi(deployment, options);

  return {
    generatedAt: now.toISOString(),
    deployRoot: layout.deployRoot,
    name: layout.name,
    deployment,
    deploymentReason: deployment === null ? (infoReason ?? 'no deployment record') : null,
    host,
    remote,
    remoteError: refreshed.error,
    updateAvailable: remote === null ? null : remote.commitsBehind > 0,
    api: 'api' in api ? api.api : null,
    apiReason: 'reason' in api ? api.reason : null,
  };
}

/** The info document, or the sentence explaining why there isn't one. */
function readInfo(deployRoot: string): { info?: DeployInfo | undefined; reason?: string } {
  try {
    const info = readDeployInfo(deployRoot);
    if (info === undefined) {
      return {
        reason:
          'no deploy-info/info.json - deployed by a CLI older than this record, or written by hand',
      };
    }
    return { info };
  } catch (error) {
    return { reason: error instanceof Error ? firstLine(error.message) : String(error) };
  }
}

/**
 * The info document is authoritative; the state supplies the four fields it
 * deliberately does not carry. The state's `commitSha` is NOT preferred over
 * the file's: they agree after a successful deploy, and after a failed one the
 * file is the half that still describes what is actually running.
 */
function mergeDeployment(
  info: DeployInfo,
  state: DeployState,
  layout: ResolvedLayout,
): AboutDeployment {
  return {
    name: info.app.name,
    version: info.app.version,
    commitSha: info.app.commitSha,
    ref: info.app.ref,
    repoUrl: info.app.repoUrl,
    domain: info.domain,
    bindPort: info.bindPort,
    installedAt: info.installedAt,
    updatedAt: info.updatedAt,
    lastCommand: info.lastCommand,
    deployedBy: info.deployedBy,
    deployRoot: layout.deployRoot,
    lastAttemptAt: state.lastAttemptAt ?? null,
    envPath: state.envPath ?? envFilePath(layout.deployRoot),
    proxyContainer: state.proxyContainer ?? null,
    previousSha: state.previousSha ?? null,
    completedSteps: state.completedSteps ?? null,
  };
}

/**
 * `--check`: the same computation `update --check` and `status` run, recorded
 * in the info document on the way past so the web card learns it too. A
 * failure - no network, a revoked token, no checkout - becomes a line in the
 * report; About must work offline.
 */
async function refreshRemote(
  deployRoot: string,
  state: DeployState,
  exec: typeof defaultRunCommand,
  options: CollectAboutOptions,
): Promise<{ remote: DeployRemote | undefined; error: string | null }> {
  const check = options.checkForUpdate ?? defaultCheckForUpdate;
  try {
    const result = await check({
      deployRoot,
      state,
      runCommand: exec,
      fetchTimeoutMs: 10_000,
      requireExisting: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const remote = remoteFromCheck(result.check);
    updateDeployInfoRemote(deployRoot, remote);
    return { remote, error: null };
  } catch (error) {
    return {
      remote: undefined,
      error: error instanceof Error ? firstLine(error.message) : String(error),
    };
  }
}

const HOST_KEYS = [
  'hostname',
  'os',
  'kernel',
  'arch',
  'cpuModel',
  'cpus',
  'memoryBytes',
  'diskBytes',
  'dockerVersion',
  'composeVersion',
  'nodeVersion',
] as const;

async function collectHost(
  info: DeployInfo | undefined,
  deployRoot: string,
  exec: typeof defaultRunCommand,
  options: CollectAboutOptions,
): Promise<AboutHost> {
  const collect = options.collectFacts ?? collectServerFacts;

  let live: ServerFacts | undefined;
  try {
    live = await collect({ runCommand: exec, root: deployRoot });
  } catch {
    live = undefined;
  }

  const deployed = info?.host ?? null;
  const now: Partial<ServerFacts> = {};

  if (live !== undefined) {
    for (const key of HOST_KEYS) {
      const current = live[key];
      // A probe that could not answer is unknown, not a change. See AboutHost.
      if (current === null) continue;
      if (deployed !== null && deployed[key] === current) continue;
      Object.assign(now, { [key]: current });
    }
  }

  return { deployed, now, probed: live !== undefined };
}

// ---------------------------------------------------------------------------
// The API block
// ---------------------------------------------------------------------------

type ApiOutcome = { api: AboutApi } | { reason: string };

/**
 * Asks the deployed application about itself, but only when the stored login
 * is for THIS deployment.
 *
 * The check is deliberate rather than "just use whatever is in the config":
 * an operator is routinely logged into a different environment from the one
 * whose server they happen to be on, and a report that quietly showed that
 * other deployment's API version beside this one's commit would be worse than
 * showing nothing. `--server` is the explicit override.
 */
async function collectApi(
  deployment: AboutDeployment | null,
  options: CollectAboutOptions,
): Promise<ApiOutcome> {
  const config = resolveConfig(options.configContext);
  if (config.token === undefined) return { reason: 'not logged in' };

  const target = resolveApiTarget(deployment, config.serverUrl, options.serverUrl);
  if ('reason' in target) return target;

  const client = new ApiClient({
    baseUrl: resolveApiBaseUrl(target.serverUrl),
    token: config.token,
    timeoutMs: options.apiTimeoutMs ?? ABOUT_API_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  try {
    const body = await client.get<unknown>('/admin/about');
    const runtime = readRuntime(body);
    if (runtime === undefined) return { reason: 'the API answered something this build cannot read' };
    return {
      api: {
        serverUrl: target.serverUrl,
        runtime,
        database: readDatabase(body),
        databaseError: readNullableString(body, 'databaseError'),
      },
    };
  } catch (error) {
    return { reason: error instanceof Error ? firstLine(error.message) : String(error) };
  }
}

/** `--server` wins; otherwise the stored server must be this app's domain. */
function resolveApiTarget(
  deployment: AboutDeployment | null,
  stored: string | undefined,
  override: string | undefined,
): { serverUrl: string } | { reason: string } {
  if (override !== undefined && override.trim() !== '') return { serverUrl: override.trim() };
  if (stored === undefined) return { reason: 'not logged in' };

  const domain = deployment?.domain ?? null;
  if (domain === null) {
    return { reason: 'this deployment has no domain; pass --server to name the API' };
  }

  const storedHost = hostOf(stored);
  if (storedHost === undefined) return { reason: `the stored server URL is not usable: ${stored}` };
  if (storedHost !== domain.trim().toLowerCase()) {
    return { reason: `logged in to ${storedHost}, not ${domain}; pass --server to ask it anyway` };
  }

  return { serverUrl: stored };
}

function hostOf(serverUrl: string): string | undefined {
  try {
    return new URL(resolveApiBaseUrl(serverUrl)).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRuntime(body: unknown): AboutApiRuntime | undefined {
  const runtime = asRecord(asRecord(body)?.['runtime']);
  if (runtime === undefined) return undefined;
  if (typeof runtime['apiVersion'] !== 'string') return undefined;
  return {
    apiVersion: runtime['apiVersion'],
    nodeVersion: stringOr(runtime['nodeVersion'], 'unknown'),
    processStartedAt: stringOr(runtime['processStartedAt'], ''),
    uptimeSeconds: typeof runtime['uptimeSeconds'] === 'number' ? runtime['uptimeSeconds'] : 0,
    serverTimeUtc: stringOr(runtime['serverTimeUtc'], ''),
    environment: stringOr(runtime['environment'], 'unknown'),
  };
}

function readDatabase(body: unknown): AboutApiDatabase | null {
  const database = asRecord(asRecord(body)?.['database']);
  if (database === undefined) return null;
  return {
    serverVersion: stringOr(database['serverVersion'], 'unknown'),
    appliedMigrations:
      typeof database['appliedMigrations'] === 'number' ? database['appliedMigrations'] : 0,
    lastMigrationName:
      typeof database['lastMigrationName'] === 'string' ? database['lastMigrationName'] : null,
    lastMigrationAt:
      typeof database['lastMigrationAt'] === 'string' ? database['lastMigrationAt'] : null,
  };
}

function readNullableString(body: unknown, key: string): string | null {
  const value = asRecord(body)?.[key];
  return typeof value === 'string' ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The label column, wider than `status`'s because this report's labels are
 * whole facts ("Operating system") rather than probe names ("Liveness").
 */
const LABEL_WIDTH = 22;

/** `2026-09-15 18:02:11 UTC`, or the input verbatim when it is not a date. */
export function formatUtc(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const text = new Date(parsed).toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 19)} UTC`;
}

/** "just now", "3 minutes ago", "3 hours ago", "6 days ago", "in 2 minutes". */
export function describeRelative(iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 'at an unknown time';

  const deltaMs = now - parsed;
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);
  const phrase = (value: number, unit: string): string =>
    `${value} ${unit}${value === 1 ? '' : 's'}`;

  let magnitude: string;
  if (seconds < 60) magnitude = 'moment';
  else if (seconds < 3600) magnitude = phrase(Math.floor(seconds / 60), 'minute');
  else if (seconds < 86_400) magnitude = phrase(Math.floor(seconds / 3600), 'hour');
  else magnitude = phrase(Math.floor(seconds / 86_400), 'day');

  if (magnitude === 'moment') return deltaMs < 0 ? 'in a moment' : 'just now';
  return deltaMs < 0 ? `in ${magnitude}` : `${magnitude} ago`;
}

/** `2026-09-15 18:02:11 UTC (3 hours ago)` - the form every timestamp takes. */
export function formatInstant(iso: string, now: number = Date.now()): string {
  return `${formatUtc(iso)} (${describeRelative(iso, now)})`;
}

/** Binary units, one decimal: what an operator reads off `free -h`. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit] as string}`;
}

export interface RenderAboutOptions {
  /** The clock the relative times are measured against. */
  now?: number | undefined;
}

/**
 * The human report: three blocks mirroring the web card, one aligned
 * `label   value` per fact. Written to STDERR by the command, because stdout
 * carries `--json` and nothing else (commands/deploy.ts's header).
 */
export function renderAbout(report: AboutReport, options: RenderAboutOptions = {}): string {
  const generated = Date.parse(report.generatedAt);
  const now = options.now ?? (Number.isNaN(generated) ? Date.now() : generated);
  const lines: string[] = [];

  const row = (label: string, value: string): void => {
    lines.push(`  ${label.padEnd(LABEL_WIDTH)}${value}\n`);
  };
  const block = (title: string): void => {
    lines.push(`\n  ${title}\n\n`);
  };

  // --- Application ---------------------------------------------------------
  block('Application');
  row('Name', report.deployment?.name ?? report.name);
  row('Version', report.deployment?.version ?? 'unknown');
  if (report.api === null) {
    row('API', `unavailable (${report.apiReason ?? 'unknown'})`);
  } else {
    const api = report.api;
    const { runtime, database } = api;
    row('API version', runtime.apiVersion);
    row('Environment', runtime.environment);
    row('Node', runtime.nodeVersion);
    row('Process started', formatInstant(runtime.processStartedAt, now));
    row('Server time', formatUtc(runtime.serverTimeUtc));
    if (database === null) {
      row('Database', `unavailable (${api.databaseError ?? 'unknown'})`);
    } else {
      row('Database', database.serverVersion.split(' ').slice(0, 2).join(' '));
      row(
        'Migrations',
        database.lastMigrationName === null
          ? `${database.appliedMigrations} applied`
          : `${database.appliedMigrations} applied, last ${database.lastMigrationName}`,
      );
    }
  }

  // --- Deployment ----------------------------------------------------------
  block('Deployment');
  if (report.deployment === null) {
    row('Record', `unavailable (${report.deploymentReason ?? 'unknown'})`);
    row('Root', report.deployRoot);
  } else {
    const deployment = report.deployment;
    row('Revision', `${deployment.commitSha.slice(0, 12)} (${deployment.ref})`);
    row('Repository', deployment.repoUrl);
    row('Domain', deployment.domain ?? 'not published');
    row('Port', String(deployment.bindPort));
    row('Installed', formatInstant(deployment.installedAt, now));
    row('Last updated', formatInstant(deployment.updatedAt, now));
    row('Last command', deployment.lastCommand);
    row('Deployed by', `${deployment.deployedBy.cli} ${deployment.deployedBy.version}`);
    if (deployment.lastAttemptAt !== null && deployment.lastAttemptAt > deployment.updatedAt) {
      row('Last attempt', `${formatInstant(deployment.lastAttemptAt, now)} - did not complete`);
    }
    if (deployment.previousSha !== null) {
      row('Previous revision', deployment.previousSha.slice(0, 12));
    }
    row('Root', deployment.deployRoot);
    if (deployment.envPath !== null) row('Environment file', deployment.envPath);
    if (deployment.proxyContainer !== null) row('Proxy container', deployment.proxyContainer);
  }

  if (report.remoteError !== null) {
    row('Update', `unavailable (${report.remoteError})`);
  } else if (report.remote === null) {
    row('Update', 'never checked');
  } else {
    const { commitsBehind, sha, checkedAt } = report.remote;
    row(
      'Update',
      commitsBehind === 0
        ? `up to date (${sha.slice(0, 12)})`
        : `${commitsBehind} commit${commitsBehind === 1 ? '' : 's'} behind (latest ${sha.slice(0, 12)})`,
    );
    row('Checked', formatInstant(checkedAt, now));
  }

  // --- Server --------------------------------------------------------------
  block('Server');
  const { deployed, now: live } = report.host;
  if (deployed === null && Object.keys(live).length === 0) {
    row('Facts', 'unavailable');
  } else {
    const plain = (value: string | number | null): string =>
      value === null ? 'unknown' : String(value);

    const fact = (
      label: string,
      key: (typeof HOST_KEYS)[number],
      format: (value: string | number | null) => string = plain,
    ): void => {
      const recorded: string | number | null | undefined =
        deployed === null ? undefined : deployed[key];
      const current: string | number | null | undefined = key in live ? (live[key] ?? null) : undefined;
      if (recorded === undefined) {
        row(label, current === undefined ? 'unknown' : format(current));
        return;
      }
      const base = format(recorded);
      row(label, current === undefined ? base : `${base}  (now ${format(current)})`);
    };

    fact('Hostname', 'hostname');
    fact('Operating system', 'os');
    fact('Kernel', 'kernel');
    fact('Architecture', 'arch');
    fact('CPU', 'cpuModel');
    fact('CPU cores', 'cpus');
    fact('Memory', 'memoryBytes', (value) => formatBytes(typeof value === 'number' ? value : null));
    fact('Disk', 'diskBytes', (value) => formatBytes(typeof value === 'number' ? value : null));
    fact('Docker', 'dockerVersion');
    fact('Compose', 'composeVersion');
    fact('Node', 'nodeVersion');
  }

  lines.push('\n');
  return lines.join('');
}
