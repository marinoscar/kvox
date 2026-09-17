import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { PreconditionError, UsageError } from '../errors.js';
import { GITHUB_HOST, parseGithubRepo } from './checks/github.js';
import type { DeployHooks } from './hooks.js';
import type { runCommand } from './executor.js';
import type { Redactor } from './journal.js';
import type { DeployState } from './state.js';

// =============================================================================
// What to deploy, worked out rather than hardcoded  (issue #179, epic #168)
// =============================================================================
//
// THIS REPOSITORY IS A TEMPLATE. It exists to be forked, and each fork has its
// own origin, its own default branch and its own tags.
//
// The shell scripts this epic replaces hardcode the repository they deploy,
// and that is the single largest reason they cannot be shared: every new
// application means copying the script and editing the URL, after which the
// copies drift and a fix made in one never reaches the others. If kvox
// hardcoded an owner or a repository name anywhere, it would inherit exactly
// that, and every downstream repository would have to patch the CLI before it
// could deploy itself.
//
// So NOTHING here names a repository. The target is resolved from the checkout
// kvox is running in, and repo.test.ts asserts that this module contains no
// owner, no repository name and no forge URL - a guard that already caught an
// earlier draft of this very comment, which had spelled one out as an example.
// =============================================================================

export interface RepoTarget {
  /** Normalised remote URL, in whichever scheme the operator already uses. */
  url: string;
  /** Branch, tag or SHA. */
  ref: string;
  source: 'flag' | 'state' | 'git-remote';
}

export interface ResolveRepoOptions {
  repoFlag?: string | undefined;
  refFlag?: string | undefined;
  /**
   * The deployment's own record, when the caller has one.
   *
   * `update`, `status` and `doctor` pass the state of the deploy root they
   * already located. `install` had no way to - it derives the deploy root
   * from the target, so it could not read a state file to produce one - which
   * is why #266 gave it `locateAppFromCwd`: the deployment cwd is standing in
   * is identified from the directory, and its state arrives here.
   */
  state?: Pick<DeployState, 'repoUrl' | 'ref'> | undefined;
  /** Where to start looking for a .git directory. */
  cwd: string;
  /**
   * The apps root, when the caller knows it (#247).
   *
   * Only ever used to REFUSE an ambient resolution, never to produce one:
   * see the guard in `resolveRepoTarget`.
   */
  appsRoot?: string | undefined;
  runCommand: typeof runCommand;
}

/**
 * `owner/repo` when the remote is on GitHub, in any scheme git accepts
 * (`https://`, `git@…:`, `ssh://git@…/`, with or without `.git` or an
 * embedded token); null for anything else. One parser, shared with the
 * `gh-repo-access` doctor check, so the two can never disagree about what
 * counts as a GitHub remote.
 */
export function githubSlug(url: string): string | null {
  const repo = parseGithubRepo(url);
  return repo === undefined ? null : `${repo.owner}/${repo.name}`;
}

/**
 * The URL git is handed, from whatever the operator wrote.
 *
 * A GITHUB REMOTE IS ALWAYS REWRITTEN TO HTTPS (issue #123, epic #118
 * decision 1): on the server the credential is the GitHub CLI, and `gh auth
 * setup-git` installs a credential helper for `https://<host>` only - an
 * `ssh://` or `git@` origin copied from a laptop would bypass it and stall on
 * a key that does not exist. So ssh, scp-style and https all become
 * `https://<host>/<owner>/<repo>.git`, GitHub's own canonical clone URL.
 *
 * EVERY OTHER SCHEME IS PRESERVED. Rewriting ssh to https breaks a server
 * whose access to another forge is a deploy key; rewriting https to ssh
 * breaks one that has no key at all. Whichever the operator already uses is
 * the one that works there, so only `.git` and any embedded credentials are
 * stripped - a token in the URL must never reach a log line.
 */
export function normaliseRepoUrl(url: string): string {
  const slug = githubSlug(url);
  if (slug !== null) return `https://${GITHUB_HOST}/${slug}.git`;

  const trimmed = url.trim().replace(/\.git$/, '');
  return trimmed.replace(/^(https?:\/\/)[^@/]+@/, '$1');
}

