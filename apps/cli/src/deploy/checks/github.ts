import { probe } from './probe.js';
import type { Check, CheckContext, CheckResult } from './types.js';

// =============================================================================
// Can this server reach the repository through the GitHub CLI?  (issue #122, epic #118)
// =============================================================================
//
// The owner's decision (epic #118, decision 1): GitHub authentication on the
// server is `gh`, only. Install runs `gh auth setup-git` (#123) so that plain
// git clones and fetches a PRIVATE repository over HTTPS with gh's token, and
// there is no SSH-key handling anywhere in this CLI. So `gh` installed and
// logged in are REQUIRED prerequisites, not advice - without them the clone
// step fails with a git prompt for a password that no longer exists.
//
// The three checks are a chain: no point asking about login without the
// binary, or about the repository without a login. Each names the exact
// command that fixes it.
//
// A repository that is not on github.com is not a failure. A fork hosted
// elsewhere falls back to plain git (decision 1 again) and `gh-repo-access`
// says so with a `skip`. `--skip-github` exists for CI's `file://` remote and
// skips all three.
// =============================================================================

const GITHUB_HOST = 'github.com';

/** The remedy for a missing binary: GitHub's own two apt lines, condensed. */
const INSTALL_REMEDY =
  'Install the GitHub CLI: ' +
  'mkdir -p -m 755 /etc/apt/keyrings && ' +
  `curl -fsSL https://cli.${GITHUB_HOST}/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && ` +
  `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.${GITHUB_HOST}/packages stable main" > /etc/apt/sources.list.d/github-cli.list; ` +
  'then: apt update && apt install gh';

const SKIPPED: CheckResult = { status: 'skip', detail: '--skip-github' };

function skipped(context: CheckContext): CheckResult | undefined {
  return context.skipGithub === true ? SKIPPED : undefined;
}

/**
 * `owner/name` from a GitHub remote URL, in any of the schemes git accepts.
 *
 *   https://github.com/o/r.git      git@github.com:o/r.git
 *   ssh://git@github.com/o/r        https://token@github.com/o/r
 *
 * Undefined for anything else - a different forge, a `file://` remote, or a
 * URL this cannot read - and the caller reports that as `skip`, never as a
 * failure: not being on GitHub is a fact about the fork, not a fault.
 */
export function parseGithubRepo(url: string): { owner: string; name: string } | undefined {
  const trimmed = url.trim();

  // scp-like: git@github.com:owner/name(.git)
  const scp = /^(?:[^@/]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (scp !== null) return { owner: scp[1] ?? '', name: scp[2] ?? '' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return undefined;

  const [owner, name] = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (owner === undefined || owner === '' || name === undefined || name === '') return undefined;

  return { owner, name: name.replace(/\.git$/, '') };
}

const ghInstalled: Check = {
  id: 'gh-installed',
  title: 'GitHub CLI installed',
  severity: 'required',
  async run(context) {
    const skip = skipped(context);
    if (skip !== undefined) return skip;

    const { ok, stdout, stderr } = await probe(context, ['gh', '--version']);
    if (!ok) {
      return {
        status: 'fail',
        detail: stderr.split('\n')[0] ?? 'not installed',
        remedy: INSTALL_REMEDY,
      };
    }
    // "gh version 2.40.1 (2023-12-13)" - the first line is the one that matters.
    return { status: 'pass', detail: (stdout.split('\n')[0] ?? '').replace(/^gh version /, '') };
  },
};

const ghAuthenticated: Check = {
  id: 'gh-authenticated',
  title: 'GitHub CLI logged in',
  severity: 'required',
  requires: ['gh-installed'],
  async run(context) {
    const skip = skipped(context);
    if (skip !== undefined) return skip;

    // `gh auth status` exits 0 when logged in to at least one host, and has
    // printed its report on stderr in some versions and stdout in others.
    const { ok, stdout, stderr } = await probe(context, ['gh', 'auth', 'status']);
    const report = `${stdout}\n${stderr}`;

    if (ok) {
      const account = /Logged in to \S+ (?:account|as) (\S+)/i.exec(report)?.[1];
      return {
        status: 'pass',
        detail: account === undefined ? 'logged in' : `logged in as ${account.replace(/[()]/g, '')}`,
      };
    }

    return {
      status: 'fail',
      detail: report.split('\n').find((line) => /not logged|no.*account|token/i.test(line))?.trim() ?? 'not logged in',
      remedy:
        `Log in: gh auth login --hostname ${GITHUB_HOST} --git-protocol https ` +
        '(or, with a token you already have: gh auth login --with-token < token.txt).',
    };
  },
};

const ghRepoAccess: Check = {
  id: 'gh-repo-access',
  title: 'Repository visible to gh',
  severity: 'required',
  requires: ['gh-authenticated'],
  async run(context) {
    const skip = skipped(context);
    if (skip !== undefined) return skip;

    if (context.repoUrl === undefined) {
      return {
        status: 'skip',
        detail: 'no repository resolved (run inside a checkout, or after install)',
      };
    }

    const repo = parseGithubRepo(context.repoUrl);
    if (repo === undefined) {
      // Not a failure: a remote on another forge, or a local one, is deployed
      // with plain git and gh is never consulted for it.
      return { status: 'skip', detail: `${context.repoUrl} is not on ${GITHUB_HOST}; plain git will be used` };
    }

    const slug = `${repo.owner}/${repo.name}`;
    const { ok, stderr } = await probe(context, ['gh', 'repo', 'view', slug, '--json', 'name']);

    if (ok) return { status: 'pass', detail: slug };

    return {
      status: 'fail',
      detail: `the logged-in account cannot see ${slug}` + (stderr === '' ? '' : ` (${stderr.split('\n')[0] ?? ''})`),
      remedy:
        `Grant the account gh is logged in as (see: gh auth status) read access to ${slug}, ` +
        `or log in as one that has it: gh auth login --hostname ${GITHUB_HOST}`,
    };
  },
};

export const GITHUB_CHECKS: readonly Check[] = [ghInstalled, ghAuthenticated, ghRepoAccess];
