import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

// =============================================================================
// Which deployment does a legacy command mean?  (issue #482, epic #478)
// =============================================================================
//
// The platform CLI resolves the deployment a `deploy` command acts on with five
// ranks (`--root`, `--name`, the directory the shell stands in, the sole
// installed deployment, refuse). That resolver is internal to the platform
// package, and the two extensions here (the `uninstall --confirm` guard and
// `update --check`) have to know the same answer BEFORE the platform's command
// runs, so this module restates the ranks. It is deliberately the same order and
// the same refusal on ambiguity: when it cannot be sure which deployment is
// meant, it says so instead of choosing, because one of its callers gates a
// destructive command.
//
// PLATFORM-ADOPTION-SHIM(#482): a copy of an internal of the platform package;
// removed when the package exports its resolver (`locateApp`).
//
// What counts as a deployment is the platform's rule (a git checkout and an
// environment file), never "has the state file": a server deployed by an older
// CLI without a record is still a deployment.
// =============================================================================

/** The apps root every `deploy` command defaults to. Mirrors the platform's default. */
export const DEFAULT_APPS_ROOT = '/opt/infra/apps';

/** The deployment-selecting options of a `deploy` command. */
export interface DeploymentSelector {
  root?: string | undefined;
  name?: string | undefined;
  appsRoot?: string | undefined;
  cwd: string;
}

/** A resolved deployment. */
export interface ResolvedDeployment {
  name: string;
  deployRoot: string;
  appsRoot: string;
}

/** Why a deployment could not be resolved; the message names the way out. */
export class DeploymentResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentResolutionError';
  }
}

/**
 * The platform's predicate, restated: a git checkout AND a readable environment
 * file (current location, or the one inside the checkout that older CLIs used).
 * The state file is deliberately not part of it: a server deployed before any
 * record was written is still a deployment.
 */
function isDeployment(dir: string): boolean {
  const hasCheckout = existsSync(join(dir, 'repo', '.git'));
  const hasEnv = isFile(join(dir, '.env')) || isFile(join(dir, 'repo', 'infra', 'compose', '.env'));
  return hasCheckout && hasEnv;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listDeployments(appsRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(appsRoot);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => {
      const dir = join(appsRoot, entry);
      try {
        return statSync(dir).isDirectory() && isDeployment(dir);
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Resolves the deployment in the platform's rank order.
 *
 * @throws DeploymentResolutionError when none is installed or several are and
 *   nothing says which.
 */
export function resolveDeployment(selector: DeploymentSelector): ResolvedDeployment {
  const appsRoot = resolve(selector.appsRoot ?? DEFAULT_APPS_ROOT);

  if (selector.root !== undefined) {
    const deployRoot = resolve(selector.cwd, selector.root);
    return {
      name: basename(deployRoot),
      deployRoot,
      appsRoot: isAbsolute(selector.root) ? resolve(deployRoot, '..') : appsRoot,
    };
  }

  if (selector.name !== undefined) {
    return { name: selector.name, deployRoot: join(appsRoot, selector.name), appsRoot };
  }

  // Standing inside a deployment: the first path segment under the apps root.
  const inside = relative(appsRoot, resolve(selector.cwd));
  if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
    const first = inside.split(sep)[0];
    if (first !== undefined && first !== '' && isDeployment(join(appsRoot, first))) {
      return { name: first, deployRoot: join(appsRoot, first), appsRoot };
    }
  }

  const found = listDeployments(appsRoot);
  if (found.length === 1 && found[0] !== undefined) {
    return { name: found[0], deployRoot: join(appsRoot, found[0]), appsRoot };
  }
  if (found.length === 0) {
    throw new DeploymentResolutionError(
      `No deployment found under ${appsRoot}. Pass --root to point at one somewhere else.`,
    );
  }
  throw new DeploymentResolutionError(
    `Several deployments are installed under ${appsRoot}: ${found.join(', ')}. Pass --name to choose one.`,
  );
}
