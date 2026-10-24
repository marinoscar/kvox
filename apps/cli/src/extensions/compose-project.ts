import { chmodSync, copyFileSync, constants, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEPLOY_STATE_FILENAME } from '@marinoscar/platform-cli/deploy';
import { CLI_NAME } from '@app/shared';

import { resolveDeployment } from './deployment.js';
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  isPathUnder,
  runDocker,
  type DockerRunner,
} from './docker-ports.check.js';

// =============================================================================
// Which compose project does this deployment really run under?  (issue #736)
// =============================================================================
//
// The platform engine names the compose project of a deployment from its state
// file (`composeProject`) and, when that is absent, assumes the legacy `compose`.
// It then passes the name to every `docker compose -p <project>` call and to the
// deploy checks. A server installed by the pre-platform CLI ran compose with
// an app-named `-p` project and recorded nothing, so the engine looked for (and,
// worse, would START) a parallel stack under `compose` while the real one held
// the bind port: `bind-port-not-promised` failed on the deployment's own nginx.
//
// A recorded name is only a record. What Docker says is the ground truth: every
// container compose starts carries the directory it was run from
// (`com.docker.compose.project.working_dir`), and a deployment's stack is run
// from inside its own folder. So before `update|status|doctor|about` this
// reads that label off every container, and when the state file has no project
// (or the legacy default, which the engine may have written back during an
// earlier failed attempt) and Docker names exactly one other project for this
// folder, that project is written into the state file. A project that was
// recorded on purpose is never overwritten.
//
// PLATFORM-ADOPTION-SHIM(#736): removed when the platform engine derives the
// compose project from the running containers when none is recorded.
// =============================================================================

/** The project the engine assumes when the state file records none. Mirrors the platform's default. */
const LEGACY_COMPOSE_PROJECT = 'compose';

/** What Docker says about the compose project of a deployment folder. */
export type ComposeProjectDetection =
  | { kind: 'found'; project: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; projects: string[] }
  | { kind: 'unavailable' };

/**
 * One line per container: compose project, then compose working directory.
 *
 * `{{if .Config.Labels}}` guards a container created without any labels, whose
 * `Labels` is null rather than an empty map; the separator sits outside the
 * guards so every line has both fields.
 */
const INSPECT_FORMAT =
  `{{if .Config.Labels}}{{index .Config.Labels "${COMPOSE_PROJECT_LABEL}"}}{{end}}|` +
  `{{if .Config.Labels}}{{index .Config.Labels "${COMPOSE_WORKING_DIR_LABEL}"}}{{end}}`;

/**
 * Asks Docker which compose project(s) the containers started from inside
 * `deployRoot` belong to, stopped containers included.
 *
 * Never throws: a Docker that cannot be asked is `unavailable`.
 *
 * @param deployRoot - The deployment folder (`<apps-root>/<name>`).
 * @param run - The Docker seam; defaults to `docker` on the PATH.
 */
