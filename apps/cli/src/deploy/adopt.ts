import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { CLI_VERSION } from '../package-info.js';
import { readDeployInfo } from './deploy-info.js';
import {
  deploymentEvidence,
  envFacts,
  hasDeployment,
  type DeploymentEvidence,
} from './deployment-evidence.js';
import { envFilePath } from './env-file.js';
import type { runCommand as defaultRunCommand } from './executor.js';
import { DEFAULT_BIND_PORT, DEFAULT_PROXY_ROOT } from './layout.js';
import { displayRepoUrl, normaliseRepoUrl } from './repo.js';
import {
  DEPLOY_STATE_VERSION,
  NotInstalledError,
  deployStatePath,
  type DeployState,
} from './state.js';

// =============================================================================
// Adopting a deployment this CLI has no record of  (issue #285, epic #168)
// =============================================================================
//
// THE STATE FILE IS BOOKKEEPING; THE DEPLOYMENT IS THE CLONE, THE `.env` AND
// THE RUNNING CONTAINERS. `update` used to key its precondition on the first
// and refuse when it was missing, which meant a deployment serving HTTPS on a
// certificate this CLI issued could not be updated - and the refusal pointed
// at `install`, whose own precondition is the opposite. "Is there a state
// file?" and "is there a deployment here?" are different questions, and only
// the second is the one `update` needs answered.
//
// So when there is no state file, this module answers the second question from
// the disk and rebuilds the first. Two rules shape every line below.
//
//   1. THE GATE LIVES IN `deployment-evidence.ts`, NOT HERE, and its argument
//      is written there. It is shared with `listInstalledApps`, because
//      discovery keyed on the state file for the same reason `requireState`
//      did - one defect at two levels, and one predicate for both. A directory
//      that does not pass it still refuses with the message it always gave.
//
//   2. NOTHING IS INVENTED. Every field below is READ from somewhere, and the
//      two that cannot be read - `installedAt` and `lastDeployedAt` - are left
//      absent rather than stamped with this run's own clock. #284 made
//      `lastDeployedAt` optional precisely so "no deploy has ever completed
//      here" is representable rather than guessed, and putting a fabricated
//      instant on the About page is the class of bug #283 fixed. `adoptedAt`
//      records the one instant that IS true: when the record was rebuilt.
// =============================================================================

/** What the operator is told, once, when a deployment is adopted. */
export interface AdoptionNotice {
  /** One line, for the terminal and for a `--json` consumer. */
  headline: string;
  /** What was rebuilt and from where; one line each. */
  detail: string[];
}

export interface Adoption {
  state: DeployState;
  notice: AdoptionNotice;
}

export interface AdoptOptions {
  deployRoot: string;
  runCommand: typeof defaultRunCommand;
  /** `--ref`, when the clone's own HEAD cannot name a branch. */
  ref?: string | undefined;
  /** `--proxy-container`; otherwise left unrecorded for the preflight to find. */
  proxyContainer?: string | undefined;
  /** The shared proxy's directory, for finding this deployment's vhost. */
  proxyRoot?: string | undefined;
  /** Injected by the tests; the adoption instant. */
  now?: Date | undefined;
}

/**
 * Rebuilds the state for a deployment that is there but unrecorded, or throws
 * `NotInstalledError` with the message a missing deployment has always got.
 *
 * The refusal is the SAME message whether the directory is empty or holds half
 * a deployment: a caller standing somewhere that is not a deployment needs the
 * remedy, not a diagnosis of which half is missing. The half that IS there is
 * named underneath it, so an operator who expected an adoption can see why
 * they did not get one.
 */
