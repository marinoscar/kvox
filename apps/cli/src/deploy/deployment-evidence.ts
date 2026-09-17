import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readEnvFile } from './env-file.js';

// =============================================================================
// Is there a deployment here?  (issue #285, epic #168)
// =============================================================================
//
// THE STATE FILE IS BOOKKEEPING; THE DEPLOYMENT IS THE CLONE, THE `.env` AND
// THE RUNNING CONTAINERS. Two places used to key on the first and answer the
// wrong question with it:
//
//   - `requireState`, which made `update` refuse a server that was demonstrably
//     serving HTTPS because `.appctl-deploy.json` was missing, and point at
//     `install`, whose own precondition is the opposite;
//   - `listInstalledApps`, which discovers apps under the apps root by looking
//     for that same file, so a bare `deploy update` with no `--name` never
//     even reached the first one.
//
// They are one defect at two levels, so they share ONE predicate - this file -
// rather than growing a second one that can drift from it. `adopt.ts` (what
// `update` does about it) and `layout.ts` (what discovery does) both import
// from here, and this module deliberately imports NEITHER, so there is no
// cycle between them.
//
// TWO RULES:
//
//   1. THE GATE IS POSITIVE EVIDENCE, NEVER THE ABSENCE OF A REFUSAL. Two
//      things must BE there - a git checkout at `repo/`, and a readable `.env`
//      - and a directory with neither, or with one, is not a deployment. An
//      empty `--root` typo, or a stray directory under the apps root, must
//      never be adopted into one.
//
//      Both are required because both are things this CLI itself creates and
//      the update pipeline itself needs: `fetch` fetches and checks out inside
//      `repo/`, and everything from `build` onward interpolates `.env`.
//      Neither is inferable from the other, so neither alone is evidence.
//
//      RUNNING CONTAINERS ARE DELIBERATELY NOT PART OF THE GATE, although the
//      issue offers them. A deployment whose containers are stopped, pruned or
//      wedged is precisely the deployment somebody is trying to update, and a
//      gate that refused it would refuse the recovery case this exists for. It
//      would also put a Docker subprocess into a code path that has to work
//      when the daemon is down - and, for discovery, one per directory under
//      the apps root, on a command that is meant to be instant.
//
//   2. THIS MODULE READS, IT DOES NOT DECIDE. `envFacts` answers what the
//      deployment's own `.env` says and nothing more: a missing key is
//      `undefined`, never a default. Defaults are policy, and the two callers
//      have different ones - `adopt.ts` falls back to `DEFAULT_BIND_PORT` for
//      a record it is about to write, while `siblingBindPorts` must claim NO
//      port for a deployment whose port it cannot read, because telling the
//      install wizard that 3535 is taken when nothing says so is worse than
//      saying nothing.
// =============================================================================

/** What is actually on the disk at a deploy root. */
export interface DeploymentEvidence {
  /** `<root>/repo` exists and is a git checkout. */
  clone: boolean;
  /** The deployment's `.env` is readable, in either layout. */
  env: boolean;
}

/**
 * The two pieces of positive evidence, each answered independently so a
 * refusal can say which one is missing.
 *
 * `.git` is tested with `existsSync` rather than a directory test: it is a
 * directory in an ordinary clone and a FILE in a worktree, the same thing
 * `findGitRoot` accounts for.
 */
export function deploymentEvidence(deployRoot: string): DeploymentEvidence {
  return {
    clone: existsSync(join(deployRoot, 'repo', '.git')),
    env: readEnvFileQuietly(deployRoot) !== undefined,
  };
}

/** True when both pieces of evidence are there. */
export function hasDeployment(evidence: DeploymentEvidence): boolean {
  return evidence.clone && evidence.env;
}

/** Shorthand for the two above, for a caller with nothing to say about which half is missing. */
export function isDeployment(deployRoot: string): boolean {
  return hasDeployment(deploymentEvidence(deployRoot));
}

/**
 * What a deployment's own `.env` says about itself.
 *
 * Every field is optional and a missing key is `undefined`, never a default -
 * see rule 2 above. `bindPort` is undefined for a value that is not a positive
 * integer, so a hand-edited `APP_BIND_PORT=` cannot become `NaN` downstream.
 */
export interface EnvFacts {
  /** The compose project name install writes; what keeps two apps on one host apart. */
  composeProjectName?: string | undefined;
  bindPort?: number | undefined;
  appUrl?: string | undefined;
}

export function envFacts(deployRoot: string): EnvFacts {
  const env = readEnvFileQuietly(deployRoot);
  if (env === undefined) return {};

  const name = env.get('COMPOSE_PROJECT_NAME');
  const port = Number(env.get('APP_BIND_PORT'));
  const appUrl = env.get('APP_URL');

  return {
    ...(name === undefined || name === '' ? {} : { composeProjectName: name }),
    ...(Number.isInteger(port) && port > 0 ? { bindPort: port } : {}),
    ...(appUrl === undefined || appUrl === '' ? {} : { appUrl }),
  };
}

/**
 * Never allowed to throw: an unreadable `.env` means "no evidence", not a
 * crash in a listing that has other directories to report on.
 */
function readEnvFileQuietly(deployRoot: string): Map<string, string> | undefined {
  try {
    return readEnvFile(deployRoot);
  } catch {
    return undefined;
  }
}
