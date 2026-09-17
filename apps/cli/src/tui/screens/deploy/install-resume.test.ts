import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UsageError } from '../../../errors.js';
import { runInstall } from '../../../deploy/install.js';
import { envFilePath } from '../../../deploy/env-file.js';
import {
  DEPLOY_STATE_VERSION,
  deployStatePath,
  readState,
  writeState,
  type DeployState,
} from '../../../deploy/state.js';
import {
  fakeVps,
  healthyFetch,
  silentPrompt,
  type FakeVps,
} from '../../../deploy/testing/fake-vps.js';
import { DOMAIN_FIELD } from '../../../deploy/wizard/steps.js';
import { readDeployment } from './install.js';
import {
  INTERNAL_DEFAULTS,
  answerOf,
  applyPrefill,
  envAnswers,
  prefillFrom,
  resumePlan,
  type InstallAnswers,
  type ResumePlan,
} from './install-model.js';

// =============================================================================
// The install wizard resumes, and remembers  (issue #288)
// =============================================================================
//
// The screen told the operator three times that re-running install resumes
// from where the last run stopped — in `failedModel`'s action label, in the
// abort dialog and in `ABORTED_DETAIL` — while calling `runInstall` with no
// `resume` field at all, so `install.ts` built an empty `completed` set and
// all thirteen steps ran again, the four-minute `build` included. It also
// opened on `INTERNAL_DEFAULTS` and never read the deployment's own `.env`,
// so every question came up blank on the very re-run that copy recommended.
//
// WHY THIS FILE EXISTS BESIDE install.test.ts. That suite is pure by design
// (`ink-testing-library` is not a dependency, so a screen is tested through
// the data it derives), and the pure half of this fix — `resumePlan`,
// `prefillFrom`, `applyPrefill`, `environmentEdited` — is asserted there.
// What is asserted HERE is the half that only exists against a real
// filesystem: that `readDeployment` reads this deployment and never a
// neighbour's, that a file it cannot parse is treated as no file rather than
// as a crash, and — through `fakeVps` — that the flag the screen decides on
// actually lands the way `install.ts`'s own two guards expect. Those guards
// pull in opposite directions (`--resume` with no state is a refusal;
// `--resume` over a completed deployment WAIVES a refusal), so the decision
// is only worth as much as the end-to-end proof that it satisfies both.
// =============================================================================

const created: string[] = [];

function tempRoot(prefix = 'appctl-resume-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    const root = created.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/** A state file describing a run that stopped at `failedStep`. */
function failedState(root: string, completedSteps: string[], failedStep: string): DeployState {
  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/demo',
    ref: 'main',
    commitSha: 'c'.repeat(40),
    bindPort: 3535,
    deployRoot: root,
    domain: 'app.example.test',
    lastCommand: 'install',
    lastOutcome: 'failure',
    lastFailedStep: failedStep,
    completedSteps,
    appctlVersion: '1.6.1',
  };
  writeState(state);
  return state;
}

/** A state file describing a deployment that is up and serving. */
function deployedState(root: string): DeployState {
  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/demo',
    ref: 'main',
    commitSha: 'c'.repeat(40),
    bindPort: 3535,
    deployRoot: root,
    domain: 'app.example.test',
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-01T00:00:00.000Z',
    lastCommand: 'install',
    lastOutcome: 'success',
    completedSteps: ['preflight', 'checkout', 'environment', 'build'],
    appctlVersion: '1.6.1',
  };
  writeState(state);
  return state;
}

// -----------------------------------------------------------------------------
// readDeployment: this deployment's own folder, and nothing that can throw
// -----------------------------------------------------------------------------