export async function detectComposeProject(
  deployRoot: string,
  run: DockerRunner = runDocker,
): Promise<ComposeProjectDetection> {
  try {
    // `-aq`: every container, whatever its state. Ids, which can never be ambiguous.
    const ids = (await run(['ps', '-aq']))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (ids.length === 0) return { kind: 'none' };

    // ONE inspect over every id, argv and never a shell string.
    const output = await run(['inspect', '--format', INSPECT_FORMAT, ...ids]);

    const projects = new Set<string>();
    for (const line of output.split('\n')) {
      const separator = line.indexOf('|');
      if (separator === -1) continue;
      const project = line.slice(0, separator).trim();
      const workingDir = line.slice(separator + 1).trim();
      if (project === '' || workingDir === '') continue;
      if (isPathUnder(workingDir, deployRoot)) projects.add(project);
    }

    const found = [...projects].sort();
    if (found.length === 0) return { kind: 'none' };
    if (found.length === 1 && found[0] !== undefined) return { kind: 'found', project: found[0] };
    return { kind: 'ambiguous', projects: found };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Parses the state file into a plain object, or undefined when it is missing or not one. */
function readState(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rewrites the state file with a new `composeProject`, keeping every other
 * field and the file's mode. A copy of the previous file is kept once, as
 * `<file>.bak` (mode 0600), so the change can be undone by hand.
 *
 * Written to a temporary file and renamed: a plain `writeFileSync` applies its
 * mode only when it creates the file, and a rename is atomic, so a reader never
 * sees half a file.
 */
function writeProject(path: string, state: Record<string, unknown>, project: string): void {
  const mode = statSync(path).mode & 0o777;
  const backup = `${path}.bak`;
  try {
    copyFileSync(path, backup, constants.COPYFILE_EXCL);
    chmodSync(backup, 0o600);
  } catch (error) {
    // An existing backup is the one from before the first change: keep it.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...state, composeProject: project }, null, 2)}\n`, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Makes the recorded compose project match the one Docker says the deployment
 * runs under, when the record is absent or the legacy default.
 *
 * Does nothing (returns undefined) when the state file is missing or unreadable,
 * when a project other than the legacy default is recorded, when Docker cannot
 * be asked or knows no container of this folder, or when it already agrees. An
 * ambiguous answer writes nothing and returns a warning that names the projects.
 *
 * @param deployRoot - The deployment folder.
 * @param run - The Docker seam; defaults to `docker` on the PATH.
 * @returns a one-line note for stderr, or undefined.
 */
export async function reconcileComposeProject(
  deployRoot: string,
  run: DockerRunner = runDocker,
): Promise<string | undefined> {
  const root = resolve(deployRoot);
  const path = join(root, DEPLOY_STATE_FILENAME);

  const state = readState(path);
  if (state === undefined) return undefined;

  const recorded = state['composeProject'];
  if (recorded !== undefined && recorded !== LEGACY_COMPOSE_PROJECT) return undefined;

  const detection = await detectComposeProject(root, run);
  const shown = typeof recorded === 'string' ? recorded : 'none';

  if (detection.kind === 'ambiguous') {
    // The engine's effective project is among them: its default works, nothing to say.
    if (detection.projects.includes(LEGACY_COMPOSE_PROJECT)) return undefined;
    return (
      `${CLI_NAME}: warning: containers of ${root} run under several compose projects ` +
      `(${detection.projects.join(', ')}); the state file records ${shown}, so the compose project was not changed. ` +
      `Set "composeProject" in ${path} to the right one.`
    );
  }

  if (detection.kind !== 'found' || detection.project === LEGACY_COMPOSE_PROJECT) return undefined;

  writeProject(path, state, detection.project);
  return (
    `${CLI_NAME}: note: recorded compose project ${detection.project} for ${root} ` +
    `(its containers run under it; the state file had ${shown}).`
  );
}

/** The `deploy` subcommands that run compose against an installed deployment and read its record. */
const RECONCILED_SUBCOMMANDS: ReadonlySet<string> = new Set(['update', 'status', 'doctor', 'about']);

/** The value of `--flag value` or `--flag=value` in `tokens`, if given. */
function optionValue(tokens: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === '--') return undefined;
    if (token === flag) return tokens[index + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * The pre-step of one invocation: reconciles the compose project of the
 * deployment the (already translated) arguments act on, for `deploy update`,
 * `status`, `doctor` and `about` only.
 *
 * Skipped for help and version, for `install` and `uninstall` (install decides
 * the project itself; uninstall must act on what is recorded), and for
 * `--dry-run`, which changes nothing. It must never make a command that worked
 * before fail, so a deployment that cannot be resolved (the platform command
 * will say so) and any error at all end in a skip.
 *
 * @param argv - The arguments after the executable name, after legacy translation.
 * @param cwd - The directory the shell stands in.
 * @param run - The Docker seam; defaults to `docker` on the PATH.
 * @returns a one-line note for stderr, or undefined.
 */
export async function reconcileForArgv(
  argv: readonly string[],
  cwd: string,
  run?: DockerRunner,
): Promise<string | undefined> {
  try {
    if (['-h', '--help', '-v', '--version', '--dry-run'].some((flag) => argv.includes(flag))) return undefined;

    const deployAt = argv.findIndex((token) => !token.startsWith('-'));
    if (deployAt === -1 || argv[deployAt] !== 'deploy') return undefined;
    const subAt = argv.findIndex((token, index) => index > deployAt && !token.startsWith('-'));
    const sub = subAt === -1 ? undefined : argv[subAt];
    if (sub === undefined || !RECONCILED_SUBCOMMANDS.has(sub)) return undefined;

    const options = argv.slice(subAt + 1);
    const deployment = resolveDeployment({
      root: optionValue(options, '--root'),
      name: optionValue(options, '--name'),
      appsRoot: optionValue(options, '--apps-root'),
      cwd,
    });
    return await reconcileComposeProject(deployment.deployRoot, run);
  } catch {
    return undefined;
  }
}
