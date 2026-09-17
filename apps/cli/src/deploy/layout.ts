import { readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { UsageError } from '../errors.js';
import { envFacts, envWrittenByThisCli, isDeployment } from './deployment-evidence.js';
import { contains } from './repo.js';
import { NotInstalledError, readState, type DeployState } from './state.js';

// =============================================================================
// Where an app lives on the server  (issue #119, epic #118)
// =============================================================================
//
// The target server follows "one app = one folder": every application deployed
// from this template gets its own directory under one shared apps root,
//
//   /opt/infra/apps/<name>/
//     repo/                 the CLI's own clone
//     logs/                 the journal
//     data/                 bind-mounted persistent data
//     deploy-info/          info.json, bind-mounted read-only into the API (#120)
//     .env                  the environment, 0600; linked from repo/infra/compose (#120)
//     .appctl-deploy.json   the state file
//
// and `<name>` doubles as the docker compose PROJECT name, so the containers
// are `<name>-api-1`, `<name>-nginx-1`, ... Before this module the deploy root
// defaulted to the apps root ITSELF, every app on a box was the compose project
// `compose`, and a second app's `up -d` replaced the first's containers. The
// name is therefore not cosmetic: it is what keeps two apps on one host apart.
//
// Three ways to say where the app is, in order of precedence:
//
//   --root <dir>          the full path, verbatim - the escape hatch
//   --name <app>          <apps-root>/<name>
//   (nothing)             the deployment cwd is standing in (#266, generalised
//                         to every command by #290), then: install, the
//                         repository's own name; everything else, the one app
//                         already installed under <apps-root>
// =============================================================================

/**
 * The name used when no repository has been resolved to derive one from.
 *
 * Exported rather than inlined so a caller can RECOGNISE it: a deploy root of
 * `<apps-root>/app` may be a real app called "app", or it may be the CLI
 * admitting it does not yet know what it is deploying, and the TUI has to tell
 * an operator which (#232).
 */
export const FALLBACK_APP_NAME = 'app';

export const DEFAULT_APPS_ROOT = '/opt/infra/apps';
export const DEFAULT_PROXY_ROOT = '/opt/infra/proxy';
export const DEFAULT_BIND_PORT = 3535;

/**
 * The app name a repository URL implies: its last path segment, lower-cased,
 * minus `.git`. `https://example.test/o/MyApp.git` deploys as `myapp`.
 */
export function appNameFor(repoUrl: string): string {
  const name = basename(repoUrl.trim().replace(/\/+$/, '')).replace(/\.git$/, '');
  return (name || FALLBACK_APP_NAME).toLowerCase();
}

export function appRootFor(appsRoot: string, name: string): string {
  return join(appsRoot, name);
}

/**
 * The compose project name for a deployment.
 *
 * Recorded in the state file since #119; a state written before that has no
 * `name`, and the directory's own name is the best available answer for it.
 */
export function projectNameFor(
  state: Pick<DeployState, 'name'> | undefined,
  deployRoot: string,
): string {
  return state?.name ?? basename(deployRoot);
}

export interface InstalledApp {
  name: string;
  deployRoot: string;
  /**
   * The state file, when there is one.
   *
   * UNDEFINED FOR A DEPLOYMENT RECOGNISED BY ITS OWN EVIDENCE (#285). A caller
   * that genuinely needs the record - not merely the deployment - must test
   * for it rather than assume it, and `lastRenewalCronWarning` in
   * `uninstall.ts` is the one that does.
   */
  state?: DeployState | undefined;
  /**
   * The loopback port it holds: the state's, else the `.env`'s
   * `APP_BIND_PORT`. Undefined when neither says - never a default, because
   * the one caller that reads it is telling the install wizard which ports are
   * taken, and inventing one there is worse than saying nothing.
   */
  bindPort?: number | undefined;
}

/**
 * Every app deployed under `appsRoot`: each direct subdirectory that is one
 * of this CLI's deployments. A missing apps root means nothing is installed,
 * not an error.
 *
 * WHAT COUNTS IS `recogniseDeployment` BELOW, and it is the same predicate the
 * cwd rank walks with, so discovery-by-enumeration and discovery-by-cwd cannot
 * disagree about what is here (#290).
 *
 * AMBIGUITY IS NOT RESOLVED HERE AND IS NOT RESOLVED DIFFERENTLY. This returns
 * everything it finds, in directory order; `locateApp` below refuses when
 * there is more than one and names them, exactly as it always has. A
 * state-bearing directory is deliberately NOT preferred over an
 * evidence-bearing one - that would be a tiebreak this command has never had,
 * invented at the moment an operator most needs to be asked which they meant.
 */
export function listInstalledApps(appsRoot: string): InstalledApp[] {
  let entries: string[];
  try {
    entries = readdirSync(appsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const apps: InstalledApp[] = [];
  for (const name of entries) {
    const app = recogniseDeployment(join(appsRoot, name));
    if (app !== undefined) apps.push(app);
  }
  return apps;
}

/**
 * The one deployment at `deployRoot`, or undefined - THE predicate discovery
 * uses, wherever discovery happens (#290).
 *
 * A DIRECTORY IS ONE OF THIS CLI'S DEPLOYMENTS IF IT HOLDS A STATE FILE, **OR**
 * PASSES THE EVIDENCE GATE AND ITS `.env` WAS WRITTEN BY THIS CLI. The first
 * half is #285's: keying on the state file alone is the same defect
 * `requireState` had one level down, so a server whose bookkeeping was lost was
 * invisible here and a bare `deploy update` answered "Nothing is installed"
 * rather than reaching the adoption path that exists to recover exactly that.
 *
 * The second half is #290's, and it is a NARROWING of the evidence half only.
 * The gate in `deployment-evidence.ts` is shared with `adopt.ts` so discovery
 * and adoption can never disagree about what a deployment IS; but enumeration
 * asks a further question that adoption never has to - "is this one of mine?" -
 * because it reads directories nobody named. On a host running several
 * applications under one apps root, a stranger's `repo/` + `.env` passes the
 * gate and gets named in an ambiguity refusal about this CLI's deployments.
 * `envWrittenByThisCli` is that second, explicitly separate predicate; the
 * shared gate is untouched, and `--root`/`--name`/adoption do not consult it.
 *
 * AN UNREADABLE OR FOREIGN-VERSION STATE FILE ANSWERS UNDEFINED, and is NOT
 * then treated as an unrecorded deployment: the file is there and this build
 * cannot interpret it, which is a different problem from there being no file,
 * and the command that acts on the deployment raises the difference properly.
 * A listing must also not refuse to answer because of a neighbouring app.
 */
export function recogniseDeployment(deployRoot: string): InstalledApp | undefined {
  let state: DeployState | undefined;
  try {
    state = readState(deployRoot);
  } catch {
    return undefined;
  }

  if (state !== undefined) {
    return {
      name: projectNameFor(state, deployRoot),
      deployRoot,
      state,
      bindPort: state.bindPort,
    };
  }

  if (!isDeployment(deployRoot) || !envWrittenByThisCli(deployRoot)) return undefined;

  const facts = envFacts(deployRoot);
  return {
    name: facts.composeProjectName ?? basename(deployRoot),
    deployRoot,
    ...(facts.bindPort === undefined ? {} : { bindPort: facts.bindPort }),
  };
}

export interface DeploymentAtCwd {
  layout: ResolvedLayout;
  /** The state file that identified it; the caller reads the repo off this. */
  state: DeployState;
}

/**
 * The deployment the current directory is standing in  (issue #266).
 *
 * Walks up from `cwd` looking for a state file, and stops at the apps root.
 * `<apps-root>/<app>` and `<apps-root>/<app>/repo/infra/compose` both answer
 * that deployment; the apps root itself, and anything above it, answer
 * nothing.
 *
 * THIS IS A RANK, NOT A SEARCH. It reads the one deployment cwd implies, and
 * never `readdirSync`s the apps root for candidates - #249 rejected that
 * explicitly, and guessing harder is the wrong answer to a bug caused by
 * guessing. Exactly one deployment is implied by a directory, or none, and
 * none still refuses exactly as it did before.
 *
 * WHY IT STOPS AT THE APPS ROOT. Without a bound the walk leaves the
 * territory this module knows about: `/opt/infra`, `/opt`, `/`, each of them
 * somebody else's directory, none of them a deployment. The apps root is the
 * outermost directory that can contain one, so it is where the walk ends -
 * and a deploy root installed OUTSIDE the apps root with `--root` is
 * deliberately not found this way, because there is no bound that would find
 * it without also walking the whole filesystem.
 *
 * A state file that cannot be read (hand-edited, or written by a newer CLI)
 * is skipped rather than raised, the same posture `listInstalledApps` and
 * `locateApp` already take: a listing must not refuse because of one
 * unreadable file, and the command that goes on to act on the deployment
 * reports it properly.
 */
export function locateAppFromCwd(options: {
  appsRoot: string;
  cwd: string;
}): DeploymentAtCwd | undefined {
  return walkFromCwd(options, (current) => {
    const state = readStateQuietly(current);
    if (state === undefined) return undefined;
    return {
      layout: {
        name: projectNameFor(state, current),
        appsRoot: options.appsRoot,
        deployRoot: current,
      },
      state,
    };
  });
}

/**
 * The deployment cwd is standing in, recognised the way DISCOVERY recognises
 * one  (issue #290).
 *
 * The same walk and the same bounds as `locateAppFromCwd` above, over
 * `recogniseDeployment` instead of a state file - which is what makes it
 * answer about a deployment whose bookkeeping was lost (#285), the case that
 * sent the operator here in the first place, and what keeps it agreeing with
 * `listInstalledApps` about what is out there.
 *
 * WHY IT IS A SECOND FUNCTION AND `locateAppFromCwd` WAS NOT WIDENED.
 * `install` reads the state file this rank finds - it needs the repository,
 * the ref and the name off a record this CLI wrote, and feeds it through
 * `resolveRepoTarget`'s own `state` rank. A deployment with no record has
 * none of that to give, so widening install's rank would change what install
 * DEPLOYS, which is a different question from which deployment a command is
 * being pointed at (`docs/specs/vps-deploy.md` §23.7 says so outright).
 * Install therefore keeps the stricter rank, and a directory that is a
 * deployment with no state file falls through it exactly as it did before.
 */
export function deploymentAtCwd(options: {
  appsRoot: string;
  cwd: string;
}): InstalledApp | undefined {
  return walkFromCwd(options, recogniseDeployment);
}

/**
 * The walk both ranks above share: from `cwd` up to - but never including -
 * the apps root, asking `recognise` about each directory on the way.
 *
 * One implementation so the bound, the nearest-wins order and the
 * stop-at-the-root rule cannot drift between the two callers.
 */
function walkFromCwd<T>(
  options: { appsRoot: string; cwd: string },
  recognise: (directory: string) => T | undefined,
): T | undefined {
  const appsRoot = resolve(options.appsRoot);
  let current = resolve(options.cwd);

  for (;;) {
    // The apps root itself is the bound, not a candidate: it holds no
    // deployment of its own, and anything above it is not ours to interpret.
    if (current === appsRoot || !contains(appsRoot, current)) return undefined;

    const found = recognise(current);
    if (found !== undefined) return found;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** A port another app under the apps root has recorded as its own. */
export interface SiblingPort {
  /** The app's name, for the wizard's "3535 is used by <name>" reason. */
  name: string;
  port: number;
}

/**
 * The bind port of every OTHER app installed under `appsRoot` (#127).
 *
 * Read from what each sibling records - its state file, or its own `.env`
 * when it has no state file (#285) - never from what is listening: a STOPPED
 * app is invisible to a bind probe, and the wizard must never suggest a port
 * that app will take back the moment it is started. The app at `deployRoot` is
 * left out so a reinstall does not see its own port as taken.
 */
export function siblingBindPorts(appsRoot: string, deployRoot?: string): SiblingPort[] {
  return listInstalledApps(appsRoot)
    .filter((app) => app.deployRoot !== deployRoot)
    // A deployment with no state file counts (#285) - that port is held
    // whether or not this CLI has a record of who holds it, which is #257's
    // point exactly. One whose port cannot be read claims NONE rather than the
    // default: telling the wizard 3535 is taken when nothing on that disk says
    // so would cost a free port on every install.
    .flatMap((app) =>
      app.bindPort === undefined ? [] : [{ name: app.name, port: app.bindPort }],
    );
}

export interface LocateOptions {
  appsRoot: string;
  name?: string | undefined;
  /** Explicit full path; wins over everything else. */
  root?: string | undefined;
  /**
   * Where the operator is standing; `process.cwd()` when not given (#290).
   *
   * A parameter rather than a read buried in the rank, so a test - and a
   * caller with a cwd of its own - can say where "here" is.
   */
  cwd?: string | undefined;
}

export interface ResolvedLayout {
  name: string;
  appsRoot: string;
  deployRoot: string;
}

/**
 * Turns `--apps-root`/`--name`/`--root` into one directory and one project
 * name, WITHOUT requiring anything to be installed there. Returns undefined
 * when nothing was named and nothing is installed - the caller decides
 * whether that is an error (`update`) or the ordinary pre-install case
 * (`doctor`).
 *
 * FOUR RANKS, MOST EXPLICIT FIRST (#290):
 *
 *   1. `--root` - a path, verbatim.
 *   2. `--name` - a name under the apps root. It still outranks cwd, so
 *      `--name vault` from inside another app's directory means vault.
 *   3. THE DEPLOYMENT cwd IS STANDING IN. #266 made this a rank for
 *      `install` alone; every other command funnels through here and could
 *      not see cwd, so an operator standing in `<apps-root>/<app>` on a host
 *      with several apps was asked which app they meant. It lands BEFORE the
 *      refusal below, which is the whole point.
 *   4. The one app installed under the apps root.
 *
 * With several apps installed, none named, and cwd standing in none of them,
 * this still refuses and names them: guessing would mean updating, or
 * reporting on, the wrong one.
 */
export function locateApp(options: LocateOptions): ResolvedLayout | undefined {
  if (options.root !== undefined) {
    const name = options.name ?? projectNameFor(readStateQuietly(options.root), options.root);
    return { name, appsRoot: options.appsRoot, deployRoot: options.root };
  }

  if (options.name !== undefined) {
    return {
      name: options.name,
      appsRoot: options.appsRoot,
      deployRoot: appRootFor(options.appsRoot, options.name),
    };
  }

  // Rank 3. Before the listing, not after: it is the answer that makes the
  // refusal below unnecessary, and it is also the cheaper read - one walk up
  // a handful of directories rather than a `readdirSync` of the apps root.
  const cwd = options.cwd ?? currentDirectory();
  const here = cwd === undefined ? undefined : deploymentAtCwd({ appsRoot: options.appsRoot, cwd });
  if (here !== undefined) {
    return { name: here.name, appsRoot: options.appsRoot, deployRoot: here.deployRoot };
  }

  const installed = listInstalledApps(options.appsRoot);
  if (installed.length === 0) return undefined;
  if (installed.length > 1) {
    throw new UsageError(
      `Several apps are installed under ${options.appsRoot}: ${installed
        .map((app) => app.name)
        .join(', ')}. Pass --name <app> to say which one, or run this from inside that app's own directory.`,
    );
  }

  const [only] = installed as [InstalledApp];
  return { name: only.name, appsRoot: options.appsRoot, deployRoot: only.deployRoot };
}

/** `locateApp` for a command that cannot work without an installed app. */
export function locateInstalledApp(options: LocateOptions): ResolvedLayout {
  const located = locateApp(options);
  if (located === undefined) {
    throw new NotInstalledError(
      `Nothing is installed under ${options.appsRoot}. Run \`${CLI_NAME} deploy install\` first, or pass --apps-root or --root if it is somewhere else.`,
    );
  }
  return located;
}

function readStateQuietly(deployRoot: string): DeployState | undefined {
  try {
    return readState(deployRoot);
  } catch {
    return undefined;
  }
}

/**
 * `process.cwd()`, or undefined when there is none to read.
 *
 * It throws when the directory the process was started in has since been
 * removed - `deploy uninstall` leaves exactly that state behind for a shell
 * still sitting in the deleted deploy root - and a rank that is only ever a
 * hint must not be what turns that into a crash. Undefined simply skips the
 * rank, so the ranks below answer exactly as they did before this one
 * existed.
 */
function currentDirectory(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}
