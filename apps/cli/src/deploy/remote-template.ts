// =============================================================================
// The environment template, read from the REMOTE repository  (issue #230)
// =============================================================================
//
// WHY THIS EXISTS AT ALL
//
// The install wizard has to know which variables to ask about BEFORE the
// pipeline's `checkout` step has cloned anything: the questions are the whole
// point of the wizard, and it runs first. On a first install there is no clone
// on the server to read, so the TUI fell back to whatever `.env.example` it
// could find on local disk.
//
// That fallback is correct only when the checkout the CLI is running from and
// the repository being deployed are the same thing. They need not be: `--repo`
// names any repository, and this CLI built from one fork can deploy another.
// Reading the file from the REMOTE, at the resolved ref, makes the questions
// right by construction instead of by coincidence.
//
// WHY `gh api` AND NOT A PLAIN HTTPS FETCH
//
// The repository being deployed is usually private — that is the ordinary case
// for a fork of this template — and `gh`'s stored token is the credential the
// deploy pipeline already requires and already uses to clone (the
// `gh-authenticated` / `gh-repo-access` doctor checks, and `gh auth setup-git`
// in the `auth` step). Fetching one small text file through the same
// credential adds no new secret, no new configuration, and no second auth
// path that could be authorised differently from the clone that follows.
//
// WHY A FAILURE IS NEVER FATAL, AND WHY IT IS NO LONGER SILENT  (issue #236)
//
// This is an optimisation of correctness, not a precondition. A server behind
// a proxy, a rate-limited token, a fork whose remote is not GitHub — each must
// still be able to install. So nothing here throws, and the caller falls back
// to a template on local disk.
//
// But the first version answered a bare `undefined` for every one of those
// paths, and that turned out to be the defect rather than the design. The
// authentication `gh` carries is PER USER, and the installer deliberately
// supports running as root (#226): a root shell whose `gh` has never been
// logged in fails here exactly like a repository the token cannot see, like a
// `gh` that is not installed, and like a timeout. An operator staring at a
// wizard with no questions in it could not tell those four apart, and neither
// could anyone reading a bug report about it.
//
// So every path now answers a REASON, and the reason carries the command's own
// first line of stderr — which is where `gh` writes "To get started ... please
// run: gh auth login". Never fatal, never silent.
// =============================================================================

import { githubSlug } from './repo.js';
import { CommandFailedError } from './executor.js';
import { runCommand as defaultRunCommand } from './executor.js';

/** Where the environment template lives inside the repository. */
export const TEMPLATE_PATH = 'infra/compose/.env.example';

/** How long to wait for the fetch before giving up and using a local copy. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Where a resolved template came from, for the operator to see.
 *
 * `bundled` is the copy the installer saved beside the CLI (#236) — the
 * repository's own file, at the commit this CLI was built from.
 */
export type TemplateSource = 'remote' | 'local' | 'bundled' | 'none';

/**
 * Why a remote read did not produce a template.
 *
 * Each member is a DIFFERENT thing for an operator to do, which is the whole
 * reason they are distinguished: install the tool, log it in, grant it access
 * to the repository, check the network, or nothing at all.
 */
export type RemoteTemplateFailure =
  /** The remote is not on GitHub, so there is no contents API to ask. */
  | 'not-github'
  /** `gh` is not installed, or not on this user's PATH. */
  | 'gh-missing'
  /** `gh` ran and refused: logged out, no access, no such ref or path. */
  | 'gh-failed'
  /** `gh` did not answer in time. */
  | 'timed-out'
  /** The file exists and is empty, which no wizard can ask questions from. */
  | 'empty';

export type RemoteTemplateResult =
  | { readonly ok: true; readonly contents: string }
  | {
      readonly ok: false;
      readonly reason: RemoteTemplateFailure;
      /** The command's own first line of stderr, when it produced one. */
      readonly detail?: string | undefined;
    };

export interface RemoteTemplateRequest {
  /** The repository URL, as `resolveRepoTarget` produced it. */
  repoUrl: string;
  /**
   * Branch, tag or sha — or EMPTY for the repository's default branch.
   *
   * Empty is the ordinary case, not a missing value (#234): an operator who
   * does not pin a ref is deploying the default branch, and the Review screen
   * renders exactly that as "(default branch)". Treating empty as "cannot
   * fetch" turned the most common first install into the one case that never
   * read the template.
   */
  ref?: string | undefined;
  runCommand?: typeof defaultRunCommand;
}

