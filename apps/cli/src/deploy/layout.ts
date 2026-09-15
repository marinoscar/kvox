import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { UsageError } from '../errors.js';
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
//   (nothing)             install: the repository's own name; everything else:
//                         the one app already installed under <apps-root>
// =============================================================================

export const DEFAULT_APPS_ROOT = '/opt/infra/apps';
export const DEFAULT_PROXY_ROOT = '/opt/infra/proxy';
export const DEFAULT_BIND_PORT = 3535;

/**
 * The app name a repository URL implies: its last path segment, lower-cased,
 * minus `.git`. `https://example.test/o/MyApp.git` deploys as `myapp`.
 */
export function appNameFor(repoUrl: string): string {
  const name = basename(repoUrl.trim().replace(/\/+$/, '')).replace(/\.git$/, '');
  return (name || 'app').toLowerCase();
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
  state: DeployState;
}

/**
 * Every app installed under `appsRoot`: each direct subdirectory holding a
 * state file. A missing apps root means nothing is installed, not an error.
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
    // of a neighbouring app.
    let state: DeployState | undefined;
    try {
      state = readState(deployRoot);
    } catch {
      continue;
    }
    if (state !== undefined) apps.push({ name: state.name ?? name, deployRoot, state });
  }
  return apps;
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
