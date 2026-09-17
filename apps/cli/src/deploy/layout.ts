import { readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { UsageError } from '../errors.js';
import { envFacts, isDeployment } from './deployment-evidence.js';
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
//   (nothing)             install: the deployment cwd is standing in (#266),
//                         else the repository's own name; everything else:
//                         the one app already installed under <apps-root>
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
 * Every app deployed under `appsRoot`: each direct subdirectory that is a
 * deployment. A missing apps root means nothing is installed, not an error.
 *
 * A SUBDIRECTORY IS A DEPLOYMENT IF IT HOLDS A STATE FILE **OR** PASSES THE
 * EVIDENCE GATE (#285). It used to be the state file alone, which is the same
 * defect `requireState` had one level down: a server whose bookkeeping was
 * lost was invisible here, so a bare `deploy update` with no `--name`/`--root`
 * answered "Nothing is installed under <apps-root>" and never reached the
 * adoption path that exists to recover exactly that. The gate is the one in `deployment-evidence.ts`,
 * shared with `adopt.ts` rather than restated, so discovery and adoption can
 * never disagree about what a deployment is.
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
    const deployRoot = join(appsRoot, name);
    // An unreadable or foreign-version state file is reported by whichever
    // command then acts on it; a listing must not refuse to answer because
    // of a neighbouring app. It is also NOT then treated as an unrecorded
    // deployment: the file is there and this build cannot interpret it, which
    // is a different problem from there being no file, and the command that
    // acts on it raises the difference properly.
    let state: DeployState | undefined;
    let unreadable = false;
    try {
      state = readState(deployRoot);
    } catch {
      unreadable = true;
    }
    if (unreadable) continue;

    if (state !== undefined) {
      apps.push({ name: state.name ?? name, deployRoot, state, bindPort: state.bindPort });
      continue;
    }

    // No record, but the deployment may still be here (#285).
    if (!isDeployment(deployRoot)) continue;
    const facts = envFacts(deployRoot);
    apps.push({
      name: facts.composeProjectName ?? name,
      deployRoot,
      ...(facts.bindPort === undefined ? {} : { bindPort: facts.bindPort }),
    });
  }
  return apps;
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
  const appsRoot = resolve(options.appsRoot);
  let current = resolve(options.cwd);

  for (;;) {
    // The apps root itself is the bound, not a candidate: it holds no state
    // file of its own, and anything above it is not ours to interpret.
    if (current === appsRoot || !contains(appsRoot, current)) return undefined;

    const state = readStateQuietly(current);
    if (state !== undefined) {
      return {
        layout: {
          name: projectNameFor(state, current),
          appsRoot: options.appsRoot,
          deployRoot: current,
        },
        state,
      };
    }

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
 * With several apps installed and no `--name`, this refuses and names them:
 * guessing would mean updating, or reporting on, the wrong one.
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

  const installed = listInstalledApps(options.appsRoot);
  if (installed.length === 0) return undefined;
  if (installed.length > 1) {
    throw new UsageError(
      `Several apps are installed under ${options.appsRoot}: ${installed
        .map((app) => app.name)
        .join(', ')}. Pass --name <app> to say which one.`,
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
