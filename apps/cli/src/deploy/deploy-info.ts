import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { CliError, EXIT, type ExitCode } from '../errors.js';
import { CLI_VERSION } from '../package-info.js';
import { projectNameFor } from './layout.js';
import type { ServerFacts } from './server-facts.js';
import type { DeployState } from './state.js';

// =============================================================================
// deploy-info: what is deployed here, for the application to read
// =============================================================================
// (issue #120, epic #118)
//
// The state file (state.ts) already knows the commit, the ref and the
// timestamps - but it is the CLI's PRIVATE 0600 file: it carries
// `completedSteps`, it is refused on a version mismatch, and it is never
// mounted anywhere. The About page (#124, #126, #128) needs a document the
// running API can read, so this is a SECOND file, non-secret by construction:
//
//   <root>/deploy-info/info.json        0644
//
// A DIRECTORY IS MOUNTED, NOT THE FILE. vps.compose.yml binds
// `<root>/deploy-info` read-only at `/app/deploy-info`. A single-file bind
// mount would break on the first atomic rewrite: rename replaces the inode,
// and the container would keep reading the old one forever. Environment
// variables were rejected too - they are read once at container start, and
// `updatedAt` is only known after `verify`.
//
// `schema` is this file's own version, independent of DEPLOY_STATE_VERSION.
// Every timestamp is ISO-8601 UTC with a `Z` suffix: `toISOString()`, never a
// local-time format, so the web console, the TUI and the CLI all show the
// same instant.
//
// The write is a plain temp-then-rename: the reader tolerates a torn read,
// and the file is 0644 on purpose - never the state file's 0600, because
// nothing in it is secret and the API container's user has to read it.
// =============================================================================

export const DEPLOY_INFO_DIRNAME = 'deploy-info';
export const DEPLOY_INFO_FILENAME = 'info.json';
export const DEPLOY_INFO_SCHEMA = 1;

export interface DeployRemote {
  /** The latest commit on the deployed ref, as last checked. */
  sha: string;
  commitsBehind: number;
  checkedAt: string;
}

export interface DeployInfo {
  schema: typeof DEPLOY_INFO_SCHEMA;
  app: {
    /** The app folder and compose project name. */
    name: string;
    /** apps/api/package.json's version in the deployed clone. */
    version: string | null;
    commitSha: string;
    ref: string;
    repoUrl: string;
  };
  installedAt: string;
  /** When the last deploy succeeded; equals `installedAt` on a first install. */
  updatedAt: string;
  lastCommand: 'install' | 'update';
  deployedBy: { cli: string; version: string };
  domain: string | null;
  bindPort: number;
  host: ServerFacts;
  /** Filled by `update --check` (#123); null until then. */
  remote: DeployRemote | null;
}

/** The file exists but is not a deploy-info document this build understands. */
export class DeployInfoError extends CliError {
  readonly exitCode: ExitCode = EXIT.FAILURE;
}

export function deployInfoDir(deployRoot: string): string {
  return join(deployRoot, DEPLOY_INFO_DIRNAME);
}

export function deployInfoPath(deployRoot: string): string {
  return join(deployInfoDir(deployRoot), DEPLOY_INFO_FILENAME);
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** True for an ISO-8601 instant in UTC with a `Z` suffix, and nothing else. */
export function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
  );
}

