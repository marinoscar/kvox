import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deployExtrasFrom, readDeployExtras } from './deploy-extras';

// The deploy CLI's `info.json` (schema 1), reduced to the fields this reader looks at.
function info(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    app: { name: 'app', repoUrl: 'https://example.com/org/repo' },
    remote: { sha: 'abc123', commitsBehind: 2 },
    run: { completed: true },
    adoptedAt: '2026-01-02T03:04:05.000Z',
    host: { cpuModel: 'Test CPU', diskBytes: 1024, nodeVersion: 'v22.0.0', memoryBytes: 99 },
    ...overrides,
  };
}

describe('deployExtrasFrom', () => {
  it('picks the fields the platform report drops', () => {
    expect(deployExtrasFrom(info())).toEqual({
      repoUrl: 'https://example.com/org/repo',
      remoteSha: 'abc123',
      runCompleted: true,
      adoptedAt: '2026-01-02T03:04:05.000Z',
      hostCpuModel: 'Test CPU',
      hostDiskBytes: 1024,
      hostNodeVersion: 'v22.0.0',
    });
  });

  it('leaves out the fields the platform already reports', () => {
    const facts = deployExtrasFrom(info());

    expect(facts).not.toHaveProperty('commitsBehind');
    expect(facts).not.toHaveProperty('memoryBytes');
    expect(facts).not.toHaveProperty('name');
  });

  it('treats an absent run.completed as a completed run (the CLI convention)', () => {
    expect(deployExtrasFrom(info({ run: {} })).runCompleted).toBe(true);
    expect(deployExtrasFrom(info({ run: undefined })).runCompleted).toBe(true);
  });

  it('reports an explicit run.completed=false as incomplete, with the attempt time', () => {
    const facts = deployExtrasFrom(info({ run: { completed: false, attemptedAt: '2026-02-03T00:00:00.000Z' } }));

    expect(facts.runCompleted).toBe(false);
    expect(facts.runAttemptedAt).toBe('2026-02-03T00:00:00.000Z');
  });

  it('omits the attempt time for a completed run', () => {
    expect(deployExtrasFrom(info({ run: { completed: true, attemptedAt: 'x' } }))).not.toHaveProperty('runAttemptedAt');
  });

  it('omits fields that are missing, empty or of the wrong type', () => {
    const facts = deployExtrasFrom(
      info({
        app: { repoUrl: '' },
        remote: { sha: 42 },
        adoptedAt: null,
        host: { cpuModel: 7, diskBytes: -1, nodeVersion: [] },
      }),
    );

    expect(facts).toEqual({ runCompleted: true });
  });

  it('omits a non-finite disk size', () => {
    expect(deployExtrasFrom(info({ host: { diskBytes: Number.NaN } }))).not.toHaveProperty('hostDiskBytes');
  });

  it('accepts a disk size of zero', () => {
    expect(deployExtrasFrom(info({ host: { diskBytes: 0 } })).hostDiskBytes).toBe(0);
  });

  it.each([
    ['null', null],
    ['a string', 'text'],
    ['an array', []],
    ['another schema version', info({ schema: 2 })],
    ['no schema', { app: {} }],
  ])('yields no facts for %s', (_name, value) => {
    expect(deployExtrasFrom(value)).toEqual({});
  });

  it('tolerates sections that are not objects', () => {
    expect(deployExtrasFrom({ schema: 1, app: 'x', remote: [], run: 3, host: null })).toEqual({ runCompleted: true });
  });
});

describe('readDeployExtras', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deploy-extras-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the file fresh on every call (the CLI rewrites it in place)', async () => {
    const path = join(dir, 'info.json');
    await writeFile(path, JSON.stringify(info({ remote: { sha: 'first' } })));
    expect((await readDeployExtras(path)).remoteSha).toBe('first');

    await writeFile(path, JSON.stringify(info({ remote: { sha: 'second' } })));
    expect((await readDeployExtras(path)).remoteSha).toBe('second');
  });

  it('yields no facts, without throwing, for a missing file', async () => {
    await expect(readDeployExtras(join(dir, 'absent.json'))).resolves.toEqual({});
  });

  it('yields no facts, without throwing, for malformed JSON', async () => {
    const path = join(dir, 'info.json');
    await writeFile(path, '{ not json');

    await expect(readDeployExtras(path)).resolves.toEqual({});
  });
});