/** True when the URL carries embedded credentials that must not be printed. */
export function hasEmbeddedCredentials(url: string): boolean {
  return /^https?:\/\/[^@/]+@/.test(url);
}

/** Redacts credentials for display. */
export function displayRepoUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/, '$1***@');
}

/** True when `child` is `parent` or sits underneath it. */
export function contains(parent: string, child: string): boolean {
  const from = resolve(parent);
  const to = resolve(child);
  return to === from || to.startsWith(from.endsWith(sep) ? from : from + sep);
}

/** Walks up from `cwd` looking for a .git directory or file. */
export function findGitRoot(cwd: string): string | undefined {
  let current = resolve(cwd);

  for (;;) {
    // `.git` is a directory in a normal clone and a FILE in a worktree, so
    // existsSync rather than a directory test.
    if (existsSync(join(current, '.git'))) return current;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function git(
  options: ResolveRepoOptions | { cwd: string; runCommand: typeof runCommand },
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await options.runCommand(['git', ...args], {
      cwd: options.cwd,
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Works out what to deploy.
 *
 * Order: an explicit flag, then the recorded state, then the local checkout.
 *
 * State beats the checkout so that an `update` redeploys WHAT WAS INSTALLED.
 * An install pinned to a tag must not be quietly moved to whatever branch the
 * operator's shell happens to be on. The same ordering is why #266 has
 * `install` look for a state file beside cwd BEFORE it gets here: a state file
 * is a record this CLI wrote, a git remote is an inference about what the
 * operator probably meant, and rank 3's guard (below) exists precisely because
 * that inference can land on the wrong repository.
 */
export async function resolveRepoTarget(
  options: ResolveRepoOptions,
): Promise<RepoTarget> {
  if (options.repoFlag !== undefined) {
    return {
      url: normaliseRepoUrl(options.repoFlag),
      ref: options.refFlag ?? (await defaultRefFor(options, options.repoFlag)) ?? 'main',
      source: 'flag',
    };
  }

  if (options.state !== undefined) {
    return {
      url: options.state.repoUrl,
      ref: options.refFlag ?? options.state.ref,
      source: 'state',
    };
  }

  const root = findGitRoot(options.cwd);

  // A checkout that CONTAINS the apps root is the surrounding
  // infrastructure, not the application being deployed (#247).
  //
  // `/opt/infra` is commonly a git repository - infrastructure as code is
  // the ordinary shape - and the runbook puts applications under
  // `/opt/infra/apps`. So running this from the apps root, the most natural
  // place to run a deploy command, walked up into the infra repo and
  // derived the app name from IT: an operator deploying one repository was
  // silently pointed at another.
  //
  // That was reported as a permission error only because the apps root
  // happened to be root-owned. With a writable one it would have cloned and
  // deployed the wrong repository without a word, which is the failure this
  // guard exists to make impossible.
  //
  // Only rank 3 is constrained. `--repo` and a saved state never reach here,
  // and a checkout INSIDE the apps root - the ordinary "deploy this clone"
  // case - is not contained by it and passes untouched.
  //
  // A DEPLOY ROOT NO LONGER REACHES THIS EITHER (#266). Standing in
  // `/opt/infra/apps/<app>` used to land here, because the walk went past the
  // state file in that very directory and found the infra repository above
  // it. The guard was right and reaching it was the bug; `install` now reads
  // that state file first and this fires only for a cwd that really does
  // imply nothing.
  if (root !== undefined && options.appsRoot !== undefined && contains(root, options.appsRoot)) {
    throw new UsageError(
      `Refusing to guess what to deploy: ${options.cwd} sits inside ${root}, which CONTAINS the apps root ${options.appsRoot}. ` +
        `That checkout is this server's infrastructure, not the application. ` +
        `Name the repository explicitly with --repo <url>, or run this from inside a checkout of the application itself.`,
    );
  }

  if (root === undefined) {
    throw new UsageError(
      `Not inside a git checkout, so there is no repository to deploy. Pass --repo <url> (and --ref if you need a branch or tag other than the default).`,
    );
  }

  const scoped = { cwd: root, runCommand: options.runCommand };
  const origin = await git(scoped, ['remote', 'get-url', 'origin']);

  if (origin === undefined || origin === '') {
    throw new UsageError(
      `This checkout has no \`origin\` remote, so ${CLI_NAME} cannot tell what to deploy. Pass --repo <url>.`,
    );
  }

  const ref =
    options.refFlag ??
    (await git(scoped, ['rev-parse', '--abbrev-ref', 'HEAD'])) ??
    (await remoteDefaultBranch(scoped));

  if (ref === undefined || ref === '' || ref === 'HEAD') {
    // A detached HEAD, or a repository whose default branch cannot be read.
    // Guessing "main" here is how you deploy the wrong code on a fork that
    // uses master or develop.
    throw new UsageError(
      `Could not work out which branch to deploy from this checkout. Pass --ref <branch|tag|sha>.`,
    );
  }

  return { url: normaliseRepoUrl(origin), ref, source: 'git-remote' };
}

async function defaultRefFor(
  options: ResolveRepoOptions,
  _url: string,
): Promise<string | undefined> {
  const root = findGitRoot(options.cwd);
  if (root === undefined) return undefined;
  return await remoteDefaultBranch({ cwd: root, runCommand: options.runCommand });
}

/**
 * The remote's own default branch.
 *
 * NEVER ASSUMED TO BE `main`. A fork may use master, develop, or anything
 * else, and deploying the wrong branch is the kind of mistake that looks like
 * a successful deployment.
 */
async function remoteDefaultBranch(scoped: {
  cwd: string;
  runCommand: typeof runCommand;
}): Promise<string | undefined> {
  const symbolic = await git(scoped, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return symbolic?.replace(/^origin\//, '');
}

export interface GitHubAuthOptions {
  runCommand: typeof runCommand;
  /** The remote about to be cloned or fetched. */
  repoUrl: string;
  /** Where `gh` runs; any existing directory, it reads nothing from it. */
  cwd: string;
  hooks?: DeployHooks | undefined;
  /**
   * The run journal's redactor (issue #156).
   *
   * Required wherever `onLog` is wired, and this file wires it: `executor.ts`
   * rule 5 masks a line the moment it is assembled, so the redactor has to
   * reach `runCommand` or the operator's terminal sees output the log file
   * does not. Optional only because `status` and the tests drive these
   * functions with no journal open, where there is no secret set to mask
   * against and the redactor would be the identity function anyway.
   */
  redact?: Redactor | undefined;
}

/**
 * Makes plain `git` able to reach a private GitHub repository over HTTPS,
 * through the GitHub CLI's token (issue #123, epic #118 decision 1).
 *
 * `gh auth status` first - a logged-out `gh` has to stop the run BEFORE any
 * clone, with the login command in hand, rather than as git's own
 * "Authentication failed" halfway in. Then `gh auth setup-git`, which writes
 * `credential.https://<host>.helper` into git's config; it is idempotent, so
 * it runs on every install and update and a server whose config was reset
 * heals on the next one.
 *
 * NOT CALLED FROM `ensureCheckout`, DELIBERATELY. repo.test.ts drives that
 * function with the real `runCommand` against local repositories, and an
 * unconditional `gh` call inside it would execute `gh` in every test. It is
 * its own pipeline step (`auth`) in install and update, which also skip it
 * outright for a remote that is not on GitHub: another forge, or CI's
 * `file://` remote, is deployed with plain git and `gh` is never consulted.
 */
export async function ensureGitHubAuth(
  options: GitHubAuthOptions,
): Promise<{ slug: string } | undefined> {
  const slug = githubSlug(options.repoUrl);
  if (slug === null) return undefined;

  const run = (argv: readonly string[]) =>
    options.runCommand(argv, {
      cwd: options.cwd,
      timeoutMs: 60_000,
      ...(options.redact === undefined ? {} : { redact: options.redact }),
      ...(options.hooks?.onLog === undefined
        ? {}
        : { onLine: (line: string) => options.hooks?.onLog?.(line) }),
    });

  try {
    await run(['gh', 'auth', 'status']);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PreconditionError(
      `The GitHub CLI is not logged in, so ${slug} cannot be cloned. ` +
        `Log in: gh auth login --hostname ${GITHUB_HOST} --git-protocol https ` +
        `(or, with a token you already have: gh auth login --with-token < token.txt).\n${detail}`,
    );
  }

  try {
    await run(['gh', 'auth', 'setup-git', '--hostname', GITHUB_HOST]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PreconditionError(
      `gh could not configure git to use its token for ${GITHUB_HOST}. ` +
        `Run it by hand and check the output: gh auth setup-git --hostname ${GITHUB_HOST}\n${detail}`,
    );
  }

  options.hooks?.onProgress?.(`git authenticates to ${GITHUB_HOST} through gh`);
  return { slug };
}

export interface CheckoutOptions {
  deployRoot: string;
  runCommand: typeof runCommand;
  hooks?: DeployHooks | undefined;
  /** The run journal's redactor. See `GitHubAuthOptions.redact` (issue #156). */
  redact?: Redactor | undefined;
  /** Discard uncommitted local modifications instead of refusing. */
  force?: boolean | undefined;
  /** How long a clone or fetch may take; `status` bounds it, a deploy does not. */
  fetchTimeoutMs?: number | undefined;
  /**
   * Refuse rather than clone when there is no checkout yet. `status` asks
   * "how far behind is what is deployed" and must not create a clone to
   * answer it.
   */
  requireExisting?: boolean | undefined;
}

export interface FetchResult {
  path: string;
  /** The commit the target's ref resolves to, after the fetch. */
  resolved: string;
  /** The checkout's HEAD before anything moved; undefined on a first clone. */
  previousSha: string | undefined;
  /** True when this call created the clone. */
  cloned: boolean;
}

export interface CheckoutResult {
  /** The commit before this call moved anything; undefined on a first clone. */
  previousSha: string | undefined;
  sha: string;
  changed: boolean;
  path: string;
}

/**
 * Clones or fetches, and resolves the ref - WITHOUT moving the checkout.
 *
 * The first half of `ensureCheckout`, on its own so that `update --check`
 * (#123) can answer "what would an update bring" while the clone stays at
 * the deployed commit: a checkout that moved HEAD would change what the next
 * `docker compose build` builds and what deploy-info reports as the deployed
 * version, for a command whose whole promise is that it changes nothing.
 */
export async function fetchRemote(
  target: RepoTarget,
  options: CheckoutOptions,
): Promise<FetchResult> {
  const path = join(options.deployRoot, 'repo');
  const scoped = { cwd: path, runCommand: options.runCommand };
  const exists = existsSync(join(path, '.git'));

  if (!exists) {
    if (options.requireExisting === true) {
      throw new UsageError(`There is no checkout at ${path} to compare against.`);
    }
    options.hooks?.onProgress?.(`Cloning ${displayRepoUrl(target.url)}`);
    await runGit(options, options.deployRoot, [
      'clone',
      '--no-checkout',
      target.url,
      path,
    ]);
  } else {
    options.hooks?.onProgress?.('Fetching');
    await runGit(options, path, ['fetch', '--tags', '--prune', 'origin']);
  }

  const previousSha = exists ? await git(scoped, ['rev-parse', 'HEAD']) : undefined;

  const resolved = await resolveRef(scoped, target.ref);
  if (resolved === undefined) {
    throw new UsageError(
      `\`${target.ref}\` is not a branch, tag or commit in ${displayRepoUrl(target.url)}.`,
    );
  }

  return { path, resolved, previousSha, cloned: !exists };
}

export interface RevisionComparison {
  /** `git rev-list --count <from>..<to>`. */
  commitsBehind: number;
  /** The newest 50 non-merge commits in that range, newest first. */
  commits: { sha: string; subject: string }[];
}

/** Commits the deployed revision does not have yet. Empty when they are the same. */
export async function compareRevisions(
  scoped: { cwd: string; runCommand: typeof runCommand },
  from: string,
  to: string,
): Promise<RevisionComparison> {
  if (from === to) return { commitsBehind: 0, commits: [] };

  const range = `${from}..${to}`;
  const run = (args: readonly string[]) =>
    scoped.runCommand(['git', ...args], { cwd: scoped.cwd, timeoutMs: 60_000 });

  const count = (await run(['rev-list', '--count', range])).stdout.trim();
  const commitsBehind = Number(count);
  if (!Number.isInteger(commitsBehind)) {
    throw new Error(`git rev-list --count ${range} answered \`${count}\`, not a number`);
  }

  // argv only - no shell, so `--max-count` rather than a pipe into head.
  const log = await run(['log', '--no-merges', '--format=%h%x09%s', '--max-count=50', range]);
  const commits = log.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab === -1
        ? { sha: line.trim(), subject: '' }
        : { sha: line.slice(0, tab).trim(), subject: line.slice(tab + 1).trim() };
    });

  return { commitsBehind, commits };
}

/**
 * Clones or updates the checkout, idempotently.
 *
 * The same call performs a first install and every later update, which is what
 * lets #180 and #182 share it rather than each doing half of it differently.
 * A caller that has already run `fetchRemote` (update's `fetch` step, which
 * compares revisions before it moves anything) passes the result so the
 * remote is not fetched twice.
 */
export async function ensureCheckout(
  target: RepoTarget,
  options: CheckoutOptions & { fetched?: FetchResult | undefined },
): Promise<CheckoutResult> {
  const fetched = options.fetched ?? (await fetchRemote(target, options));
  const { path, resolved, previousSha } = fetched;
  const scoped = { cwd: path, runCommand: options.runCommand };
  const exists = !fetched.cloned;

  if (exists && options.force !== true) {
    const dirty = await git(scoped, ['status', '--porcelain']);
    if (dirty !== undefined && dirty !== '') {
      // Someone hand-patched a file on the server. Resetting over it silently
      // is how a fix disappears and nobody knows why the bug came back.
      throw new UsageError(
        `The checkout at ${path} has uncommitted changes:\n` +
          dirty
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n') +
          `\nCommit or remove them, or re-run with --force to discard them.`,
      );
    }
  }

  // A hard reset rather than a merge: a deployed checkout is not a development
  // tree, and a merge conflict on a server is worse than a discarded local
  // change that --force already had to allow.
  await runGit(options, path, ['checkout', '--force', '--detach', resolved]);

  const sha = (await git(scoped, ['rev-parse', 'HEAD'])) ?? resolved;

  return {
    previousSha,
    sha,
    changed: previousSha !== sha,
    path,
  };
}

/** Resolves a branch, tag or SHA to a commit, preferring the remote branch. */
async function resolveRef(
  scoped: { cwd: string; runCommand: typeof runCommand },
  ref: string,
): Promise<string | undefined> {
  for (const candidate of [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, ref]) {
    const sha = await git(scoped, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (sha !== undefined && sha !== '') return sha;
  }
  return undefined;
}

/** Runs git, turning an auth failure into something an operator can act on. */
async function runGit(
  options: CheckoutOptions,
  cwd: string,
  args: readonly string[],
): Promise<void> {
  try {
    const result = await options.runCommand(['git', ...args], {
      cwd,
      timeoutMs: options.fetchTimeoutMs ?? 15 * 60_000,
      ...(options.redact === undefined ? {} : { redact: options.redact }),
      ...(options.hooks?.onLog === undefined
        ? {}
        : { onLine: (line: string) => options.hooks?.onLog?.(line) }),
    });
    void result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // The most common first-install failure by a wide margin, and the raw git
    // output does not say what to do about it. On this server the credential
    // is the GitHub CLI (#123): log in, hand git its token, and the next
    // install or update repeats the second step itself.
    if (/authentication|permission denied|could not read Username|publickey/i.test(message)) {
      throw new UsageError(
        `git could not authenticate to the repository. Run \`gh auth login\`, then \`gh auth setup-git\` — ${CLI_NAME} runs the second one for you on the next install or update. A repository that is not on GitHub needs read access some other way (a deploy key, or an https URL with a credential helper).\n${message}`,
      );
    }
    throw error;
  }
}
