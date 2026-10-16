import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeploymentResolutionError, resolveDeployment } from './deployment.js';

// The ranks restate the platform's resolver (`--root`, `--name`, the directory
// the shell stands in, the sole installed deployment, refuse). If they drift
// apart the `uninstall --confirm` guard would compare against the wrong name.

let work: string;
let appsRoot: string;

function install(name: string, { env = true, checkout = true } = {}): string {
  const dir = join(appsRoot, name);
  mkdirSync(dir, { recursive: true });
  if (checkout) mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
  if (env) writeFileSync(join(dir, '.env'), 'X=1\n');
  return dir;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'deployment-'));
  appsRoot = join(work, 'apps');
  mkdirSync(appsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('resolveDeployment', () => {
  it('rank 1: --root wins, and the name is its folder', () => {
    const dir = install('one');
    install('two');

    expect(resolveDeployment({ root: dir, name: 'two', appsRoot, cwd: work })).toEqual({
      name: 'one',
      deployRoot: dir,
      appsRoot,
    });
  });

  it('rank 2: --name beats the directory the shell stands in', () => {
    install('one');
    const two = install('two');

    expect(resolveDeployment({ name: 'one', appsRoot, cwd: two }).name).toBe('one');
  });

  it('rank 3: standing inside a deployment selects it, however deep', () => {
    install('one');
    const two = install('two');
    const deep = join(two, 'repo', 'apps');
    mkdirSync(deep, { recursive: true });

    expect(resolveDeployment({ appsRoot, cwd: deep })).toEqual({
      name: 'two',
      deployRoot: two,
      appsRoot,
    });
  });

  it('rank 4: the sole installed deployment', () => {
    install('only');

    expect(resolveDeployment({ appsRoot, cwd: work }).name).toBe('only');
  });

  it('ignores a folder that is not a deployment (no checkout, or no environment file)', () => {
    install('real');
    install('noenv', { env: false });
    install('nogit', { checkout: false });

    expect(resolveDeployment({ appsRoot, cwd: work }).name).toBe('real');
  });

  it('rank 5: refuses on ambiguity, naming the candidates, and never prefers one', () => {
    install('one');
    install('two');

    const attempt = (): unknown => resolveDeployment({ appsRoot, cwd: work });
    expect(attempt).toThrow(DeploymentResolutionError);
    expect(attempt).toThrow(/one, two.*--name/);
  });

  it('refuses when nothing is installed, pointing at --root', () => {
    expect(() => resolveDeployment({ appsRoot, cwd: work })).toThrow(/No deployment found.*--root/);
  });

  it('reads the legacy environment file inside the checkout', () => {
    const dir = install('old', { env: false });
    mkdirSync(join(dir, 'repo', 'infra', 'compose'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'infra', 'compose', '.env'), 'X=1\n');

    expect(resolveDeployment({ appsRoot, cwd: work }).name).toBe('old');
  });
});
