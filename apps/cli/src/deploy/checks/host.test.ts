import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../executor.js';
import { HOST_CHECKS, evaluateDf } from './host.js';
import { ALL_CHECKS, requiredChecks } from './index.js';
import {
  checksPassed,
  runChecks,
  summarise,
  type Check,
  type CheckContext,
  type CheckFs,
} from './types.js';

// =============================================================================
// Checks are driven through an injected runCommand returning canned output.
// The point of a check is what it CONCLUDES from a tool's output, so the
// interesting input is that output, not a real docker.
// =============================================================================

type Responder = (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined;

function fakeRunCommand(respond: Responder): typeof import('../executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const canned = respond(argv) ?? { exitCode: 127, stderr: `${argv[0]}: command not found` };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) {
      throw new CommandFailedError(result.stderr || 'failed', result);
    }
    return result;
  }) as typeof import('../executor.js').runCommand;
}

const permissiveFs: CheckFs = {
  exists: () => true,
  isDirectory: () => true,
  isWritable: () => true,
};

const emptyFs: CheckFs = {
  exists: () => false,
  isDirectory: () => false,
  isWritable: () => false,
};

/** A server where everything is in place. */
const HEALTHY: Responder = (argv) => {
  const line = argv.join(' ');
  if (line.startsWith('docker --version')) return { exitCode: 0, stdout: 'Docker version 27.3.1, build abc' };
  if (line.startsWith('docker info')) return { exitCode: 0, stdout: '27.3.1' };
  if (line.startsWith('docker compose version')) return { exitCode: 0, stdout: 'Docker Compose version v2.29.0' };
  if (line.startsWith('git --version')) return { exitCode: 0, stdout: 'git version 2.43.0' };
  if (line.startsWith('df -Pk')) {
    return {
      exitCode: 0,
      stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 10000000 80000000 12% /',
    };
  }
  if (line.startsWith('certbot --version')) return { exitCode: 0, stdout: 'certbot 2.9.0' };
  if (line.startsWith('nginx -t')) return { exitCode: 0, stderr: 'syntax is ok' };
  if (line.startsWith('docker ps')) return { exitCode: 0, stdout: '' };
  return undefined;
};

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    runCommand: fakeRunCommand(HEALTHY),
    deployRoot: '/opt/infra/apps/demo',
    bindPort: 3535,
    proxyRoot: '/opt/infra/proxy',
    fs: permissiveFs,
    totalMemoryBytes: () => 4 * 1024 * 1024 * 1024,
    portFree: async () => true,
    portListening: async () => true,
    ...overrides,
  };
}

function find(id: string): Check {
  const check = HOST_CHECKS.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
}

