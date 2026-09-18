import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { UsageError } from '../errors.js';
import { canPrompt, prompt, type PromptContext } from '../prompt.js';
import {
  APP_VERSION_KEY,
  LOCKFILE,
  VERSIONED_MANIFESTS,
  VERSIONED_WORKSPACES,
  currentAppVersion,
  readVersionSources,
  setLockfileWorkspaceVersion,
  setManifestVersion,
  suggestBump,
  validateAppVersion,
} from './app-version.js';
import { readEnvFile, writeEnvFile } from './env-file.js';
import { parseEnvExample, serializeEnvFile } from './env-spec.js';
import type { runCommand } from './executor.js';
import type { DeployHooks } from './hooks.js';
import type { Journal } from './journal.js';

// =============================================================================
// The `version` and `publish-version` pipeline steps  (issue #295, epic #168)
// =============================================================================
//
// Shared by `install` and `update` rather than written twice, the same reason
// `ensureCheckout` is shared: two copies of a sequence that commits to a
// repository is two places for the ordering rules below to drift.
//
// -----------------------------------------------------------------------------
// THE ONE INVARIANT EVERYTHING ELSE FOLLOWS FROM
// -----------------------------------------------------------------------------
//
//   AT THE END OF EVERY RUN, THE CLONE'S HEAD IS THE COMMIT `origin/<ref>`
//   RESOLVES TO — either because the bump commit BECAME that commit (the push
//   succeeded), or because the bump commit was discarded (it did not).
//
// That invariant is not tidiness, it is what keeps the NEXT deploy correct,
// and it was derived from what `ensureCheckout` actually does today rather
// than assumed. Three facts about it, all verified against real git:
//
//   1. IT REFUSES A DIRTY TREE (`git status --porcelain`) with a UsageError
//      telling the operator to commit, remove or `--force`. So a run that
//      wrote `package.json` and then died at `build` — an OOM kill, a lost
//      network, a power cut — would WEDGE the next `update` behind a refusal
//      about files the operator never touched. That is why this step COMMITS
//      immediately, in the same step as the write, instead of leaving the tree
//      dirty until the publish: the dirty window is milliseconds rather than
//      the length of a build.
//   2. IT ALWAYS `checkout --force --detach`es. The deployed clone is
//      PERMANENTLY in detached HEAD, on every deployment, normally. So
//      "publish only when HEAD is attached to a branch" — the obvious reading
//      of issue #295's hazard 4 — would skip the publish on every deployment
//      that ever existed. The real question is whether the TARGET REF names a
//      branch on origin, and the push is an explicit `HEAD:refs/heads/<ref>`.
//   3. A LOCAL-ONLY COMMIT IS NOT A WEDGE. `checkout --force --detach` moves
//      over it with a "you are leaving 1 commit behind" warning and a clean
//      tree. So the fallback for anything this module fails to clean up is
//      self-healing on the next deploy; the rollback below exists to keep the
//      next `update --check` HONEST, not to prevent a jam.
//
// Without the rollback, a failed push leaves the clone permanently one commit
// ahead of origin, and every later `update` then reports "1 commit behind" in
// reverse, sees `changed: true`, and rebuilds byte-identical images forever.
// =============================================================================

export interface VersionPlan {
  /** What the bump was measured from: the highest of the clone and the `.env`. */
  previous: string;
  /** The version now written into the manifests, the lockfile and the `.env`. */
  next: string;
  /** Where the number came from, for the journal and the summary. */
  source: 'flag' | 'prompt' | 'suggested';
  /** HEAD before the bump commit — the commit this deployment was built from. */
  baseSha: string;
  /** The bump commit. */
  commitSha: string;
  /**
   * The origin BRANCH this may be published to, or undefined when the deploy
   * target is a tag or a bare SHA and there is nothing to push to.
   */
  branch: string | undefined;
}

