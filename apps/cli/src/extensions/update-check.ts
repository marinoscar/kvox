import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEPLOY_STATE_FILENAME } from '@marinoscar/platform-cli/deploy';

// =============================================================================
// `deploy update --check`: what would an update bring?  (issue #123, ported by #482)
// =============================================================================
//
// The platform's `deploy update` has no read-only preview, and operators (and
// the deploy end-to-end workflow) script `update --check --json`. So the flag
// stays, as a REDUCED port that keeps the answer and its JSON shape and drops the
// bookkeeping:
//
//   KEPT     fetch the ref, compare it with the deployed commit, print the
//            headline and the newest commits; `--json` prints the check object
//            itself (`current`, `latest`, `commitsBehind`, `commits`,
//            `checkedAt`); exit 0 whether or not there is anything to apply;
//            nothing is checked out, built or written.
//   DROPPED  recording the answer as `remote` in `deploy-info/info.json` (the
//            platform's reader does not carry that field), the GitHub CLI
//            credential wiring (git's own credential helper is used, with
//            prompting disabled) and the ten-second `status` variant.
//
// PLATFORM-ADOPTION-SHIM(#482): removed when the platform's `deploy update` has
// a read-only preview of its own.
//
// It reads the platform's state file (`.appctl-deploy.json`, a fixed literal on
// live servers) for the deployed commit, the requested ref and the repository,
// and runs `git` in the deployment's own clone. Everything that touches git goes
// through an injected runner so the tests need no repository on the network.
// =============================================================================

/** The answer to "is there anything to update, and what?". Same shape as before the platform engine. */
export interface UpdateCheck {
  /** The deployed commit, from the state file. */
  current: string;
  /** What the ref resolves to on the remote now. */
  latest: string;
  /** `git rev-list --count current..latest`. */
  commitsBehind: number;
  /** The newest 50 non-merge commits in that range, newest first. */
  commits: { sha: string; subject: string }[];
  /** ISO-8601 UTC. */
  checkedAt: string;
}

/** Runs `git <args>` in `cwd` and answers stdout; rejects on a non-zero exit. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/** Longest a fetch may take before the check gives up. */
export const FETCH_TIMEOUT_MS = 60_000;

/** The default runner: `git` with every credential prompt disabled. */
export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: FETCH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '/bin/true',
          GCM_INTERACTIVE: 'never',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').trim().split('\n').pop() ?? error.message;
          reject(new Error(`git ${args[0] ?? ''} failed: ${detail || error.message}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });

/** The fields of the state file this check reads. */
interface StateFields {
  commitSha: string;
  ref: string;
}

function readStateFields(deployRoot: string): StateFields {
  const path = join(deployRoot, DEPLOY_STATE_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `No deployment record at ${path}. Run an update (it adopts a deployment with no record) or pass --root.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const commitSha = record.commitSha;
  const ref = record.ref;
  if (typeof commitSha !== 'string' || commitSha === '') {
    throw new Error(`${path} records no deployed commit, so there is nothing to compare against.`);
  }
  return { commitSha, ref: typeof ref === 'string' && ref !== '' ? ref : 'HEAD' };
}

/** Options of {@link checkForUpdate}. */
export interface CheckForUpdateOptions {
  deployRoot: string;
  /** `--ref`: a ref other than the one recorded. */
  ref?: string | undefined;
  runGit?: GitRunner | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Fetches the ref into the deployment's clone's `FETCH_HEAD` and compares it
 * with the deployed commit, without moving the clone.
 *
 * @throws Error when there is no record, no clone or the fetch fails; the
 *   message names what to do.
 */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheck> {
  const git = options.runGit ?? runGit;
  const state = readStateFields(options.deployRoot);
  const ref = options.ref ?? state.ref;
  const clone = join(options.deployRoot, 'repo');

  if (ref.startsWith('-')) throw new Error(`"${ref}" is not a usable ref.`);

  try {
    await git(clone, ['fetch', '--quiet', '--tags', 'origin', ref]);
  } catch (error) {
    throw new Error(
      `Could not fetch ${ref} from the remote of ${clone}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  const latest = (await git(clone, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
  const current = state.commitSha;

  if (latest === current) {
    return { current, latest, commitsBehind: 0, commits: [], checkedAt: (options.now?.() ?? new Date()).toISOString() };
  }

  const range = `${current}..${latest}`;
  const count = Number((await git(clone, ['rev-list', '--count', range])).trim());
  if (!Number.isInteger(count)) {
    throw new Error(`git rev-list --count ${range} did not answer a number.`);
  }

  const log = await git(clone, ['log', '--no-merges', '--max-count=50', '--format=%H%x09%s', range]);
  const commits = log
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [sha = '', ...subject] = line.split('\t');
      return { sha: sha.slice(0, 12), subject: subject.join('\t') };
    });

  return { current, latest, commitsBehind: count, commits, checkedAt: (options.now?.() ?? new Date()).toISOString() };
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** The human rendering of a check: a headline, then one line per commit. */
export function renderUpdateCheck(check: UpdateCheck): string[] {
  if (check.commitsBehind === 0 && check.current === check.latest) {
    return [`already up to date at ${shortSha(check.current)}`];
  }
  const noun = check.commitsBehind === 1 ? 'commit' : 'commits';
  return [
    `current ${shortSha(check.current)} → latest ${shortSha(check.latest)}, ${check.commitsBehind} ${noun} behind`,
    ...check.commits.map((commit) => `${commit.sha}  ${commit.subject}`),
  ];
}
