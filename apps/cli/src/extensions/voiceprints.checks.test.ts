import { describe, expect, it } from 'vitest';

import type { DockerRun, DockerRunResult } from './api-container.js';
import {
  DEFAULT_API_MEM_LIMIT,
  createVoiceprintChecks,
  parseMemorySize,
  type VoiceprintCheckDeps,
} from './voiceprints.checks.js';

const GIB = 1024 ** 3;

function context(env: Record<string, string> | undefined) {
  return {
    deployRoot: '/opt/infra/apps/app-x',
    bindPort: 3535,
    composeProject: 'app-x',
    proxyRoot: '/opt/infra/proxy',
    domain: undefined,
    env:
      env === undefined
        ? undefined
        : { get: (key: string) => env[key], has: (key: string) => key in env, keys: () => Object.keys(env) },
    skipProxy: false,
  };
}

const ok = (stdout: string): DockerRunResult => ({ exitCode: 0, stdout, stderr: '', unavailable: false });
const exited = (exitCode: number, stdout = ''): DockerRunResult => ({ exitCode, stdout, stderr: '', unavailable: false });
const UNAVAILABLE: DockerRunResult = { exitCode: null, stdout: '', stderr: '', unavailable: true };

/** Docker fake: `ps` answers the lookup, `exec` answers by a matcher on the command. */
function docker(options: { running?: boolean; unavailable?: boolean; exec?: (argv: string[]) => DockerRunResult }): { run: DockerRun; execs: string[][] } {
  const execs: string[][] = [];
  const run: DockerRun = async (args) => {
    if (options.unavailable === true) return UNAVAILABLE;
    if (args[0] === 'ps') return ok(options.running === false ? '' : 'cid1\n');
    if (args[0] === 'exec') {
      const argv = args.slice(4);
      execs.push([...argv]);
      return options.exec?.(argv) ?? ok('');
    }
    return ok('');
  };
  return { run, execs };
}

function checks(overrides: Partial<VoiceprintCheckDeps> = {}) {
  const deps: VoiceprintCheckDeps = {
    run: docker({}).run,
    hostProbe: async () => ({ ok: true }),
    hostMemoryBytes: () => 8 * GIB,
    ...overrides,
  };
  const byId = new Map(createVoiceprintChecks(deps).map((check) => [check.id, check]));
  const get = (id: string) => {
    const check = byId.get(id);
    if (check === undefined) throw new Error(`no check ${id}`);
    return check;
  };
  return { get };
}

describe('the check set', () => {
  it('has the five ids, all recommended except the pgvector check', () => {
    const list = createVoiceprintChecks();
    expect(list.map((c) => `${c.id}:${c.severity}`)).toEqual([
      'voiceprint-model-egress:recommended',
      'api-memory-limit:recommended',
      'pgvector-extension:required',
      'api-ffmpeg:recommended',
      'voiceprint-model-cache:recommended',
    ]);
  });
});

describe('voiceprint-model-egress', () => {
  it('passes from the host and from the running container', async () => {
    const fake = docker({ exec: () => ok('{"ok":true}\n') });
    const result = await checks({ run: fake.run }).get('voiceprint-model-egress').run(context({}));

    expect(result).toEqual({ status: 'pass', detail: 'reachable from the host and the api container' });
    expect(fake.execs[0]?.[0]).toBe('node');
  });

  it('passes on the host alone when no api container runs, and says so', async () => {
    const result = await checks({ run: docker({ running: false }).run }).get('voiceprint-model-egress').run(context({}));
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('the api container is not running');
  });

  it('warns naming both hosts when the host cannot reach it', async () => {
    const result = await checks({ hostProbe: async () => ({ ok: false, reason: 'timed out' }) })
      .get('voiceprint-model-egress')
      .run(context({}));

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('the host cannot reach it (timed out)');
    expect(result.remedy).toContain('github.com');
    expect(result.remedy).toContain('release-assets.githubusercontent.com');
  });

  it('warns when only the container is blocked', async () => {
    const fake = docker({ exec: () => ok('{"ok":false,"reason":"the connection failed"}') });
    const result = await checks({ run: fake.run }).get('voiceprint-model-egress').run(context({}));

    expect(result.status).toBe('warn');
    expect(result.detail).toBe('the api container cannot reach it (the connection failed)');
  });

  it('warns when the container cannot run the probe at all', async () => {
    const fake = docker({ exec: () => exited(1, 'boom') });
    const result = await checks({ run: fake.run }).get('voiceprint-model-egress').run(context({}));
    expect(result.detail).toContain('could not run the probe');
  });
});