export interface VersionStepIo {
  deployRoot: string;
  /** The ref being deployed, from the resolved `RepoTarget`. */
  ref: string;
  command: 'install' | 'update';
  runCommand: typeof runCommand;
  journal: Journal;
  hooks?: DeployHooks | undefined;
  /** The pipeline's in-memory `.env`, kept in step with the file. */
  env?: Map<string, string> | undefined;
  /** `--app-version`: explicit, and it wins over everything. */
  appVersion?: string | undefined;
  /** `--no-version-bump` sets this false. */
  versionBump?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  promptContext?: PromptContext | undefined;
}

/** The clone. */
function repoPath(deployRoot: string): string {
  return join(deployRoot, 'repo');
}

/** Where `.env.example` lives, the same path `install.ts`'s `composeCwd` builds. */
function composeDir(deployRoot: string): string {
  return join(deployRoot, 'repo', 'infra', 'compose');
}

async function git(io: VersionStepIo, args: readonly string[]): Promise<string> {
  const result = await io.runCommand(['git', ...args], {
    cwd: repoPath(io.deployRoot),
    timeoutMs: 120_000,
    redact: io.journal.redact,
    ...(io.hooks?.onLog === undefined
      ? {}
      : { onLine: (line: string) => io.hooks?.onLog?.(line) }),
  });
  io.journal.command(result);
  return result.stdout.trim();
}