const HOST_STRING_KEYS = [
  'hostname',
  'os',
  'kernel',
  'arch',
  'cpuModel',
  'dockerVersion',
  'composeVersion',
  'nodeVersion',
] as const;
const HOST_NUMBER_KEYS = ['cpus', 'memoryBytes', 'diskBytes'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function nullableNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Checks a parsed document against the schema, naming the first field that
 * is wrong. Used on read (a hand-edited file) and on write (a bug here), so
 * the API never receives a document this module would not accept itself.
 */
export function validateDeployInfo(value: unknown): DeployInfo {
  const fail = (what: string): never => {
    throw new DeployInfoError(`deploy-info is not valid: ${what}`);
  };

  if (!isRecord(value)) return fail('not an object');
  if (value['schema'] !== DEPLOY_INFO_SCHEMA) {
    return fail(`schema ${String(value['schema'])}, expected ${DEPLOY_INFO_SCHEMA}`);
  }

  const app = value['app'];
  if (!isRecord(app)) return fail('app is not an object');
  for (const key of ['name', 'commitSha', 'ref', 'repoUrl'] as const) {
    if (typeof app[key] !== 'string') return fail(`app.${key} is not a string`);
  }
  if (!nullableString(app['version'])) return fail('app.version is not a string or null');

  for (const key of ['installedAt', 'updatedAt'] as const) {
    if (!isUtcTimestamp(value[key])) return fail(`${key} is not a UTC timestamp`);
  }
  if (value['lastCommand'] !== 'install' && value['lastCommand'] !== 'update') {
    return fail('lastCommand is not install or update');
  }

  const deployedBy = value['deployedBy'];
  if (
    !isRecord(deployedBy) ||
    typeof deployedBy['cli'] !== 'string' ||
    typeof deployedBy['version'] !== 'string'
  ) {
    return fail('deployedBy is not { cli, version }');
  }

  if (!nullableString(value['domain'])) return fail('domain is not a string or null');
  if (typeof value['bindPort'] !== 'number' || !Number.isInteger(value['bindPort'])) {
    return fail('bindPort is not an integer');
  }

  const host = value['host'];
  if (!isRecord(host)) return fail('host is not an object');
  for (const key of HOST_STRING_KEYS) {
    if (!nullableString(host[key])) return fail(`host.${key} is not a string or null`);
  }
  for (const key of HOST_NUMBER_KEYS) {
    if (!nullableNumber(host[key])) return fail(`host.${key} is not a number or null`);
  }

  const remote = value['remote'];
  if (remote !== null) {
    if (
      !isRecord(remote) ||
      typeof remote['sha'] !== 'string' ||
      typeof remote['commitsBehind'] !== 'number' ||
      !isUtcTimestamp(remote['checkedAt'])
    ) {
      return fail('remote is not null or { sha, commitsBehind, checkedAt }');
    }
  }

  return value as unknown as DeployInfo;
}

/** Returns undefined when there is no file; throws when it is unusable. */
export function readDeployInfo(deployRoot: string): DeployInfo | undefined {
  const path = deployInfoPath(deployRoot);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DeployInfoError(`Cannot read ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DeployInfoError(`${path} is not valid JSON.`, { cause: error });
  }

  return validateDeployInfo(parsed);
}

/**
 * The deployed application's own version: `apps/api/package.json` in the
 * clone. Null when it cannot be read - a fork that moved the API, a clone
 * that is mid-checkout - never a throw; it is one cell on the About page.
 */
export function readDeployedAppVersion(deployRoot: string): string | null {
  try {
    const raw = readFileSync(join(deployRoot, 'repo', 'apps', 'api', 'package.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}

export interface DeployInfoExtras {
  /** Defaults to the clone's apps/api/package.json version. */
  appVersion?: string | null | undefined;
  /** Defaults to null; `update --check` (#123) supplies it. */
  remote?: DeployRemote | null | undefined;
}

/** The document for a state, with the facts read now. Pure. */
export function buildDeployInfo(
  deployRoot: string,
  state: DeployState,
  facts: ServerFacts,
  extras: DeployInfoExtras = {},
): DeployInfo {
  return {
    schema: DEPLOY_INFO_SCHEMA,
    app: {
      name: projectNameFor(state, deployRoot),
      version: extras.appVersion === undefined ? readDeployedAppVersion(deployRoot) : extras.appVersion,
      commitSha: state.commitSha,
      ref: state.ref,
      repoUrl: state.repoUrl,
    },
    installedAt: state.installedAt,
    updatedAt: state.lastDeployedAt,
    lastCommand: state.lastCommand,
    deployedBy: { cli: CLI_NAME, version: CLI_VERSION },
    domain: state.domain ?? null,
    bindPort: state.bindPort,
    host: facts,
    remote: extras.remote ?? null,
  };
}

/**
 * Writes `<root>/deploy-info/info.json`, 0644, temp-then-rename INSIDE the
 * directory - the mount is the directory, so the rename lands where the
 * container is already looking. Validated before it is written: a document
 * this module would refuse to read must never reach the API.
 */
export function writeDeployInfo(
  deployRoot: string,
  state: DeployState,
  facts: ServerFacts,
  extras: DeployInfoExtras = {},
): string {
  return writeDeployInfoDocument(deployRoot, buildDeployInfo(deployRoot, state, facts, extras));
}

/**
 * Replaces `remote` in an existing info.json and nothing else (#123).
 *
 * `update --check` and `status` refresh how far behind the deployment is
 * without deploying anything, so the rest of the document - the deployed
 * commit, the timestamps, the host facts captured at deploy time - is kept
 * exactly as the last deploy wrote it rather than rebuilt from a state that
 * has not changed. Undefined when there is no file: a deployment from before
 * #120 has nothing to patch, and a check is not the moment to invent one.
 */
export function updateDeployInfoRemote(
  deployRoot: string,
  remote: DeployRemote,
): string | undefined {
  const existing = readDeployInfo(deployRoot);
  if (existing === undefined) return undefined;
  return writeDeployInfoDocument(deployRoot, { ...existing, remote });
}

function writeDeployInfoDocument(deployRoot: string, document: DeployInfo): string {
  const info = validateDeployInfo(document);
  const dir = deployInfoDir(deployRoot);
  const path = deployInfoPath(deployRoot);
  const temporary = `${path}.${process.pid}.tmp`;

  // World-readable and world-traversable on purpose: the api container's
  // unprivileged user reads through this directory, and nothing in it is
  // secret. `recursive` also makes an existing 0700 directory a no-op, so the
  // mode is set explicitly below rather than trusted.
  mkdirSync(dir, { recursive: true, mode: 0o755 });

  try {
    writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new DeployInfoError(`Cannot write ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  return path;
}