describe('the registry as a whole', () => {
  it('passes every check on a healthy server', async () => {
    const results = await runChecks(HOST_CHECKS, context());
    const bad = results.filter((result) => result.status === 'fail' || result.status === 'warn');

    expect(bad).toEqual([]);
    expect(checksPassed(results)).toBe(true);
  });

  it('gives every failing check an actionable remedy', async () => {
    // Rule 2 of the contract, asserted over the whole registry so a new check
    // cannot be added without one.
    const results = await runChecks(
      HOST_CHECKS,
      context({
        runCommand: fakeRunCommand(() => undefined), // nothing is installed
        fs: emptyFs,
        totalMemoryBytes: () => 512 * 1024 * 1024,
        portFree: async () => false,
        portListening: async () => false,
      }),
    );

    const withoutRemedy = results
      .filter((result) => result.status === 'fail' || result.status === 'warn')
      .filter((result) => result.remedy === undefined || result.remedy === '');

    expect(withoutRemedy).toEqual([]);
  });

  it('has unique, kebab-case ids', () => {
    const ids = ALL_CHECKS.map((check) => check.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
  });

  it('exposes the required subset install and update use as preflight', () => {
    expect(requiredChecks().every((check) => check.severity === 'required')).toBe(true);
    expect(requiredChecks().length).toBeGreaterThan(0);
  });
});

describe('runChecks', () => {
  const ok: Check = {
    id: 'ok',
    title: 'Fine',
    severity: 'required',
    run: async () => ({ status: 'pass', detail: 'yes' }),
  };
  const boom: Check = {
    id: 'boom',
    title: 'Explodes',
    severity: 'required',
    run: async () => {
      throw new Error('probe blew up');
    },
  };
  const dependent: Check = {
    id: 'dependent',
    title: 'Needs boom',
    severity: 'recommended',
    requires: ['boom'],
    run: async () => ({ status: 'pass', detail: 'ran anyway' }),
  };

  it('reports a check that throws as a failure and keeps going', async () => {
    const results = await runChecks([boom, ok], context());

    expect(results[0]?.status).toBe('fail');
    expect(results[0]?.detail).toContain('probe blew up');
    // Rule 1: the operator wants the whole list, not the first problem.
    expect(results[1]?.status).toBe('pass');
  });

  it('skips a check whose requirement did not pass, and says which', async () => {
    const results = await runChecks([boom, dependent], context());

    expect(results[1]?.status).toBe('skip');
    expect(results[1]?.detail).toContain('boom');
  });

  it('streams each result as it completes', async () => {
    const seen: string[] = [];
    await runChecks([ok, boom], context(), (result) => seen.push(result.id));

    expect(seen).toEqual(['ok', 'boom']);
  });

  it('counts a failed recommended check as a pass overall', async () => {
    const results = await runChecks(
      [{ ...ok, id: 'advice', severity: 'recommended', run: async () => ({ status: 'fail' as const, detail: 'x', remedy: 'y' }) }],
      context(),
    );

    // Failing on advice is how people learn to pass --force.
    expect(checksPassed(results)).toBe(true);
  });

  it('summarises by status', async () => {
    const results = await runChecks([ok, boom, dependent], context());

    expect(summarise(results)).toEqual({ passed: 1, warned: 0, failed: 1, skipped: 1 });
  });
});

describe('docker checks', () => {
  it('reports docker not installed with an install command', async () => {
    const result = await find('docker-installed').run(
      context({ runCommand: fakeRunCommand(() => undefined) }),
    );

    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('get.docker.com');
  });

  it('distinguishes a permission problem from a stopped daemon', async () => {
    const denied = await find('docker-daemon').run(
      context({
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker info')
            ? { exitCode: 1, stderr: 'permission denied while trying to connect to the Docker daemon socket' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(denied.status).toBe('fail');
    expect(denied.detail).toContain('permission denied');
    expect(denied.remedy).toContain('docker group');

    const stopped = await find('docker-daemon').run(
      context({
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker info')
            ? { exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(stopped.detail).toContain('not running');
    expect(stopped.remedy).toContain('systemctl start docker');
  });

  it('says so when only the legacy docker-compose binary exists', async () => {
    const result = await find('docker-compose-v2').run(
      context({
        runCommand: fakeRunCommand((argv) => {
          const line = argv.join(' ');
          if (line.startsWith('docker compose version')) return { exitCode: 1, stderr: "unknown command" };
          if (line.startsWith('docker-compose --version')) return { exitCode: 0, stdout: 'docker-compose version 1.29.2' };
          return HEALTHY(argv);
        }),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('legacy');
    expect(result.remedy).toContain('docker-compose-plugin');
  });
});

describe('evaluateDf', () => {
  const header = 'Filesystem 1024-blocks Used Available Capacity Mounted on';

  it('passes with plenty of space', () => {
    expect(evaluateDf(`${header}\n/dev/sda1 100000000 10000000 80000000 12% /`).status).toBe('pass');
  });

  it('fails when free space is below the build threshold', () => {
    const result = evaluateDf(`${header}\n/dev/sda1 100000000 99000000 1000000 99% /`);

    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('docker system prune');
  });

  it('fails clearly when the output cannot be parsed', () => {
    expect(evaluateDf('nonsense').status).toBe('fail');
  });
});

describe('bind-port-free', () => {
  it('passes when the port is free', async () => {
    const result = await find('bind-port-free').run(context({ portFree: async () => true }));
    expect(result.status).toBe('pass');
  });

  it('passes when the port is held by this deployment, as during an update', async () => {
    // A doctor run that reports a false failure against a healthy deployment
    // is how operators learn to ignore doctor.
    const result = await find('bind-port-free').run(
      context({
        portFree: async () => false,
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker ps')
            ? { exitCode: 0, stdout: 'demo-nginx-1' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('this deployment');
  });

  it('fails when the port belongs to something else, naming it', async () => {
    const result = await find('bind-port-free').run(
      context({
        portFree: async () => false,
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker ps')
            ? { exitCode: 0, stdout: 'someone-elses-app' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('someone-elses-app');
    expect(result.remedy).toContain('APP_BIND_PORT');
  });
});

describe('proxy checks', () => {
  it('fails when the proxy directory is absent', async () => {
    const result = await find('proxy-root').run(context({ fs: emptyFs }));

    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('--proxy-root');
  });

  it('fails when conf.d exists but is not writable', async () => {
    const result = await find('proxy-conf-writable').run(
      context({ fs: { ...permissiveFs, isWritable: () => false } }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not writable');
  });

  it('fails when the ACME webroot is missing, explaining what it is for', async () => {
    const result = await find('acme-webroot').run(context({ fs: emptyFs }));

    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('webroot');
  });

  it('skips the nginx -t check when there is no host nginx binary', async () => {
    // A containerised proxy is the documented setup, so this check simply
    // cannot answer - which is not the same as a problem.
    const result = await find('proxy-config-valid').run(
      context({ runCommand: fakeRunCommand(() => undefined) }),
    );

    expect(result.status).toBe('skip');
  });

  it('warns when the shared proxy config is already broken', async () => {
    const result = await find('proxy-config-valid').run(
      context({
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('nginx -t')
            ? { exitCode: 1, stderr: 'nginx: [emerg] unknown directive "bogus"' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('every site');
  });
});

describe('resource checks', () => {
  it('warns on a small-memory host', async () => {
    const result = await find('memory').run(
      context({ totalMemoryBytes: () => 1_900_000_000 }),
    );

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('OOM');
  });

  it('warns when nothing serves port 80', async () => {
    const result = await find('port-80-listening').run(
      context({ portListening: async () => false }),
    );

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('proxy');
  });
});