export async function adoptDeployment(options: AdoptOptions): Promise<Adoption> {
  const { deployRoot } = options;
  const evidence = deploymentEvidence(deployRoot);

  if (!hasDeployment(evidence)) {
    throw new NotInstalledError(
      `No deployment found at ${deployRoot}. Run \`${CLI_NAME} deploy install\` first, or pass --root if it is somewhere else.` +
        missingEvidenceDetail(deployRoot, evidence),
    );
  }

  const repo = join(deployRoot, 'repo');
  const facts = envFacts(deployRoot);
  const detail: string[] = [];

  const origin = await git(options, repo, ['remote', 'get-url', 'origin']);
  if (origin === undefined) {
    // The one reconstructable field with no default worth guessing: deploying
    // the wrong repository is the failure `resolveRepoTarget`'s rank-3 guard
    // exists to make impossible, and inventing an origin here would walk
    // straight into it.
    throw new NotInstalledError(
      `The clone at ${repo} has no \`origin\` remote, so ${CLI_NAME} cannot tell what this deployment is. Re-run \`${CLI_NAME} deploy install\` with --repo, or set the remote by hand.`,
    );
  }
  const repoUrl = normaliseRepoUrl(origin);
  detail.push(`repository  ${displayRepoUrl(repoUrl)}  (repo/ origin)`);

  const commitSha = await git(options, repo, ['rev-parse', 'HEAD']);
  if (commitSha === undefined) {
    throw new NotInstalledError(
      `The clone at ${repo} has no HEAD commit, so ${CLI_NAME} cannot tell what revision is deployed. Re-run \`${CLI_NAME} deploy install\`.`,
    );
  }
  detail.push(`revision    ${commitSha.slice(0, 12)}  (repo/ HEAD)`);

  // The flag wins, then the branch HEAD is on, then the remote's own default.
  // NEVER `main`: a fork on master or develop would be adopted onto the wrong
  // branch and updated to it on the very next run, which is the mistake
  // `remoteDefaultBranch` exists to prevent in `resolveRepoTarget` too.
  const branch = await git(options, repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const symbolic = await git(options, repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const ref =
    options.ref ??
    (branch === undefined || branch === 'HEAD' ? undefined : branch) ??
    symbolic?.replace(/^origin\//, '');
  if (ref === undefined || ref === '') {
    throw new NotInstalledError(
      `The clone at ${repo} is on a detached HEAD and its remote has no default branch, so ${CLI_NAME} cannot tell which ref this deployment tracks. Re-run with --ref <branch|tag|sha>.`,
    );
  }
  detail.push(
    `ref         ${ref}  (${options.ref !== undefined ? '--ref' : branch !== undefined && branch !== 'HEAD' ? 'repo/ HEAD' : 'repo/ origin default branch'})`,
  );

  // The compose project name, which is what keeps two apps on one host apart.
  // Install writes it into the .env, so the .env is the answer; the directory
  // name is what `projectNameFor` would have fallen back to anyway.
  const name = facts.composeProjectName ?? basename(deployRoot);
  detail.push(
    `name        ${name}  (${facts.composeProjectName === undefined ? 'directory name' : '.env COMPOSE_PROJECT_NAME'})`,
  );

  // The default is applied HERE rather than in `envFacts`, which reads and
  // never decides: this is a record about to be written, so it needs a number,
  // while `siblingBindPorts` needs the opposite - see that module's rule 2.
  const bindPort = facts.bindPort ?? DEFAULT_BIND_PORT;
  detail.push(
    `bind port   ${bindPort}  (${facts.bindPort === undefined ? 'default' : '.env APP_BIND_PORT'})`,
  );

  const proxyRoot = options.proxyRoot ?? DEFAULT_PROXY_ROOT;
  const fromEnv = domainFromAppUrl(facts.appUrl);
  const fromVhost = fromEnv === undefined ? findVhostDomain(proxyRoot, bindPort) : undefined;
  const domain = fromEnv ?? fromVhost;
  detail.push(
    domain === undefined
      ? 'domain      not published  (no APP_URL host, no matching proxy vhost)'
      : `domain      ${domain}  (${fromEnv !== undefined ? '.env APP_URL' : `${proxyRoot} vhost`})`,
  );

  // The one instant that IS knowable, and only because it is happening now.
  const adoptedAt = (options.now ?? new Date()).toISOString();

  // READ BACK, NEVER GUESSED. A deployment whose state file was lost often
  // still has deploy-info/info.json, which carries the real install instant -
  // so it is recovered from there when it is there. `lastDeployedAt` is
  // deliberately NOT recovered the same way: that document's `updatedAt` is
  // written as `lastDeployedAt ?? installedAt`, so reading it back cannot
  // tell the two apart, and #283's failed-first-install document would turn
  // "never deployed" into a deploy that did not happen.
  const installedAt = recordedInstalledAt(deployRoot);
  detail.push(
    installedAt === undefined
      ? 'installed   unknown  (no instant for it exists on this disk, and this run will not invent one)'
      : `installed   ${installedAt}  (deploy-info/info.json)`,
  );

  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl,
    ref,
    commitSha,
    bindPort,
    deployRoot,
    name,
    envPath: envFilePath(deployRoot),
    proxyRoot,
    // `lastCommand` is what this record was written BY, and an adoption
    // happens inside an update. `installedAt`/`lastDeployedAt` stay absent.
    lastCommand: 'update',
    adoptedAt,
    appctlVersion: CLI_VERSION,
    ...(domain === undefined ? {} : { domain }),
    ...(installedAt === undefined ? {} : { installedAt }),
    ...(options.proxyContainer === undefined ? {} : { proxyContainer: options.proxyContainer }),
  };

  // WHERE THE REBUILT RECORD LANDS, as a path rather than a bare filename
  // (#292). The headline below says what the thing IS: an operator reading
  // `no .appctl-deploy.json was here` out of a binary that has not been called
  // `appctl` for some time reasonably reads it as a bug, or as this CLI
  // talking about a different tool. The name itself is NOT changing and must
  // not - `state.ts` records why, at its declaration: the file is read back
  // off live servers, so renaming it makes every existing deployment
  // invisible. So it stays, here, on the same footing as the sources the lines
  // above already cite and as the entry list `teardown.ts` prints for
  // `--dry-run`: somewhere a name is DATA, in a line an operator can check by
  // hand, and where a `--json` consumer still gets it.
  detail.push(`record      ${deployStatePath(deployRoot)}  (written by this run)`);

  return {
    state,
    notice: {
      headline:
        'Adopted this deployment: no deployment record was here, so the record was rebuilt from the clone, the .env and the proxy.',
      detail,
    },
  };
}

export { deploymentEvidence, hasDeployment, type DeploymentEvidence };

/** `${headline}` then the detail, indented - the journal's and the terminal's shape. */
export function renderAdoption(notice: AdoptionNotice): string[] {
  return [notice.headline, ...notice.detail.map((line) => `  ${line}`)];
}

/**
 * What IS there, appended to the refusal.
 *
 * Only ever additive: an operator who expected `update` to adopt a deployment
 * and got the old refusal instead needs to know which half this found, and an
 * operator who simply pointed the command at the wrong directory sees nothing
 * extra because there is nothing to report.
 */
function missingEvidenceDetail(deployRoot: string, evidence: DeploymentEvidence): string {
  const found: string[] = [];
  if (evidence.clone) found.push(`a git checkout at ${join(deployRoot, 'repo')}`);
  if (evidence.env) found.push(`an ${envFilePath(deployRoot)}`);
  if (found.length === 0) return '';
  return `\nThere is ${found.join(' and ')} here, but a deployment needs both, so this is not one.`;
}

/**
 * The install instant the deploy-info document records, if there is one.
 *
 * Never allowed to throw: a corrupt or hand-edited info.json is a reason to
 * leave the instant unknown, not a reason to refuse to adopt a deployment
 * that is plainly there.
 */
function recordedInstalledAt(deployRoot: string): string | undefined {
  try {
    return readDeployInfo(deployRoot)?.installedAt ?? undefined;
  } catch {
    return undefined;
  }
}

/** Runs git inside the clone; undefined for anything that is not a clean answer. */
async function git(
  options: AdoptOptions,
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await options.runCommand(['git', ...args], { cwd, timeoutMs: 30_000 });
    const out = result.stdout.trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * The public hostname `APP_URL` names, or undefined.
 *
 * A loopback host is not a published domain - a deployment installed without
 * `--domain` keeps `.env.example`'s `http://localhost:3535` - and adopting
 * `localhost` as the domain would make the publish step try to issue a
 * certificate for it.
 */
export function domainFromAppUrl(appUrl: string | undefined): string | undefined {
  if (appUrl === undefined || appUrl.trim() === '') return undefined;
  let host: string;
  try {
    host = new URL(appUrl.trim()).hostname;
  } catch {
    return undefined;
  }
  if (host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return undefined;
  }
  return host;
}

/**
 * The domain of the shared proxy's vhost that forwards to this deployment.
 *
 * `renderVhost` writes exactly one `proxy_pass http://127.0.0.1:<bindPort>;`
 * per vhost and names the file after the domain, so the bind port identifies
 * the vhost and the filename is the answer - which is why the port is resolved
 * before this is called. Unreadable proxy root, no match, or more than one
 * match all answer undefined: adopting the wrong domain would publish this
 * deployment under somebody else's hostname.
 */
export function findVhostDomain(proxyRoot: string, bindPort: number): string | undefined {
  const dir = join(proxyRoot, 'nginx', 'conf.d');
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.conf')).sort();
  } catch {
    return undefined;
  }

  const matches = names.filter((name) => {
    try {
      return readFileSync(join(dir, name), 'utf8').includes(`http://127.0.0.1:${bindPort};`);
    } catch {
      return false;
    }
  });

  return matches.length === 1 ? (matches[0] as string).replace(/\.conf$/, '') : undefined;
}
