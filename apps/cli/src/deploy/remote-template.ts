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
// names any repository, and a `kvox` built from one fork can deploy another.
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
// WHY A FAILURE IS NEVER FATAL
//
// This is an optimisation of correctness, not a precondition. A server behind
// a proxy, a rate-limited token, a fork whose remote is not GitHub — each must
// still be able to install. Every path here answers `undefined` rather than
// throwing, and the caller falls back to the local template.
// =============================================================================

import { githubSlug } from './repo.js';
import { runCommand as defaultRunCommand } from './executor.js';

/** Where the environment template lives inside the repository. */
export const TEMPLATE_PATH = 'infra/compose/.env.example';

/** How long to wait for the fetch before giving up and using a local copy. */
const FETCH_TIMEOUT_MS = 15_000;

/** Where a resolved template came from, for the operator to see. */
export type TemplateSource = 'remote' | 'local' | 'none';

export interface RemoteTemplateRequest {
  /** The repository URL, as `resolveRepoTarget` produced it. */
  repoUrl: string;
  /** Branch, tag or sha. */
  ref: string;
  runCommand?: typeof defaultRunCommand;
}

/**
 * The repository's `.env.example` at `ref`, or `undefined`.
 *
 * `undefined` covers every failure deliberately: a non-GitHub remote, a
 * missing `gh`, a logged-out `gh`, a repository the token cannot see, a ref
 * that does not exist, a path that does not exist in that repo, a timeout.
 * None of them is worth an error the operator has to dismiss — each simply
 * means "ask the local template instead".
 */
export async function fetchRemoteTemplate(
  request: RemoteTemplateRequest,
): Promise<string | undefined> {
  const slug = githubSlug(request.repoUrl);
  // A remote that is not on GitHub is not a failure, it is out of scope: the
  // `github` doctor group stands down for one too, and it is deployed with
  // plain git. There is no generic "fetch one file" API across forges to
  // reach for here.
  if (slug === null) return undefined;

  const ref = request.ref.trim();
  if (ref === '') return undefined;

  const run = request.runCommand ?? defaultRunCommand;

  // The raw media type returns the file's bytes directly, so nothing here has
  // to know about the contents API's base64-in-JSON envelope — and a file too
  // large for that envelope would still come back correctly.
  const argv = [
    'gh',
    'api',
    '-H',
    'Accept: application/vnd.github.raw',
    `repos/${slug}/contents/${TEMPLATE_PATH}?ref=${encodeURIComponent(ref)}`,
  ];

  try {
    const result = await run(argv, { cwd: process.cwd(), timeoutMs: FETCH_TIMEOUT_MS });
    if (result.exitCode !== 0) return undefined;
    const contents = result.stdout;
    // An empty file is indistinguishable from a silent failure here, and an
    // empty template would produce a wizard with no questions — which reads
    // as "this repo declares nothing" rather than "the fetch did not work".
    return contents.trim() === '' ? undefined : contents;
  } catch {
    return undefined;
  }
}