describe('api-memory-limit', () => {
  const check = (hostGiB = 8) => checks({ hostMemoryBytes: () => hostGiB * GIB }).get('api-memory-limit');

  it('parses Docker sizes', () => {
    expect(parseMemorySize('512M')).toBe(512 * 1024 ** 2);
    expect(parseMemorySize('1g')).toBe(GIB);
    expect(parseMemorySize('2048m')).toBe(2 * GIB);
    expect(parseMemorySize('1073741824')).toBe(GIB);
    expect(parseMemorySize('lots')).toBeUndefined();
  });

  it('skips on a fresh host (no environment) and names the new default', async () => {
    const result = await check().run(context(undefined));
    expect(result.status).toBe('skip');
    expect(result.detail).toContain(DEFAULT_API_MEM_LIMIT);
  });

  it('warns below 1G with the remedy', async () => {
    const result = await check().run(context({ API_MEM_LIMIT: '512M' }));

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('512M');
    expect(result.remedy).toBe(
      'Set API_MEM_LIMIT=1G in /opt/infra/apps/app-x/repo/infra/compose/.env and run kvox deploy update --force',
    );
  });

  it('passes at 1G, and for an unset key reports the default', async () => {
    expect((await check().run(context({ API_MEM_LIMIT: '1G' }))).status).toBe('pass');
    const unset = await check().run(context({}));
    expect(unset).toEqual({ status: 'pass', detail: '1G (the default)' });
  });

  it('warns above 75% of host RAM', async () => {
    const result = await check(2).run(context({ API_MEM_LIMIT: '2G' }));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('75%');
    expect(result.detail).toContain('2.0 GiB');
  });

  it('warns on an unparsable value', async () => {
    expect((await check().run(context({ API_MEM_LIMIT: 'lots' }))).status).toBe('warn');
  });
});

describe('pgvector-extension', () => {
  const run = (exec: (argv: string[]) => DockerRunResult, running = true) =>
    checks({ run: docker({ exec, running }).run }).get('pgvector-extension').run(context({}));

  it('passes when the extension is installed', async () => {
    const result = await run(() => ok('{"ok":true,"available":true,"installed":true}'));
    expect(result.status).toBe('pass');
  });

  it('fails when it is available but not installed, with the SQL and the runbook', async () => {
    const result = await run(() => ok('{"ok":true,"available":true,"installed":false}'));

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not installed');
    expect(result.remedy).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
    expect(result.remedy).toContain('docs/runbooks/application-role.md');
  });

  it('fails when the server does not have it at all', async () => {
    const result = await run(() => ok('{"ok":true,"available":false,"installed":false}'));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not available');
  });

  it('skips, never fails, when no api container runs (a fresh install is not blocked)', async () => {
    const result = await run(() => ok(''), false);
    expect(result.status).toBe('skip');
  });

  it('skips when docker cannot be asked or the database cannot be queried', async () => {
    expect((await checks({ run: docker({ unavailable: true }).run }).get('pgvector-extension').run(context({}))).status).toBe('skip');
    const unreachable = await run(() => ok('{"ok":false,"error":"ECONNREFUSED"}'));
    expect(unreachable.status).toBe('skip');
    expect(unreachable.detail).toContain('ECONNREFUSED');
  });

  it('is required and runs after the docker daemon check', () => {
    const check = checks().get('pgvector-extension');
    expect(check.severity).toBe('required');
    expect(check.requires).toEqual(['docker-daemon']);
  });
});

describe('api-ffmpeg', () => {
  const run = (exec: (argv: string[]) => DockerRunResult, running = true) =>
    checks({ run: docker({ exec, running }).run }).get('api-ffmpeg').run(context({}));

  it('passes and shows the version line', async () => {
    const seen: string[][] = [];
    const result = await run((argv) => {
      seen.push(argv);
      return ok('ffmpeg version 6.1.1 Copyright (c) 2000-2023\nbuilt with gcc');
    });
    expect(result).toEqual({ status: 'pass', detail: 'ffmpeg version 6.1.1 Copyright (c) 2000-2023' });
    expect(seen).toEqual([['ffmpeg', '-version']]);
  });

  it('warns when ffmpeg does not run, with the rebuild remedy', async () => {
    const result = await run(() => exited(127));
    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('deploy update --force');
  });

  it('skips when no container runs', async () => {
    expect((await run(() => ok(''), false)).status).toBe('skip');
  });
});

describe('voiceprint-model-cache', () => {
  const run = (exec: (argv: string[]) => DockerRunResult, running = true) =>
    checks({ run: docker({ exec, running }).run }).get('voiceprint-model-cache').run(context({}));

  it('asks the model script for its status and passes when installed', async () => {
    const seen: string[][] = [];
    const result = await run((argv) => {
      seen.push(argv);
      return ok('{"installed":true,"model":"m","dir":"/var/lib/voiceprint-models"}');
    });

    expect(result).toEqual({ status: 'pass', detail: 'installed in /var/lib/voiceprint-models' });
    expect(seen).toEqual([['node', '/app/apps/api/scripts/voiceprint-model.js', 'status']]);
  });

  it('warns when not installed, offering the update and the first-use download', async () => {
    const result = await run(() => ok('{"installed":false,"model":"m","dir":"/tmp/x"}'));

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('deploy update --force');
    expect(result.remedy).toContain('first voice job');
  });

  it('warns when the script cannot be read (an older image), and skips without a container', async () => {
    expect((await run(() => exited(1, 'Error: Cannot find module'))).status).toBe('warn');
    expect((await run(() => ok(''), false)).status).toBe('skip');
  });
});
