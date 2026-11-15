import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeployStepContext } from '@marinoscar/platform-cli/deploy';
import { planDeploySteps } from '@marinoscar/platform-cli/deploy';
import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from '../app.js';
import type { DockerRun, DockerRunResult } from './api-container.js';
import { VOICE_MODEL_STEP_ID, VOICE_MODEL_TIMEOUT_MS, runVoiceModelStep, voiceModelSteps } from './voice-model.step.js';

const ok = (stdout: string): DockerRunResult => ({ exitCode: 0, stdout, stderr: '', unavailable: false });
const exited = (exitCode: number, stdout = ''): DockerRunResult => ({ exitCode, stdout, stderr: '', unavailable: false });
const UNAVAILABLE: DockerRunResult = { exitCode: null, stdout: '', stderr: '', unavailable: true };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A deploy folder whose state file names the compose project, as an installed deployment's does. */
function installedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'voice-model-'));
  roots.push(root);
  writeFileSync(join(root, '.appctl-deploy.json'), JSON.stringify({ composeProject: 'app-x' }));
  return root;
}

function context(root = installedRoot()) {
  const lines: string[] = [];
  const progress: string[] = [];
  const stepContext = {
    pipeline: 'update',
    deployRoot: root,
    checkoutPath: `${root}/repo`,
    commitSha: undefined,
    env: { get: () => undefined, has: () => false, keys: () => [] },
    answers: { get: () => undefined, has: () => false, keys: () => [] },
    hooks: undefined,
    log: (line: string) => lines.push(line),
    progress: (message: string) => progress.push(message),
    exec: async () => {
      throw new Error('the step must go through the docker seam in tests');
    },
  } as unknown as DeployStepContext;
  return { stepContext, lines, progress };
}

/** Docker fake: `ps` finds container `cid1` (or none), `exec` answers through `ensure`. */
function docker(ensure: (argv: string[], timeout: number) => DockerRunResult, found = true): { run: DockerRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerRun = async (args, timeout) => {
    calls.push([...args]);
    if (args[0] === 'ps') return ok(found ? 'cid1\n' : '');
    if (args[0] === 'exec') return ensure(args.slice(4), timeout);
    return ok('');
  };
  return { run, calls };
}

describe('the voice-model deploy step', () => {
  it('is registered after health in BOTH pipelines under one id', () => {
    expect(voiceModelSteps.map((s) => [s.pipeline, s.id, s.after])).toEqual([
      ['install', 'voice-model', 'health'],
      ['update', 'voice-model', 'health'],
    ]);
  });

  it('lands right after health, before deploy-info, in both resolved pipelines', () => {
    resetCliForTests();
    createCli(APP_CLI_OPTIONS);
    for (const pipeline of ['install', 'update'] as const) {
      const ids = planDeploySteps(pipeline).map((s) => s.id);
      const at = ids.indexOf(VOICE_MODEL_STEP_ID);
      expect(at).toBeGreaterThan(0);
      expect(ids[at - 1]).toBe('health');
      expect(ids[at + 1]).toBe('deploy-info');
    }
  });

  it('runs the model script `ensure` in the api container with a 5 minute budget and logs the result', async () => {
    const { stepContext, lines } = context();
    const seen: Array<{ argv: string[]; timeout: number }> = [];
    const fake = docker((argv, timeout) => {
      seen.push({ argv, timeout });
      return ok('{"status":"installed","model":"m","bytes":29596978,"dir":"/var/lib/voiceprint-models"}\n');
    });

    await runVoiceModelStep(stepContext, fake.run);

    expect(seen).toEqual([{ argv: ['node', '/app/apps/api/scripts/voiceprint-model.js', 'ensure'], timeout: VOICE_MODEL_TIMEOUT_MS }]);
    expect(VOICE_MODEL_TIMEOUT_MS).toBe(300_000);
    expect(lines).toEqual(['Voice model: downloaded and verified (29.6 MB).']);
  });

  it('reports an already-installed model', async () => {
    const { stepContext, lines } = context();
    await runVoiceModelStep(stepContext, docker(() => ok('{"status":"already-installed","bytes":29596978}')).run);
    expect(lines).toEqual(['Voice model: already installed (29.6 MB).']);
  });

  it('is NON-FATAL on a download failure: warns with the remedy and returns normally', async () => {
    const { stepContext, lines } = context();
    const fake = docker(() => exited(1, '{"status":"error","code":"download_failed","message":"The download failed."}'));

    await expect(runVoiceModelStep(stepContext, fake.run)).resolves.toBeUndefined();

    const text = lines.join('\n');
    expect(text).toContain('WARNING: the speaker voice model was not installed');
    expect(text).toContain('download_failed');
    expect(text).toContain('github.com and release-assets.githubusercontent.com');
    expect(text).toContain('deploy update --force');
    expect(text).toContain('first voice job');
  });

  it('is NON-FATAL when the exec times out or docker disappears', async () => {
    const { stepContext, lines } = context();
    await expect(runVoiceModelStep(stepContext, docker(() => UNAVAILABLE).run)).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('WARNING');
  });

  it('is NON-FATAL when the image has no script (an older image): the output is not JSON', async () => {
    const { stepContext, lines } = context();
    await expect(runVoiceModelStep(stepContext, docker(() => exited(1, 'Error: Cannot find module')).run)).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('(unknown)');
    expect(lines.join('\n')).toContain('WARNING');
  });

  it('is NON-FATAL even when the lookup itself throws', async () => {
    const { stepContext, lines } = context();
    const run: DockerRun = async () => {
      throw new Error('boom');
    };
    await expect(runVoiceModelStep(stepContext, run)).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('WARNING');
  });

  it('logs a skip and runs nothing when there is no api container', async () => {
    const { stepContext, lines } = context();
    let execs = 0;
    const fake = docker(() => {
      execs += 1;
      return ok('');
    }, false);

    await runVoiceModelStep(stepContext, fake.run);

    expect(execs).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Voice model: skipped');
    expect(lines[0]).not.toContain('WARNING');
  });
});
