import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEPLOY_STATE_FILENAME } from '@marinoscar/platform-cli/deploy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectComposeProject, reconcileComposeProject, reconcileForArgv } from './compose-project.js';
import { COMPOSE_PROJECT_LABEL, COMPOSE_WORKING_DIR_LABEL, type DockerRunner } from './docker-ports.check.js';

// =============================================================================
// The compose project a deployment really runs under  (issue #736)
// =============================================================================
//
// A server installed by the pre-platform CLI runs under an app-named compose
// project and records none; the platform engine then assumes `compose`. These
// tests pin what `detectComposeProject` reads off Docker, when
// `reconcileComposeProject` writes the state file (and what it keeps), and which
// invocations `reconcileForArgv` acts on. Docker is a fake runner; the state
// file is a real file in a temporary folder.
// =============================================================================

let work: string;
let root: string;
let statePath: string;

/** What `docker inspect` prints for the fake: one `project|workingDir` line per container. */
type Container = readonly [project: string, workingDir: string];

interface FakeDocker {
  run: DockerRunner;
  calls: string[][];
}

function fakeDocker(containers: readonly Container[] | 'down'): FakeDocker {
  const calls: string[][] = [];
  const run: DockerRunner = async (args) => {
    calls.push([...args]);
    if (containers === 'down') throw new Error('Cannot connect to the Docker daemon');
    if (args[0] === 'ps') return containers.map((_, index) => `id${index}`).join('\n') + '\n';
    if (args[0] === 'inspect') return containers.map(([project, dir]) => `${project}|${dir}`).join('\n') + '\n';
    throw new Error(`unexpected docker ${args[0]}`);
  };
  return { run, calls };
}

function writeState(state: Record<string, unknown>, mode = 0o640): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  chmodSync(statePath, mode);
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
}

