import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  API_WORKDIR,
  execInContainer,
  findApiContainer,
  lastJsonLine,
  type DockerRun,
  type DockerRunResult,
} from './api-container.js';

const OK = (stdout: string): DockerRunResult => ({ exitCode: 0, stdout, stderr: '', unavailable: false });
const DOWN: DockerRunResult = { exitCode: null, stdout: '', stderr: '', unavailable: true };

const roots: string[] = [];
function deployRoot(state?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'api-container-'));
  roots.push(root);
  if (state !== undefined) writeFileSync(join(root, '.appctl-deploy.json'), JSON.stringify(state));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('findApiContainer', () => {
  it('filters by the context project and the api service, running only', async () => {
    const asked: string[][] = [];
    const run: DockerRun = async (args) => {
      asked.push([...args]);
      return OK('abc123\n');
    };

    const found = await findApiContainer({ deployRoot: deployRoot(), composeProject: 'proj-a' }, run);

    expect(found).toEqual({ kind: 'found', id: 'abc123', project: 'proj-a' });
    expect(asked).toEqual([
      [
        'ps',
        '--filter',
        'label=com.docker.compose.project=proj-a',
        '--filter',
        'label=com.docker.compose.service=api',
        '--filter',
        'status=running',
        '--quiet',
      ],
    ]);
  });

  it('reads the project from the deploy state file when the context has none', async () => {
    const asked: string[][] = [];
    const run: DockerRun = async (args) => {
      asked.push([...args]);
      return OK('def456');
    };

    const found = await findApiContainer({ deployRoot: deployRoot({ composeProject: 'from-state' }) }, run);

    expect(found).toMatchObject({ kind: 'found', project: 'from-state' });
    expect(asked).toHaveLength(1);
  });

  it('detects the project from the deploy folder when neither is known', async () => {
    const run: DockerRun = async (args) => {
      if (args[0] === 'ps' && args[1] === '-aq') return OK('c1\n');
      if (args[0] === 'inspect') return OK('');
      return OK('');
    };

    const found = await findApiContainer({ deployRoot: deployRoot() }, run);

    // Nothing started from inside the temp folder: no project, so no container.
    expect(found.kind).toBe('none');
  });

  it('is none when no api container runs, unavailable when docker cannot be asked', async () => {
    const query = { deployRoot: deployRoot(), composeProject: 'p' };
    expect((await findApiContainer(query, async () => OK('\n'))).kind).toBe('none');
    expect((await findApiContainer(query, async () => DOWN)).kind).toBe('unavailable');
    expect((await findApiContainer(query, async () => ({ ...OK(''), exitCode: 1 }))).kind).toBe('unavailable');
  });
});

describe('execInContainer and lastJsonLine', () => {
  it('runs in the image WORKDIR with argv only', async () => {
    const asked: string[][] = [];
    await execInContainer('abc', ['node', '-v'], 5000, async (args, timeout) => {
      asked.push([...args], [String(timeout)]);
      return OK('');
    });
    expect(asked).toEqual([['exec', '--workdir', API_WORKDIR, 'abc', 'node', '-v'], ['5000']]);
  });

  it('takes the last JSON line of the output and ignores log noise', () => {
    expect(lastJsonLine('warn: something\n{"a":1}\n\n')).toEqual({ a: 1 });
    expect(lastJsonLine('{"a":1}\nnot json\n')).toEqual({ a: 1 });
    expect(lastJsonLine('nothing')).toBeUndefined();
    expect(lastJsonLine('')).toBeUndefined();
  });
});
