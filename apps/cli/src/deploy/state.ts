import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { CliError, EXIT, type ExitCode } from '../errors.js';

// =============================================================================
// What is deployed here  (issue #173, epic #168)
// =============================================================================
//
// `update` has to answer three questions before it does anything: is anything
// installed, where, and at which commit. `status` needs the same. This file is
// where the answer lives.
//
// IT IS NOT IN ~/.kvox/config.json, AND THAT IS NOT A STYLE CHOICE.
// `writeConfigFile` copies an ALLOW-LIST of fields and drops everything else on
// every write (see config.ts). Deploy state placed there would survive until
// the next `kvox login` and then vanish, turning a working deployment into
// one the CLI believes was never installed. Its own file, next to the
// deployment it describes, also means the state travels with the server rather
// than with whichever operator's home directory happened to run the install.
// =============================================================================

/** Bumped only when a field changes meaning; unknown versions are refused. */
export const DEPLOY_STATE_VERSION = 1;

// THE FILENAME KEEPS THE OLD `appctl` NAME ON PURPOSE. The binary is called
// `kvox` now, but this file is READ BACK OFF LIVE SERVERS to discover what is
// deployed there. Rename it and every existing deployment becomes invisible:
// `deploy status` reports nothing and `deploy update` behaves as though it were
// a first install. There is deliberately no migration — see
// .claude/skills/rename-app/references/do-not-rename.md.
export const DEPLOY_STATE_FILENAME = '.appctl-deploy.json';

export interface DeployState {
  version: typeof DEPLOY_STATE_VERSION;
  /** Resolved from the checkout's own origin; never hardcoded. See #179. */
  repoUrl: string;
  /** Branch, tag or SHA that was requested. */
  ref: string;
  /** The commit actually deployed. */
  commitSha: string;
  /** Public hostname the shared proxy serves this under, if published. */
  domain?: string | undefined;
  /** Loopback port the proxy forwards to. */
  bindPort: number;
  deployRoot: string;
  /**
   * The app-folder layout (#119): `deployRoot` is `<appsRoot>/<name>`, and
   * `name` is also the compose project name, so the containers are
   * `<name>-api-1` and so on.
   *
   * ALL FOUR ARE OPTIONAL, AND `DEPLOY_STATE_VERSION` STAYS AT 1: a state file
   * written before #119 lacks them and still means exactly what it meant. A
   * reader falls back to the directory's own name (`projectNameFor`) and the
   * default proxy root rather than refusing the file.
   */
  name?: string | undefined;
  appsRoot?: string | undefined;
  /** The shared reverse proxy's directory, recorded so `update` need not derive it. */
  proxyRoot?: string | undefined;
  /** The proxy container's name, once a later child of #118 resolves it. */
  proxyContainer?: string | undefined;
  installedAt: string;
  lastDeployedAt: string;
  lastCommand: 'install' | 'update';
  /**
   * Which CLI version wrote this, for diagnosing a state file from the future.
   *
   * THE FIELD NAME KEEPS THE OLD `appctl` NAME ON PURPOSE, for the same reason
   * DEPLOY_STATE_FILENAME above does: it is serialized into
   * `.appctl-deploy.json` on live servers. `DEPLOY_STATE_VERSION` is bumped
   * only when a field CHANGES MEANING, so renaming a field would be an
   * unversioned wire break that no version check could catch. There is
   * deliberately no migration.
   */
  appctlVersion: string;
  /** The revision this replaced, for a manual roll-back. */
  previousSha?: string | undefined;
  /**
   * Step ids that completed, so `--resume` can skip them.
   *
   * A rerun after a fixed database password should not rebuild images.
   */
  completedSteps?: string[] | undefined;
}

/**
 * Nothing is installed at this path.
 *
 * EXIT.USAGE: the command was pointed somewhere it cannot work, and the remedy
 * is to run a different command. #178 introduces EXIT.PRECONDITION for a failed
 * doctor check, which is a different condition - the server is not ready, as
 * opposed to the operator asking for the wrong thing - and this deliberately
 * does not borrow it.
 */
export class NotInstalledError extends CliError {
  readonly exitCode: ExitCode = EXIT.USAGE;
}

/** The file exists but this build cannot safely interpret it. */
export class DeployStateError extends CliError {
  readonly exitCode: ExitCode = EXIT.FAILURE;
}

export function deployStatePath(deployRoot: string): string {
  return join(deployRoot, DEPLOY_STATE_FILENAME);
}

/** Returns undefined when nothing is installed; throws when it is unreadable. */
export function readState(deployRoot: string): DeployState | undefined {
  const path = deployStatePath(deployRoot);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new DeployStateError(
      `Cannot read ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DeployStateError(
      `${path} is not valid JSON. It may have been edited by hand or a previous run may have been interrupted.`,
      { cause: error },
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new DeployStateError(`${path} does not contain a deployment record.`);
  }

  const version = (parsed as { version?: unknown }).version;
  if (version !== DEPLOY_STATE_VERSION) {
    // Refused rather than guessed. Misreading a state file means updating the
    // wrong checkout or reporting the wrong commit as deployed, and a newer
    // a newer CLI having written it is the likeliest cause.
    throw new DeployStateError(
      `${path} has state version ${String(version)}, but this ${CLI_NAME} understands ${DEPLOY_STATE_VERSION}. Upgrade ${CLI_NAME}, or remove the file to re-install.`,
    );
  }

  return parsed as DeployState;
}

/** Reads the state, or explains that there is nothing here to act on. */
export function requireState(deployRoot: string): DeployState {
  const state = readState(deployRoot);
  if (state === undefined) {
    throw new NotInstalledError(
      `No deployment found at ${deployRoot}. Run \`${CLI_NAME} deploy install\` first, or pass --root if it is somewhere else.`,
    );
  }
  return state;
}

/**
 * Writes the state atomically, 0600.
 *
 * The temp-file-then-rename dance is copied from `writeConfigFile`, whose long
 * comment explains why: a plain `writeFileSync(path, data, { mode })` applies
 * the mode ONLY when it creates the file, so rewriting an existing one silently
 * keeps whatever permissions it already had. `flag: 'wx'` makes the temp file's
 * creation - and therefore its mode - unambiguous, and the rename is atomic, so
 * an interrupted write cannot leave a half-written state file behind.
 */
export function writeState(state: DeployState): string {
  const path = deployStatePath(state.deployRoot);
  const temporary = `${path}.${process.pid}.tmp`;

  mkdirSync(state.deployRoot, { recursive: true });

  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new DeployStateError(
      `Cannot write ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  return path;
}