/** The first non-blank line of a command's stderr, trimmed and bounded. */
function firstStderrLine(stderr: string): string | undefined {
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.slice(0, 200);
  }
  return undefined;
}

/**
 * The repository's `.env.example` at `ref`, or a reason it could not be read.
 *
 * Never throws and never blocks an install: a caller that cannot use the
 * answer falls back to a template on local disk. The reason exists so the
 * operator is told which of five different problems they actually have.
 */
export async function fetchRemoteTemplate(
  request: RemoteTemplateRequest,
): Promise<RemoteTemplateResult> {
  const slug = githubSlug(request.repoUrl);
  // A remote that is not on GitHub is not a failure, it is out of scope: the
  // `github` doctor group stands down for one too, and it is deployed with
  // plain git. There is no generic "fetch one file" API across forges to
  // reach for here.
  if (slug === null) return { ok: false, reason: 'not-github' };

  const ref = (request.ref ?? '').trim();
  const run = request.runCommand ?? defaultRunCommand;

  // The raw media type returns the file's bytes directly, so nothing here has
  // to know about the contents API's base64-in-JSON envelope — and a file too
  // large for that envelope would still come back correctly.
  const argv = [
    'gh',
    'api',
    '-H',
    'Accept: application/vnd.github.raw',
    // No ref: omit the query parameter entirely rather than sending an empty
    // one. GitHub's contents API then serves the repository's own default
    // branch, which is precisely what an unpinned deployment means — and it
    // needs no second call to discover what that branch is called.
    ref === ''
      ? `repos/${slug}/contents/${TEMPLATE_PATH}`
      : `repos/${slug}/contents/${TEMPLATE_PATH}?ref=${encodeURIComponent(ref)}`,
  ];

  try {
    const result = await run(argv, { cwd: process.cwd(), timeoutMs: FETCH_TIMEOUT_MS });
    // `runCommand` normally REJECTS on a non-zero exit, so this is belt and
    // braces rather than the live path — but a caller that passes its own
    // runner (the tests, and any future one using `allowExitCodes`) can hand
    // a failure back as a value, and reading its stdout as a template would
    // be strictly wrong.
    if (result.exitCode !== 0) {
      const detail = firstStderrLine(result.stderr);
      return detail === undefined
        ? { ok: false, reason: result.timedOut ? 'timed-out' : 'gh-failed' }
        : { ok: false, reason: result.timedOut ? 'timed-out' : 'gh-failed', detail };
    }
    const contents = result.stdout;
    // An empty file is indistinguishable from a silent failure here, and an
    // empty template would produce a wizard with no questions — which reads
    // as "this repo declares nothing" rather than "the fetch did not work".
    if (contents.trim() === '') return { ok: false, reason: 'empty' };
    return { ok: true, contents };
  } catch (error) {
    // `runCommand` REJECTS on a non-zero exit rather than returning the code,
    // and attaches the result to the error — so this branch, not a returned
    // exit code, is where a logged-out `gh` actually lands.
    if (error instanceof CommandFailedError) {
      const { result } = error;
      if (result.timedOut) return { ok: false, reason: 'timed-out' };
      // A spawn that never started reports -1 with the ENOENT message as the
      // error itself; there is no stderr to quote in that case.
      if (result.exitCode === -1 && result.stderr.trim() === '') {
        return { ok: false, reason: 'gh-missing', detail: error.message };
      }
      const detail = firstStderrLine(result.stderr);
      return detail === undefined
        ? { ok: false, reason: 'gh-failed' }
        : { ok: false, reason: 'gh-failed', detail };
    }
    return { ok: false, reason: 'gh-failed' };
  }
}

/** One line of operator-facing English for a failure. */
export function describeRemoteTemplateFailure(
  failure: Extract<RemoteTemplateResult, { ok: false }>,
): string {
  const detail = failure.detail === undefined ? '' : ` (${failure.detail})`;
  switch (failure.reason) {
    case 'not-github':
      return 'the repository is not hosted on GitHub, so its template cannot be read remotely';
    case 'gh-missing':
      return `the GitHub CLI is not installed or not on this user's PATH${detail}`;
    case 'gh-failed':
      return `the GitHub CLI could not read it — it is per-user, so check \`gh auth status\` as the user running this${detail}`;
    case 'timed-out':
      return 'the GitHub CLI did not answer in time';
    case 'empty':
      return 'the repository’s template file is empty';
  }
}