/** Runs git and answers undefined rather than throwing. For probes only. */
async function gitQuiet(io: VersionStepIo, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await io.runCommand(['git', ...args], {
      cwd: repoPath(io.deployRoot),
      timeoutMs: 60_000,
      redact: io.journal.redact,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * The branch on origin this ref names, or undefined.
 *
 * The same preference order `repo.ts`'s `resolveRef` applies (a remote branch
 * first), so "did we deploy a branch?" is answered the same way "what did we
 * deploy?" was. A tag or a bare SHA answers undefined and is never guessed at:
 * inventing a branch to push to is how a deploy pinned to `v1.4.0` moves
 * `main`.
 */
async function originBranchFor(io: VersionStepIo): Promise<string | undefined> {
  const resolved = await gitQuiet(io, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${io.ref}^{commit}`,
  ]);
  return resolved === undefined || resolved === '' ? undefined : io.ref;
}

/**
 * Decides the version, writes it everywhere, and commits — as one step.
 *
 * Returns undefined when this run is not versioning at all, having already
 * said why through the journal.
 */
export async function runVersionStep(io: VersionStepIo): Promise<VersionPlan | undefined> {
  const clone = repoPath(io.deployRoot);
  const env = io.env ?? readEnvFile(io.deployRoot);
  const sources = readVersionSources(clone, env);
  const previous = currentAppVersion(sources);
  const suggestion = suggestBump(previous);

  const chosen = await chooseVersion(io, previous, suggestion);
  if (chosen === undefined) return undefined;

  io.journal.line(`Version ${previous} -> ${chosen.next} (${chosen.source})`);
  io.hooks?.onProgress?.(`Application version ${chosen.next}`);

  const baseSha = await git(io, ['rev-parse', 'HEAD']);

  const touched = writeVersionFiles(clone, chosen.next);
  writeAppVersionToEnv(io, chosen.next);

  if (touched.length === 0) {
    // A fork whose manifests this CLI does not recognise, or a clone that does
    // not carry them at all. The deployment still gets its number — the `.env`
    // above is what `resolveApiVersion()` reads — but there is nothing to
    // commit, and `git commit` with an empty index FAILS, which would take an
    // otherwise fine deploy down over a file that was never there.
    io.journal.line(
      'No package manifests in the clone to version; APP_VERSION is set and nothing is published.',
    );
    return undefined;
  }

  // Committed in this step, not in the publish. See the header: leaving the
  // tree dirty across the build is what wedges the next `update`.
  await git(io, ['add', '--', ...touched]);
  await git(io, [
    // An identity of this tool's own, never the host's. The commit is made by
    // a deploy, not by whoever happened to be logged in, and a server with no
    // `user.email` configured — the ordinary case — cannot commit at all
    // without this.
    '-c',
    `user.name=${CLI_NAME} deploy`,
    '-c',
    `user.email=${CLI_NAME}@localhost`,
    'commit',
    '--no-verify',
    '-m',
    `chore(release): v${chosen.next}`,
    '-m',
    `Set by \`${CLI_NAME} deploy ${io.command}\` on ${hostname()}.`,
  ]);

  const commitSha = await git(io, ['rev-parse', 'HEAD']);
  const branch = await originBranchFor(io);

  return { previous, next: chosen.next, source: chosen.source, baseSha, commitSha, branch };
}

/**
 * The number, and where it came from.
 *
 * `--non-interactive` TAKES THE SUGGESTION rather than refusing, and this was
 * decided deliberately (issue #295 §3):
 *
 *   - REFUSING WOULD BREAK EVERY UNATTENDED DEPLOY, including
 *     `.github/workflows/deploy-e2e.yml`, which runs `deploy update
 *     --non-interactive` twice, and any operator running update from cron.
 *     Every one of them would have to learn a new mandatory flag to keep
 *     working, for a question that has a correct default.
 *   - THE SUGGESTION IS THE RIGHT DEFAULT, not merely a convenient one. A
 *     patch bump is exactly what "we deployed the next revision" means; the
 *     interesting cases (a minor for a feature, a major for a break) are
 *     precisely the ones a human is present for and types.
 *   - IT CANNOT MOVE THE NUMBER BACKWARDS. The suggestion is derived from the
 *     current version, so the monotonicity rule this module enforces is
 *     satisfied by construction on the unattended path.
 *   - AND IT IS SAYABLE. `--no-version-bump` is the way an automated caller
 *     opts out, which is a positive statement in the invocation rather than a
 *     silent behaviour difference.
 *
 * A terminal with no `--app-version` is asked, with the suggestion offered as
 * the empty-answer default. An invalid answer re-asks rather than failing the
 * deploy: the operator is standing there, and a typo should not cost a re-run.
 */
async function chooseVersion(
  io: VersionStepIo,
  previous: string,
  suggestion: string,
): Promise<{ next: string; source: VersionPlan['source'] } | undefined> {
  if (io.versionBump === false) {
    // Nothing is written, nothing is committed, nothing is published. The
    // deployment keeps whatever `APP_VERSION` it already had.
    io.journal.line(`Version left at ${previous} (--no-version-bump)`);
    io.hooks?.onProgress?.(`Application version unchanged at ${previous}`);
    return undefined;
  }

  if (io.appVersion !== undefined) {
    const refusal = validateAppVersion(io.appVersion, previous);
    // A bad `--app-version` is a bad INVOCATION, so it stops the run rather
    // than falling back to the suggestion. Silently deploying a different
    // number from the one that was typed is the worst available outcome here.
    if (refusal !== undefined) throw new UsageError(`--app-version ${refusal}`);
    return { next: io.appVersion.trim(), source: 'flag' };
  }

  if (io.nonInteractive === true || !canPrompt(io.promptContext)) {
    io.journal.line(
      `Taking the suggested version ${suggestion} without asking ` +
        `(${io.nonInteractive === true ? '--non-interactive' : 'no interactive terminal'}); ` +
        `--app-version <semver> chooses another, --no-version-bump skips it.`,
    );
    return { next: suggestion, source: 'suggested' };
  }

  for (;;) {
    const answer = await prompt(
      `  Application version [${suggestion}] (current ${previous}): `,
      io.promptContext,
    );
    if (answer === '') return { next: suggestion, source: 'suggested' };

    const refusal = validateAppVersion(answer, previous);
    if (refusal === undefined) return { next: answer.trim(), source: 'prompt' };

    io.journal.line(`Rejected version \`${answer}\`: ${refusal}`);
    io.promptContext?.output?.write(`  ${refusal}\n`);
  }
}

/**
 * Writes the version into both manifests and the lockfile. Returns the paths
 * it changed, relative to the clone, for `git add`.
 *
 * BOTH MANIFESTS OR NEITHER (issue #295's "one shared version"): they ship as
 * one deployment from one commit, so a run that wrote one and threw on the
 * other would leave a repository claiming the API and the web app are
 * different releases. The two writes are prepared first and applied second,
 * so a manifest this CLI cannot edit fails before anything is on disk.
 */
export function writeVersionFiles(clone: string, version: string): string[] {
  const pending: { path: string; relative: string; contents: string }[] = [];

  for (const relative of VERSIONED_MANIFESTS) {
    const path = join(clone, relative);
    if (!existsSync(path)) continue;
    pending.push({
      path,
      relative,
      contents: setManifestVersion(readFileSync(path, 'utf8'), version),
    });
  }

  const lockPath = join(clone, LOCKFILE);
  if (existsSync(lockPath)) {
    let contents = readFileSync(lockPath, 'utf8');
    for (const workspace of VERSIONED_WORKSPACES) {
      contents = setLockfileWorkspaceVersion(contents, workspace, version);
    }
    pending.push({ path: lockPath, relative: LOCKFILE, contents });
  }

  for (const file of pending) writeFileSync(file.path, file.contents);
  return pending.map((file) => file.relative);
}

/**
 * Sets `APP_VERSION` in the deployment's `.env`.
 *
 * ⚠ THROUGH `serializeEnvFile` WITH THE WHOLE TEMPLATE, which is #291's
 * serialization trap stated as a rule: the writer needs the FULL spec list or
 * it strips every section banner and the template's key order from the file
 * and declares seventy-odd template variables to be a fork's own additions.
 * Appending a line by hand would be worse still — it would survive exactly
 * until the next run of the drift step rewrote the file without it.
 *
 * `APP_VERSION` IS DELIBERATELY NOT IN `infra/compose/.env.example`, and that
 * is not an omission. `.env.example` IS the wizard's question list
 * (`env-spec.ts`), so an entry there becomes a question the operator is asked
 * — and the whole point of this feature is that the CLI chooses this value.
 * A commented `# APP_VERSION=` entry would be worse, not better: CLAUDE.md
 * records that `parseEnvExample` reads any commented `# KEY=value` line as
 * declaring an OPTIONAL VARIABLE. `DEPLOY_ROOT` and `COMPOSE_PROJECT_NAME`
 * are the existing precedent — both written by this CLI, both absent from the
 * template — and `serializeEnvFile` already carries such keys through under
 * its own "Not in .env.example" banner rather than dropping them.
 */
export function writeAppVersionToEnv(io: VersionStepIo, version: string): void {
  const templatePath = join(composeDir(io.deployRoot), '.env.example');
  const current = io.env ?? readEnvFile(io.deployRoot);

  if (current === undefined) {
    io.journal.line(`No .env at ${io.deployRoot}; ${APP_VERSION_KEY} not set.`);
    return;
  }
  if (!existsSync(templatePath)) {
    io.journal.line(`No .env.example in the clone; ${APP_VERSION_KEY} not set.`);
    return;
  }

  const specs = parseEnvExample(readFileSync(templatePath, 'utf8'));
  current.set(APP_VERSION_KEY, version);
  writeEnvFile(io.deployRoot, serializeEnvFile(current, specs));
  // Kept in step so a later step reading `context.env` sees what is on disk.
  io.env?.set(APP_VERSION_KEY, version);
  io.journal.line(`Set ${APP_VERSION_KEY}=${version} in the deployment's .env`);
}

export interface VersionPublish {
  published: boolean;
  /** Why not, when `published` is false. Always set in that case. */
  reason?: string | undefined;
  /** Operator-facing text for the run's `warnings`, when there is something to say. */
  warning?: string | undefined;
}

/**
 * Pushes the bump commit to the deployed branch — or rolls it back out.
 *
 * ⚠ ONLY EVER CALLED AFTER `health` HAS PASSED. That is issue #295's gate, and
 * it is #283's gate for `deploy-info` for the same reason: a deploy that
 * failed at `build` or `migrate` must leave the repository untouched, because
 * a version published for a release that never ran is a number nobody can
 * interpret afterwards.
 *
 * ⚠ A FAILED PUSH MUST NOT FAIL THE DEPLOY. By the time this runs the
 * application is built, migrated, started and answering. This follows #265's
 * `/etc/cron.d` EACCES precedent exactly: record it, carry it in the run's
 * `warnings`, surface it on the summary — never fail a finished deployment
 * over bookkeeping.
 *
 * ⚠ NEVER `--force`, AND NEVER A RETRY. Issue #295's hazard 2 leaves the
 * race open ("fetch and retry once, or warn and stop"); this warns and stops,
 * and the reason is specific rather than conservative. Retrying means
 * re-committing the bump on top of whatever origin moved to — but the
 * deployment was BUILT from the old tip, so the published commit's tree would
 * contain code this server never built, and `deploy-info`'s `commitSha` would
 * name a commit whose content nobody deployed. Rebasing a version bump is a
 * code change wearing a bookkeeping retry's clothes. The next deploy fetches
 * the newer commit, builds it, and carries the version forward then — which
 * is the honest ordering.
 *
 * The same degradation covers hazard 4 (a tag or a SHA: no branch to push to)
 * and hazard 5 (a fork with no push access: the push fails on permissions).
 * Credentials are whatever the `auth` step already put in git's config
 * through `gh auth setup-git`; nothing here handles a token, reads one, or
 * writes one anywhere.
 */
export async function publishVersion(
  io: VersionStepIo,
  plan: VersionPlan,
): Promise<VersionPublish> {
  if (plan.branch === undefined) {
    return await declinePublish(
      io,
      plan,
      `\`${io.ref}\` is not a branch on origin (it is a tag or a commit), so there is nowhere to publish v${plan.next} to.`,
    );
  }

  const ahead = await gitQuiet(io, ['rev-list', '--count', `origin/${plan.branch}..HEAD`]);
  if (ahead === '0') {
    // Nothing to send. Not an error and not worth a warning: the number is in
    // the image, the `.env` and deploy-info regardless.
    io.journal.line(`origin/${plan.branch} already carries this commit; nothing to publish.`);
    return { published: false, reason: 'already published' };
  }

  try {
    await git(io, ['push', 'origin', `HEAD:refs/heads/${plan.branch}`]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return await declinePublish(
      io,
      plan,
      `Could not push v${plan.next} to origin/${plan.branch}.\n${detail}`,
    );
  }

  io.journal.line(`Published v${plan.next} as ${plan.commitSha} on origin/${plan.branch}`);
  io.hooks?.onProgress?.(`Published v${plan.next} to origin/${plan.branch}`);
  return { published: true };
}

/**
 * Records why the version was not published and takes the bump commit back
 * out of the clone, restoring the invariant in this file's header.
 *
 * The deployment is NOT rolled back with it: it is running, and it is running
 * `plan.next`. That number stays in the `.env`, in the built image and in
 * deploy-info — which is exactly why `currentAppVersion` takes the `.env` into
 * its maximum, so the next deploy measures its bump from what is deployed
 * rather than from the number the repository was left holding.
 */
async function declinePublish(
  io: VersionStepIo,
  plan: VersionPlan,
  reason: string,
): Promise<VersionPublish> {
  io.journal.line(reason);

  const restored = await gitQuiet(io, ['checkout', '--force', '--detach', plan.baseSha]);
  if (restored === undefined) {
    // Nothing is broken by this: `ensureCheckout` moves over a local-only
    // commit on the next deploy anyway (see the header, fact 3). It only means
    // the next `update --check` will report this clone as differing from
    // origin until then, so it is said out loud rather than swallowed.
    io.journal.line(
      `Could not restore the clone to ${plan.baseSha}; the next update will move past the local commit.`,
    );
  } else {
    io.journal.line(`Restored the clone to ${plan.baseSha}; the version bump is not in the repository.`);
  }

  return {
    published: false,
    reason,
    warning:
      `The deployment is running v${plan.next}, but the version was not published to the repository.\n` +
      `${reason}\n` +
      `Nothing is broken: the number is in this server's .env, its images and its deploy-info record,\n` +
      `and the clone was restored so the next update is unaffected. To record it in the repository,\n` +
      `set the version in apps/api/package.json and apps/web/package.json yourself and commit it.`,
  };
}
