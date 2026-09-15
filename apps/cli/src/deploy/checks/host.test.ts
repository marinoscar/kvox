import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../executor.js';
import { HOST_CHECKS, evaluateDf, evaluateUfw } from './host.js';
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
  if (line.startsWith('docker network inspect devnet')) return { exitCode: 0, stdout: '[{"Name":"devnet"}]' };
  if (line.startsWith('git --version')) return { exitCode: 0, stdout: 'git version 2.43.0' };
  if (line.startsWith('df -Pk')) {
    return {
      exitCode: 0,
      stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 10000000 80000000 12% /',
    };
  }
  // The GitHub CLI, installed and logged in (github.test.ts covers the detail).
  if (line.startsWith('gh --version')) return { exitCode: 0, stdout: 'gh version 2.40.1 (2023-12-13)' };
  if (line.startsWith('gh auth status')) return { exitCode: 0, stdout: 'Logged in to github.com account octocat' };
  if (line.startsWith('gh repo view')) return { exitCode: 0, stdout: '{"name":"r"}' };
  // The containerised proxy: found by its published port, on the host
  // network, with a valid config and IPv6 - and the certbot image pulled.
  if (line.startsWith('docker ps --filter publish=443')) return { exitCode: 0, stdout: 'proxy-nginx' };
  if (line.startsWith('docker ps')) return { exitCode: 0, stdout: '' };
  if (line.includes('{{.State.Running}}')) return { exitCode: 0, stdout: 'true' };
  if (line.includes('{{.HostConfig.NetworkMode}}')) return { exitCode: 0, stdout: 'host' };
  if (line.startsWith('docker image inspect certbot/certbot')) return { exitCode: 0, stdout: 'certbot/certbot:latest' };
  if (line.startsWith('docker exec proxy-nginx nginx -t')) return { exitCode: 0, stderr: 'nginx: configuration file /etc/nginx/nginx.conf test is successful' };
  if (line.includes('cat /proc/net/if_inet6')) return { exitCode: 0, stdout: '00000000000000000000000000000001 01 80 10 80 lo' };
  if (line.startsWith('ufw status')) return { exitCode: 0, stdout: 'Status: active\n\nTo   Action   From\n80/tcp   ALLOW   Anywhere\n443/tcp  ALLOW   Anywhere' };
  return undefined;
};

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    runCommand: fakeRunCommand(HEALTHY),
    deployRoot: '/opt/infra/apps/demo',
    name: 'demo',
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
    // Nothing skipped either: on a healthy box every host check has an answer.
    expect(results.filter((result) => result.status === 'skip')).toEqual([]);
  });

  it('never spawns certbot or nginx on the host', async () => {
    // Epic #118, decision 3: the proxy is a container and certificates come
    // from `docker run certbot/certbot`. A host binary is never consulted.
    const seen: string[] = [];
    await runChecks(
      HOST_CHECKS,
      context({
        runCommand: fakeRunCommand((argv) => {
          seen.push(argv[0] ?? '');
          return HEALTHY(argv);
        }),
      }),
    );

    expect(seen).not.toContain('certbot');
    expect(seen).not.toContain('nginx');
    expect(HOST_CHECKS.map((check) => check.id)).not.toContain('certbot-installed');
  });

  it('skips every proxy-related check under --skip-proxy, and still passes', async () => {
    // The pipeline must be runnable where there is no proxy at all (CI), so
    // a preflight told to ignore the proxy must not fail on it.
    const results = await runChecks(
      HOST_CHECKS,
      context({
        skipProxy: true,
        fs: emptyFs,
        portListening: async () => false,
        runCommand: fakeRunCommand((argv) => {
          const line = argv.join(' ');
          // `docker network inspect devnet` is the devnet check, not a proxy
          // probe: it must keep answering healthily here.
          if (line.startsWith('docker network')) return HEALTHY(argv);
          if (line.startsWith('docker ps') || line.includes('inspect') || line.startsWith('docker exec') || line.startsWith('ufw')) {
            return { exitCode: 1, stderr: 'no such container' };
          }
          return HEALTHY(argv);
        }),
      }),
    );

    const byId = new Map(results.map((result) => [result.id, result]));
    for (const id of [
      'proxy-root',
      'proxy-container',
      'proxy-network-mode',
      'proxy-ipv6',
      'certbot-image',
      'port-80-listening',
      'port-443-listening',
      'proxy-config-valid',
      'ufw-ports',
    ]) {
      expect(byId.get(id)?.status, id).toBe('skip');
      expect(byId.get(id)?.detail, id).toBe('--skip-proxy');
    }
    // Dependants of a skipped check skip too, through `requires`.
    expect(byId.get('proxy-conf-writable')?.status).toBe('skip');
    expect(byId.get('acme-webroot')?.status).toBe('skip');
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

  it('hands a skipped prerequisite reason down, so a flag reads the same throughout', async () => {
    const flagged: Check = {
      ...ok,
      id: 'flagged',
      run: async () => ({ status: 'skip', detail: '--skip-proxy' }),
    };
    const results = await runChecks([flagged, { ...dependent, requires: ['flagged'] }], context());

    expect(results[1]?.status).toBe('skip');
    expect(results[1]?.detail).toBe('--skip-proxy');
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

describe('docker-network-devnet', () => {
  it('passes when the network exists', async () => {
    const result = await find('docker-network-devnet').run(context());
    expect(result.status).toBe('pass');
  });

  it('fails with the exact create command when it does not', async () => {
    // base.compose.yml declares it external, so `up -d` on a box without it
    // fails naming the network but not the command; the remedy is the command.
    const result = await find('docker-network-devnet').run(
      context({
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker network inspect')
            ? { exitCode: 1, stderr: 'Error: No such network: devnet' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('docker network create devnet');
  });

  it('is required and waits for the daemon', () => {
    const check = find('docker-network-devnet');
    expect(check.severity).toBe('required');
    expect(check.requires).toContain('docker-daemon');
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

  it('recognises its own containers by the compose project name, not the directory', async () => {
    // The project is pinned with `-p <name>` (#119); a deployment whose
    // directory happens to differ from its name still owns `<name>-nginx-1`.
    const result = await find('bind-port-free').run(
      context({
        deployRoot: '/srv/somewhere-else',
        name: 'demo',
        portFree: async () => false,
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker ps')
            ? { exitCode: 0, stdout: 'demo-nginx-1' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('pass');
  });

  it('does not claim a container that merely contains the name', async () => {
    const result = await find('bind-port-free').run(
      context({
        name: 'app',
        portFree: async () => false,
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker ps')
            ? { exitCode: 0, stdout: 'other-app-nginx-1' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('other-app-nginx-1');
  });

  it('cannot recognise anything as its own before a name is chosen', async () => {
    const result = await find('bind-port-free').run(
      context({
        name: undefined,
        portFree: async () => false,
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker ps')
            ? { exitCode: 0, stdout: 'demo-nginx-1' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('fail');
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

  it('validates the config inside the container it found, never on the host', async () => {
    const seen: string[][] = [];
    const result = await find('proxy-config-valid').run(
      context({
        proxyContainer: 'edge',
        runCommand: fakeRunCommand((argv) => {
          seen.push([...argv]);
          return argv.join(' ').startsWith('docker exec edge nginx -t')
            ? { exitCode: 0, stderr: 'syntax is ok' }
            : HEALTHY(argv);
        }),
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('edge');
    expect(seen).toEqual([['docker', 'exec', 'edge', 'nginx', '-t']]);
  });

  it('warns when the shared proxy config is already broken', async () => {
    const result = await find('proxy-config-valid').run(
      context({
        proxyContainer: 'proxy-nginx',
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker exec proxy-nginx nginx -t')
            ? { exitCode: 1, stderr: 'nginx: [emerg] unknown directive "bogus"' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('unknown directive');
    expect(result.remedy).toContain('every site');
  });

  it('is skipped by the runner when no proxy container was found', async () => {
    // Without a container there is nothing to exec into; `requires` handles it.
    const results = await runChecks(
      HOST_CHECKS,
      context({
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('docker ps') || argv.join(' ').includes('{{.State.Running}}')
            ? { exitCode: 1, stderr: 'No such object' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(results.find((result) => result.id === 'proxy-container')?.status).toBe('fail');
    expect(results.find((result) => result.id === 'proxy-config-valid')?.status).toBe('skip');
  });
});

describe('proxy-container', () => {
  it('finds the container publishing 443 and records it for the later checks', async () => {
    const ctx = context();
    const result = await find('proxy-container').run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toBe('proxy-nginx');
    // Written into the context so proxy-config-valid execs into the same one.
    expect(ctx.proxyContainer).toBe('proxy-nginx');
  });

  it('verifies the name the operator gave rather than searching', async () => {
    const seen: string[][] = [];
    const ctx = context({
      proxyContainer: 'edge',
      runCommand: fakeRunCommand((argv) => {
        seen.push([...argv]);
        return HEALTHY(argv);
      }),
    });
    const result = await find('proxy-container').run(ctx);

    expect(result.status).toBe('pass');
    expect(result.detail).toBe('edge');
    expect(seen).toEqual([['docker', 'inspect', '--format', '{{.State.Running}}', 'edge']]);
  });

  it('fails when the named container is not running', async () => {
    const result = await find('proxy-container').run(
      context({
        proxyContainer: 'edge',
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').includes('{{.State.Running}}')
            ? { exitCode: 0, stdout: 'false' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('edge');
    expect(result.remedy).toContain('docker compose up -d');
  });

  it('falls back to the conventional name when nothing publishes 443', async () => {
    // A proxy on network_mode: host has no published ports for the filter to
    // find - which is exactly the configuration the vhost needs.
    const ctx = context({
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ').startsWith('docker ps --filter publish=443')
          ? { exitCode: 0, stdout: '' }
          : HEALTHY(argv),
      ),
    });
    const result = await find('proxy-container').run(ctx);

    expect(result.status).toBe('pass');
    expect(ctx.proxyContainer).toBe('proxy-nginx');
  });

  it('fails with the compose command when no proxy is running at all', async () => {
    const result = await find('proxy-container').run(
      context({
        runCommand: fakeRunCommand((argv) => {
          const line = argv.join(' ');
          if (line.startsWith('docker ps')) return { exitCode: 0, stdout: '' };
          if (line.includes('{{.State.Running}}')) return { exitCode: 1, stderr: 'Error: No such object: proxy-nginx' };
          return HEALTHY(argv);
        }),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('cd /opt/infra/proxy && docker compose up -d');
    expect(result.remedy).toContain('--proxy-container');
  });
});

describe('proxy-network-mode', () => {
  it('passes on network_mode: host', async () => {
    const result = await find('proxy-network-mode').run(context({ proxyContainer: 'proxy-nginx' }));
    expect(result.status).toBe('pass');
  });

  it('warns on a bridged proxy, explaining that 127.0.0.1 is unreachable from it', async () => {
    const result = await find('proxy-network-mode').run(
      context({
        proxyContainer: 'proxy-nginx',
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').includes('{{.HostConfig.NetworkMode}}')
            ? { exitCode: 0, stdout: 'bridge' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('bridge');
    expect(result.remedy).toContain('127.0.0.1:3535');
    expect(result.remedy).toContain('network_mode: host');
  });
});

describe('certbot-image', () => {
  it('passes when the image has been pulled', async () => {
    const result = await find('certbot-image').run(context());
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('certbot/certbot');
  });

  it('fails with the pull command, and never pulls itself', async () => {
    const seen: string[][] = [];
    const result = await find('certbot-image').run(
      context({
        runCommand: fakeRunCommand((argv) => {
          seen.push([...argv]);
          return argv.join(' ').startsWith('docker image inspect')
            ? { exitCode: 1, stderr: 'Error: No such image: certbot/certbot' }
            : HEALTHY(argv);
        }),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('docker pull certbot/certbot');
    // Rule 4: doctor is read-only. The pull is the remedy, not the check.
    expect(seen.some((argv) => argv.includes('pull'))).toBe(false);
  });
});

describe('proxy-ipv6', () => {
  it('passes and records ipv6 when the container has an address', async () => {
    const ctx = context({ proxyContainer: 'proxy-nginx' });
    const result = await find('proxy-ipv6').run(ctx);

    expect(result.status).toBe('pass');
    expect(ctx.ipv6).toBe(true);
  });

  it('accepts the host table when the container cannot answer', async () => {
    const ctx = context({
      proxyContainer: 'proxy-nginx',
      fs: { ...permissiveFs, readFile: () => 'fe800000000000000000000000000001 02 40 20 80 eth0\n' },
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ').includes('if_inet6') ? { exitCode: 1, stderr: 'no such file' } : HEALTHY(argv),
      ),
    });
    const result = await find('proxy-ipv6').run(ctx);

    expect(result.status).toBe('pass');
    expect(ctx.ipv6).toBe(true);
  });

  it('warns, naming --no-ipv6, when neither has one', async () => {
    const ctx = context({
      proxyContainer: 'proxy-nginx',
      fs: { ...permissiveFs, readFile: () => '' },
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ').includes('if_inet6') ? { exitCode: 0, stdout: '' } : HEALTHY(argv),
      ),
    });
    const result = await find('proxy-ipv6').run(ctx);

    // nginx -t passes on `listen [::]` with IPv6 off; the reload is what fails.
    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('--no-ipv6');
    expect(ctx.ipv6).toBe(false);
  });
});

describe('ufw-ports', () => {
  it('skips when ufw is not installed', async () => {
    const result = await find('ufw-ports').run(
      context({
        runCommand: fakeRunCommand((argv) =>
          argv[0] === 'ufw' ? undefined : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('skip');
  });

  it('passes on an inactive firewall and on one allowing both ports', () => {
    expect(evaluateUfw('Status: inactive').status).toBe('pass');
    expect(evaluateUfw('Status: active\n80,443/tcp  ALLOW  Anywhere').status).toBe('pass');
    expect(evaluateUfw("Status: active\nNginx Full  ALLOW  Anywhere").status).toBe('pass');
  });

  it('warns with the ufw allow commands when a port is blocked', () => {
    const result = evaluateUfw('Status: active\n\n22/tcp  ALLOW  Anywhere\n80/tcp  ALLOW  Anywhere');

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('443');
    expect(result.remedy).toContain('ufw allow 443/tcp');
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