describe('readDeployment', () => {
  it('answers nothing at all for a root with neither file — the ordinary first install', () => {
    expect(readDeployment(tempRoot())).toEqual({});
  });

  it("reads this app's own .env and state, never a sibling's (#229's rule again)", () => {
    const appsRoot = tempRoot();
    const mine = join(appsRoot, 'mine');
    const other = join(appsRoot, 'other');
    mkdirSync(mine, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(envFilePath(mine), 'POSTGRES_PASSWORD=mine-only\n');
    writeFileSync(envFilePath(other), 'POSTGRES_PASSWORD=other-only\nOTHER_ONLY_KEY=1\n');
    failedState(other, ['preflight', 'checkout', 'environment'], 'build');

    const found = readDeployment(mine);

    expect(found.env?.get('POSTGRES_PASSWORD')).toBe('mine-only');
    expect(found.env?.has('OTHER_ONLY_KEY')).toBe(false);
    // The neighbour has a resumable run. This one does not, and must not
    // inherit it: a resume against `mine` would skip steps `mine` never ran.
    expect(found.state).toBeUndefined();
  });

  it('treats a malformed state file as no state rather than throwing', () => {
    const root = tempRoot();
    writeFileSync(deployStatePath(root), '{ this is not json');

    // `readState` itself refuses it — the behaviour a COMMAND needs, and the
    // wrong one for a wizard that has written nothing yet.
    expect(() => readState(root)).toThrow();
    expect(readDeployment(root).state).toBeUndefined();
  });

  it('treats a state file from a future version as no state rather than throwing', () => {
    const root = tempRoot();
    writeFileSync(
      deployStatePath(root),
      JSON.stringify({ version: DEPLOY_STATE_VERSION + 99, deployRoot: root }),
    );

    expect(readDeployment(root).state).toBeUndefined();
  });

  it('treats an unreadable .env as no .env rather than throwing', () => {
    const root = tempRoot();
    // A directory where the file should be: `readFileSync` answers EISDIR,
    // which `readEnvFile` rethrows because it is not ENOENT. Chosen over
    // chmod 000 deliberately — this suite may run as root, where a mode is
    // not a permission.
    mkdirSync(envFilePath(root), { recursive: true });

    expect(readDeployment(root).env).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// The decision, over files that are actually on disk
// -----------------------------------------------------------------------------

/** The screen's own sequence: read the folder, seed the answers, decide. */
function plan(deployRoot: string, typed: Readonly<Record<string, string>> = {}): {
  answers: InstallAnswers;
  plan: ResumePlan;
} {
  const found = readDeployment(deployRoot);
  const prefill = prefillFrom(found.env, found.state);
  const answers = applyPrefill({ ...INTERNAL_DEFAULTS, ...typed }, undefined, prefill);
  return { answers, plan: resumePlan({ state: found.state, answers, prefill }) };
}

describe('the resume decision, from what is on disk', () => {
  it('passes no resume for a first install — there is no state to resume', () => {
    expect(plan(tempRoot()).plan).toMatchObject({ resume: false, reason: 'no-state' });
  });

  it('resumes a previous run that failed with steps already completed', () => {
    const root = tempRoot();
    writeFileSync(envFilePath(root), 'POSTGRES_HOST=db.example.test\n');
    failedState(root, ['preflight', 'checkout', 'environment', 'build'], 'migrate');

    expect(plan(root).plan).toMatchObject({
      resume: true,
      reason: 'resume',
      failedStep: 'migrate',
    });
  });

  it('starts fresh when the state file cannot be parsed', () => {
    const root = tempRoot();
    writeFileSync(envFilePath(root), 'POSTGRES_HOST=db.example.test\n');
    writeFileSync(deployStatePath(root), '{ truncated');

    expect(plan(root).plan).toMatchObject({ resume: false, reason: 'no-state' });
  });

  it('never turns a completed deployment into a resume', () => {
    const root = tempRoot();
    writeFileSync(envFilePath(root), 'POSTGRES_HOST=db.example.test\n');
    deployedState(root);

    expect(plan(root).plan).toMatchObject({ resume: false, reason: 'already-deployed' });
  });

  it("seeds the answers from this deployment's own .env, domain included", () => {
    const root = tempRoot();
    writeFileSync(
      envFilePath(root),
      ['POSTGRES_HOST=db.example.test', 'POSTGRES_PASSWORD=hunter2', ''].join('\n'),
    );
    failedState(root, ['preflight', 'checkout', 'environment'], 'build');

    const { answers } = plan(root);

    expect(answers['POSTGRES_HOST']).toBe('db.example.test');
    expect(answers['POSTGRES_PASSWORD']).toBe('hunter2');
    // No APP_URL in this file, so the domain comes from the state record of
    // what the previous run published under.
    expect(answerOf(answers, DOMAIN_FIELD)).toBe('app.example.test');
  });

  it('declines the resume when the operator corrected something the .env already holds', () => {
    const root = tempRoot();
    writeFileSync(envFilePath(root), 'POSTGRES_PASSWORD=was-wrong\n');
    failedState(root, ['preflight', 'checkout', 'environment', 'build'], 'migrate');

    // The whole point: `environment` is among the completed steps, so a
    // resume would skip the step that writes the file — and the correction
    // the operator just typed would be dropped on the floor while they
    // watched the identical failure.
    expect(plan(root, { POSTGRES_PASSWORD: 'now-right' }).plan).toMatchObject({
      resume: false,
      reason: 'environment-edited',
    });
  });
});

// -----------------------------------------------------------------------------
// End to end: the flag the screen decides on, through install.ts's own guards
// -----------------------------------------------------------------------------

describe('the wizard against a fake VPS', () => {
  let vps: FakeVps;

  beforeEach(async () => {
    vps = await fakeVps({ remoteSha: 'c'.repeat(40) });
    vi.stubGlobal('fetch', healthyFetch());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await vps.close();
  });

  /**
   * One run of the wizard: read the folder, seed the answers, decide, install.
   *
   * `typed` is what the OPERATOR contributes. On a first install that is
   * every essential answer, because there is nothing on disk to seed from; on
   * the re-run it is `{}`, because pressing on through prefilled questions is
   * exactly what the issue says should work.
   */
  function install(root: string, typed: Readonly<Record<string, string>> = {}) {
    const decided = plan(root, typed);
    const domain = answerOf(decided.answers, DOMAIN_FIELD);
    return {
      decided: decided.plan,
      run: runInstall({
        deployRoot: root,
        name: 'demo',
        bindPort: 3535,
        proxyRoot: join(root, 'proxy'),
        ...(domain === '' ? {} : { domain }),
        repo: 'https://example.test/o/demo.git',
        ref: 'main',
        runCommand: vps.runCommand,
        cwd: root,
        nonInteractive: true,
        answers: envAnswers(decided.answers),
        promptContext: silentPrompt(),
        skipDoctor: true,
        skipProxy: true,
        skipSeed: true,
        // The one line issue #288 is about.
        ...(decided.plan.resume ? { resume: true } : {}),
      }),
    };
  }

  /** Everything the operator types on a first install. */
  function firstAnswers(): Record<string, string> {
    return {
      ...Object.fromEntries(vps.answers()),
      [DOMAIN_FIELD]: 'app.example.test',
    };
  }

  function failCompose(subcommand: string, message: string): { stop(): void } {
    let failing = true;
    vps.failWhen(
      (argv) => failing && argv[1] === 'compose' && argv.includes(subcommand),
      message,
    );
    return { stop: () => void (failing = false) };
  }

  it('does not pass resume on a first install, so it never answers "Nothing to resume"', async () => {
    const root = tempRoot('appctl-install-');

    const { decided, run } = install(root, firstAnswers());
    const result = await run;

    expect(decided.resume).toBe(false);
    expect(result.deployRoot).toBe(root);
    expect(readState(root)?.lastOutcome).toBe('success');
  });

  it('resumes after a failure, skipping the build the operator already paid for', async () => {
    const root = tempRoot('appctl-install-');
    // `up`, not `build`: the point is that the four-minute step BEFORE the
    // failure is skipped, so it has to be one the failed run completed.
    const start = failCompose('up', 'the stack would not start');

    await install(root, firstAnswers()).run.catch(() => undefined);
    expect(readState(root)?.lastOutcome).toBe('failure');
    expect(readState(root)?.completedSteps).toContain('build');

    start.stop();
    vps.seen.length = 0;

    // Nothing typed: the wizard re-opens on the answers its own .env carries,
    // the operator presses on, and the run picks up where it stopped.
    const { decided, run } = install(root);
    await run;

    expect(decided.resume).toBe(true);
    expect(vps.seen.some((argv) => argv[1] === 'compose' && argv.includes('build'))).toBe(
      false,
    );
    expect(vps.seen.some((argv) => argv[0] === 'git' && argv[1] === 'clone')).toBe(false);
    expect(readState(root)?.lastOutcome).toBe('success');
  });

  it('re-runs everything, and rewrites the .env, when an answer was corrected', async () => {
    const root = tempRoot('appctl-install-');
    const start = failCompose('up', 'the stack would not start');

    await install(root, firstAnswers()).run.catch(() => undefined);
    expect(readState(root)?.completedSteps).toContain('environment');

    start.stop();
    vps.seen.length = 0;

    const { decided, run } = install(root, { POSTGRES_PASSWORD: 'corrected' });
    await run;

    expect(decided.resume).toBe(false);
    expect(decided.reason).toBe('environment-edited');
    // The correction reached the file, which is the thing a resume would have
    // skipped the step for.
    expect(readDeployment(root).env?.get('POSTGRES_PASSWORD')).toBe('corrected');
    expect(vps.seen.some((argv) => argv[1] === 'compose' && argv.includes('build'))).toBe(true);
  });

  it('refuses over a completed deployment instead of silently resuming it', async () => {
    const root = tempRoot('appctl-install-');
    await install(root, firstAnswers()).run;

    // A second install with nothing changed. The state now records a
    // completed deploy, so the flag must NOT be passed: it waives exactly the
    // refusal that belongs here, and waiving it would skip all thirteen
    // recorded steps and report an install that did nothing.
    const { decided, run } = install(root);
    const error = await run.catch((caught: unknown) => caught);

    expect(decided.resume).toBe(false);
    expect(decided.reason).toBe('already-deployed');
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('A deployment already exists');
  });
});