const LEGACY_STATE = { version: 1, commitSha: 'a'.repeat(40), ref: 'main', appctlVersion: '1.10.1' };

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'compose-project-'));
  root = join(work, 'apps', 'myapp');
  mkdirSync(root, { recursive: true });
  statePath = join(root, DEPLOY_STATE_FILENAME);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('detectComposeProject', () => {
  it('finds the single project whose containers were started from inside the folder', async () => {
    const docker = fakeDocker([
      ['myapp', join(root, 'repo', 'infra', 'compose')],
      ['myapp', join(root, 'repo', 'infra', 'compose')],
      ['tools', '/opt/tools'],
    ]);

    expect(await detectComposeProject(root, docker.run)).toEqual({ kind: 'found', project: 'myapp' });
  });

  it('also matches a container started from the folder itself', async () => {
    expect(await detectComposeProject(root, fakeDocker([['myapp', root]]).run)).toEqual({
      kind: 'found',
      project: 'myapp',
    });
  });

  it('is none on a host without containers, and does not inspect', async () => {
    const docker = fakeDocker([]);

    expect(await detectComposeProject(root, docker.run)).toEqual({ kind: 'none' });
    expect(docker.calls.map((call) => call[0])).toEqual(['ps']);
  });

  it('is none when no container was started from inside the folder', async () => {
    const docker = fakeDocker([
      ['tools', '/opt/tools'],
      ['other', '/srv/other/compose'],
    ]);

    expect(await detectComposeProject(root, docker.run)).toEqual({ kind: 'none' });
  });

  it('is ambiguous, with the projects sorted, when two projects started from inside the folder', async () => {
    const docker = fakeDocker([
      ['zeta', join(root, 'repo')],
      ['alpha', join(root, 'other')],
      ['zeta', join(root, 'repo')],
    ]);

    expect(await detectComposeProject(root, docker.run)).toEqual({ kind: 'ambiguous', projects: ['alpha', 'zeta'] });
  });

  it('is unavailable, never a throw, when Docker cannot be asked', async () => {
    await expect(detectComposeProject(root, fakeDocker('down').run)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('is unavailable when only the inspect fails', async () => {
    const run: DockerRunner = async (args) => {
      if (args[0] === 'ps') return 'abc\n';
      throw new Error('inspect failed');
    };

    expect(await detectComposeProject(root, run)).toEqual({ kind: 'unavailable' });
  });

  it('is segment-aware: a sibling folder sharing the prefix is not under the root', async () => {
    const docker = fakeDocker([['sibling', `${root}-2/repo/infra/compose`]]);

    expect(await detectComposeProject(root, docker.run)).toEqual({ kind: 'none' });
  });

  it('ignores a container without labels (empty fields, the nil-guard line) and one missing a field', async () => {
    const run: DockerRunner = async (args) =>
      args[0] === 'ps' ? 'a\nb\nc\nd\n' : `|\n|${root}/repo\nlost|\nmyapp|${root}/repo\n`;

    expect(await detectComposeProject(root, run)).toEqual({ kind: 'found', project: 'myapp' });
  });

  it('ignores lines without a separator', async () => {
    const run: DockerRunner = async (args) => (args[0] === 'ps' ? 'a\n' : `<no value>\nmyapp|${root}\n`);

    expect(await detectComposeProject(root, run)).toEqual({ kind: 'found', project: 'myapp' });
  });

  it('inspects every id once, as separate argv entries, asking for both compose labels', async () => {
    const docker = fakeDocker([
      ['myapp', root],
      ['tools', '/opt/tools'],
      ['myapp', root],
    ]);

    await detectComposeProject(root, docker.run);

    expect(docker.calls).toHaveLength(2);
    expect(docker.calls[0]).toEqual(['ps', '-aq']);
    const inspect = docker.calls[1] as string[];
    expect(inspect[0]).toBe('inspect');
    expect(inspect[1]).toBe('--format');
    expect(inspect.slice(3)).toEqual(['id0', 'id1', 'id2']);
    expect(inspect[2]).toContain(COMPOSE_PROJECT_LABEL);
    expect(inspect[2]).toContain(COMPOSE_WORKING_DIR_LABEL);
  });
});

describe('reconcileComposeProject', () => {
  const cwd = (): string => join(root, 'repo', 'infra', 'compose');

  it('records the project Docker names when the state file records none, keeping everything else', async () => {
    writeState(LEGACY_STATE);
    const docker = fakeDocker([['myapp', cwd()]]);

    const note = await reconcileComposeProject(root, docker.run);

    expect(readState()).toEqual({ ...LEGACY_STATE, composeProject: 'myapp' });
    expect(note).toContain('recorded compose project myapp');
    expect(note).toContain(root);
  });

  it('keeps the mode of the state file', async () => {
    writeState(LEGACY_STATE, 0o640);

    await reconcileComposeProject(root, fakeDocker([['myapp', cwd()]]).run);

    expect(statSync(statePath).mode & 0o777).toBe(0o640);
  });

  it('keeps a copy of the previous file as <file>.bak with mode 0600', async () => {
    writeState(LEGACY_STATE);
    const original = readFileSync(statePath, 'utf8');

    await reconcileComposeProject(root, fakeDocker([['myapp', cwd()]]).run);

    expect(readFileSync(`${statePath}.bak`, 'utf8')).toBe(original);
    expect(statSync(`${statePath}.bak`).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary file behind', async () => {
    writeState(LEGACY_STATE);

    await reconcileComposeProject(root, fakeDocker([['myapp', cwd()]]).run);

    const leftovers = readdirSync(root).filter((entry) => entry.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('is idempotent: a second run changes nothing, says nothing and does not ask Docker', async () => {
    writeState(LEGACY_STATE);
    const docker = fakeDocker([['myapp', cwd()]]);
    await reconcileComposeProject(root, docker.run);
    const after = readFileSync(statePath, 'utf8');
    const asked = docker.calls.length;

    const again = await reconcileComposeProject(root, docker.run);

    expect(again).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).toBe(after);
    expect(docker.calls).toHaveLength(asked);
  });

  it('rewrites the legacy default the engine may have written back', async () => {
    writeState({ ...LEGACY_STATE, composeProject: 'compose' });

    const note = await reconcileComposeProject(root, fakeDocker([['myapp', cwd()]]).run);

    expect(readState()['composeProject']).toBe('myapp');
    expect(note).toContain('had compose');
  });

  it('never overwrites a project recorded on purpose, and does not even ask Docker', async () => {
    writeState({ ...LEGACY_STATE, composeProject: 'other' });
    const docker = fakeDocker([['myapp', cwd()]]);

    const note = await reconcileComposeProject(root, docker.run);

    expect(note).toBeUndefined();
    expect(readState()['composeProject']).toBe('other');
    expect(docker.calls).toEqual([]);
    expect(existsSync(`${statePath}.bak`)).toBe(false);
  });

  it('does nothing when Docker names the legacy default itself', async () => {
    writeState(LEGACY_STATE);
    const before = readFileSync(statePath, 'utf8');

    const note = await reconcileComposeProject(root, fakeDocker([['compose', cwd()]]).run);

    expect(note).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(existsSync(`${statePath}.bak`)).toBe(false);
  });

  it('does nothing when Docker knows no container of this folder', async () => {
    writeState(LEGACY_STATE);
    const before = readFileSync(statePath, 'utf8');

    expect(await reconcileComposeProject(root, fakeDocker([['tools', '/opt/tools']]).run)).toBeUndefined();
    expect(await reconcileComposeProject(root, fakeDocker([]).run)).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('does nothing when Docker cannot be asked', async () => {
    writeState(LEGACY_STATE);
    const before = readFileSync(statePath, 'utf8');

    expect(await reconcileComposeProject(root, fakeDocker('down').run)).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('warns, naming the projects and the state file, and writes nothing when several projects run here', async () => {
    writeState(LEGACY_STATE);
    const before = readFileSync(statePath, 'utf8');

    const note = await reconcileComposeProject(
      root,
      fakeDocker([
        ['zeta', cwd()],
        ['alpha', cwd()],
      ]).run,
    );

    expect(note).toContain('alpha, zeta');
    expect(note).toContain(statePath);
    expect(note).toContain('warning');
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(existsSync(`${statePath}.bak`)).toBe(false);
  });

  it('is silent when the several projects include the legacy default the engine already uses', async () => {
    writeState(LEGACY_STATE);
    const before = readFileSync(statePath, 'utf8');

    const note = await reconcileComposeProject(
      root,
      fakeDocker([
        ['compose', cwd()],
        ['myapp', cwd()],
      ]).run,
    );

    expect(note).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('does nothing when the state file is missing', async () => {
    const docker = fakeDocker([['myapp', cwd()]]);

    expect(await reconcileComposeProject(root, docker.run)).toBeUndefined();
    expect(existsSync(statePath)).toBe(false);
    expect(docker.calls).toEqual([]);
  });

  it.each([
    ['not JSON', '{ nope'],
    ['an array', '[1, 2]'],
    ['null', 'null'],
    ['a string', '"x"'],
  ])('does nothing when the state file is %s', async (_label, content) => {
    writeFileSync(statePath, content);
    const docker = fakeDocker([['myapp', cwd()]]);

    expect(await reconcileComposeProject(root, docker.run)).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).toBe(content);
    expect(docker.calls).toEqual([]);
  });

  it('keeps an existing .bak (the one from before the first change) on a later change', async () => {
    writeState(LEGACY_STATE);
    const first = readFileSync(statePath, 'utf8');
    await reconcileComposeProject(root, fakeDocker([['myapp', cwd()]]).run);

    // The engine writes the default back, then the next run changes it again.
    writeState({ ...LEGACY_STATE, composeProject: 'compose', marker: 'second' });
    await reconcileComposeProject(root, fakeDocker([['myapp', cwd()]]).run);

    expect(readState()).toEqual({ ...LEGACY_STATE, composeProject: 'myapp', marker: 'second' });
    expect(readFileSync(`${statePath}.bak`, 'utf8')).toBe(first);
  });
});

describe('reconcileForArgv', () => {
  /** A deployment with a legacy state file and a container of project `myapp` started from inside it. */
  function arrange(): FakeDocker {
    writeState(LEGACY_STATE);
    return fakeDocker([['myapp', join(root, 'repo', 'infra', 'compose')]]);
  }

  const recorded = (): unknown => readState()['composeProject'];

  it.each(['update', 'status', 'doctor', 'about'])('reconciles `deploy %s --root <dir>`', async (sub) => {
    const docker = arrange();

    const note = await reconcileForArgv(['deploy', sub, '--root', root], work, docker.run);

    expect(note).toContain('recorded compose project myapp');
    expect(recorded()).toBe('myapp');
  });

  it('reads --root=<dir>', async () => {
    const docker = arrange();

    await reconcileForArgv(['deploy', 'status', `--root=${root}`], work, docker.run);

    expect(recorded()).toBe('myapp');
  });

  it('resolves a relative --root against the directory the shell stands in', async () => {
    const docker = arrange();

    await reconcileForArgv(['deploy', 'status', '--root', 'apps/myapp'], work, docker.run);

    expect(recorded()).toBe('myapp');
  });

  it('reads --name together with --apps-root', async () => {
    const docker = arrange();

    await reconcileForArgv(['deploy', 'update', '--name', 'myapp', '--apps-root', join(work, 'apps')], work, docker.run);

    expect(recorded()).toBe('myapp');
  });

  it('ignores other options of the subcommand', async () => {
    const docker = arrange();

    await reconcileForArgv(['deploy', 'update', '--json', '--root', root, '--ref', 'main'], work, docker.run);

    expect(recorded()).toBe('myapp');
  });

  it.each([
    ['install', ['deploy', 'install']],
    ['uninstall', ['deploy', 'uninstall']],
    ['list', ['deploy', 'list']],
    ['certs', ['deploy', 'certs']],
    ['deploy with no subcommand', ['deploy']],
    ['a non-deploy command (api)', ['api', 'GET', '/api/auth/me']],
    ['a non-deploy command (config)', ['config']],
    ['no command at all', []],
  ])('skips %s', async (_label, argv) => {
    const docker = arrange();

    const note = await reconcileForArgv([...argv, '--root', root], work, docker.run);

    expect(note).toBeUndefined();
    expect(docker.calls).toEqual([]);
    expect(recorded()).toBeUndefined();
  });

  it.each(['--help', '-h', '--version', '-v', '--dry-run'])('skips when %s is given', async (flag) => {
    const docker = arrange();

    const note = await reconcileForArgv(['deploy', 'update', '--root', root, flag], work, docker.run);

    expect(note).toBeUndefined();
    expect(docker.calls).toEqual([]);
    expect(recorded()).toBeUndefined();
  });

  it('is a silent skip when the deployment cannot be resolved', async () => {
    const docker = arrange();
    const emptyAppsRoot = join(work, 'empty-apps');
    mkdirSync(emptyAppsRoot);

    const note = await reconcileForArgv(['deploy', 'update', '--apps-root', emptyAppsRoot], work, docker.run);

    expect(note).toBeUndefined();
    expect(docker.calls).toEqual([]);
    expect(recorded()).toBeUndefined();
  });

  it('never rejects when the runner throws', async () => {
    arrange();
    const run = vi.fn<DockerRunner>(async () => {
      throw new Error('boom');
    });

    await expect(reconcileForArgv(['deploy', 'update', '--root', root], work, run)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalled();
    expect(recorded()).toBeUndefined();
  });
});
