import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { composeEnvPath, envFilePath, readEnvFile } from './env-file.js';

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

// =============================================================================
// Is this one of OUR deployments?  (issue #290, epic #168)
// =============================================================================
//
// A SECOND PREDICATE, NARROWER THAN THE GATE ABOVE, AND NOT A TIGHTENING OF
// IT. The gate answers "is there a deployment here?", which is the question
// ADOPTION asks about a directory an operator has already named, and it must
// stay as loose as it is: `adopt.ts` and `listInstalledApps` share it so
// discovery and adoption can never disagree about what a deployment is.
//
// ENUMERATION asks a different question. `listInstalledApps` reads every
// subdirectory of the apps root and speaks for the answer in an ambiguity
// refusal, and on a host that runs several unrelated applications under one
// apps root - the documented multi-app layout - a stranger's `repo/` + `.env`
// passes the gate and is named in a refusal about THIS CLI's deployments.
// "Is there a deployment here?" and "is this one of mine?" are different
// questions; this is the second one, and it is used ONLY where a directory
// was never named by anybody (enumeration, and the cwd rank that resolves
// one deployment out of many). `adoptDeployment` does not consult it, so
// `--root <a-stranger's-directory>` is refused or adopted exactly as before.
//
// THE MARKER IS `DEPLOY_ROOT`, AND THE CHOICE IS DELIBERATE. Install writes
// `COMPOSE_PROJECT_NAME` and `DEPLOY_ROOT` into the `.env` together (#142,
// `install.ts`'s `environment` step), and `update` re-pins `DEPLOY_ROOT` on
// every run, so a deployment updated by any build since #142 carries it even
// if it was installed before. `COMPOSE_PROJECT_NAME` is NOT used as a second
// marker: it is a variable Docker Compose itself defines, so a foreign app
// may legitimately set it, and it can never be present on one of ours
// without `DEPLOY_ROOT` beside it - it would widen the false accepts and
// narrow nothing.
//
// A GENUINE DEPLOYMENT MUST NOT VANISH FROM THE LISTING, which is why the
// pre-#142 layout counts on its own. Before #142 the `.env` lived INSIDE the
// clone at `repo/infra/compose/.env` and neither marker existed; a
// deployment from that era whose state file has since been lost, and which
// has not been updated since, would otherwise disappear from a listing it
// used to appear in - regressing #285 in the opposite direction. An `.env`
// read from the legacy path is therefore accepted as its own marker: it is
// this template's own layout, it is where OURS used to live, and the cost of
// being wrong about it is one extra name in a listing, which is strictly
// better than hiding a real deployment.
// =============================================================================

/** The `.env` key install writes and update re-pins; not in `.env.example`. */
export const CLI_ENV_MARKER = 'DEPLOY_ROOT';

/**
 * True when the deployment's own `.env` shows this CLI wrote it.
 *
 * Callers: `listInstalledApps` and the cwd rank in `layout.ts`. Never
 * `adopt.ts` - see the header above. Reads only; a missing `.env`, or one
 * that cannot be read, is `false` rather than an error, the same posture
 * every other read in this module takes.
 */
export function envWrittenByThisCli(deployRoot: string): boolean {
  const env = readEnvFileQuietly(deployRoot);
  if (env === undefined) return false;
  if (env.has(CLI_ENV_MARKER)) return true;

  // The pre-#142 layout: no `<root>/.env` at all, and the file `readEnvFile`
  // just succeeded on is the one inside the clone.
  return !existsSync(envFilePath(deployRoot)) && existsSync(composeEnvPath(deployRoot));
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
