import { describe, expect, it } from 'vitest';

import type { CommandResult, RunCommandOptions } from './executor.js';
import {
  collectServerFacts,
  parseComposeVersion,
  parseDockerVersion,
  parseOsRelease,
  type ServerFacts,
  type ServerProbes,
} from './server-facts.js';

const DF = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 78125000 10000000 68000000 13% /\n';

/** A host where every probe answers. */
function healthyProbes(): ServerProbes {
  return {
    hostname: () => 'vps-1',
    release: () => '6.8.0-45-generic',
    arch: () => 'x64',
    cpus: () => [{ model: 'AMD EPYC 7B13' }, { model: 'AMD EPYC 7B13' }],
    totalmem: () => 4096000000,
    readFile: () => 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n',
    nodeVersion: () => 'v22.11.0',
  };
}

/** Answers `df`, `docker --version` and `docker compose version --short`. */
function healthyCommands(
  override?: (argv: readonly string[]) => string | Error | undefined,
): typeof import('./executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const overridden = override?.(argv);
    if (overridden instanceof Error) throw overridden;

    const joined = argv.join(' ');
    const stdout =
      overridden ??
      (joined.startsWith('df ')
        ? DF
        : joined === 'docker --version'
          ? 'Docker version 27.3.1, build 1234abc\n'
          : joined === 'docker compose version --short'
            ? 'v2.29.7\n'
            : '');

    return {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
  }) as typeof import('./executor.js').runCommand;
}

const HEALTHY: ServerFacts = {
  hostname: 'vps-1',
  os: 'Ubuntu 24.04.1 LTS',
  kernel: '6.8.0-45-generic',
  arch: 'x64',
  cpuModel: 'AMD EPYC 7B13',
  cpus: 2,
  memoryBytes: 4096000000,
  diskBytes: 78125000 * 1024,
  dockerVersion: '27.3.1',
  composeVersion: '2.29.7',
  nodeVersion: '22.11.0',
};

describe('collectServerFacts', () => {
  it('reads every fact when every probe answers', async () => {
    const facts = await collectServerFacts({
      runCommand: healthyCommands(),
      root: '/opt/infra/apps/demo',
      probes: healthyProbes(),
    });

    expect(facts).toEqual(HEALTHY);
  });

  it('asks df about the deploy root, not the working directory', async () => {
    const seen: string[][] = [];
    await collectServerFacts({
      runCommand: healthyCommands((argv) => {
        seen.push([...argv]);
        return undefined;
      }),
      root: '/opt/infra/apps/demo',
      probes: healthyProbes(),
    });

    expect(seen).toContainEqual(['df', '-Pk', '/opt/infra/apps/demo']);
  });

  // One case per probe, each failing ALONE: the point of the module is that
  // no single missing thing takes the others with it, and a table proves it
  // for each rather than for "some".
  const failing: [keyof ServerFacts, Partial<ServerProbes>][] = [
    ['hostname', { hostname: () => { throw new Error('no hostname'); } }],
    ['os', { readFile: () => { throw new Error('ENOENT'); } }],
    ['kernel', { release: () => { throw new Error('no kernel'); } }],
    ['arch', { arch: () => '' }],
    ['memoryBytes', { totalmem: () => Number.NaN }],
    ['nodeVersion', { nodeVersion: () => '' }],
  ];

  it.each(failing)('reports %s as null when only that probe fails', async (key, probes) => {
    const facts = await collectServerFacts({
      runCommand: healthyCommands(),
      root: '/x',
      probes: { ...healthyProbes(), ...probes },
    });

    expect(facts).toEqual({ ...HEALTHY, [key]: null });
  });

  it('reports both cpu facts as null when the cpu list is empty or throws', async () => {
    for (const cpus of [() => [], () => { throw new Error('no cpus'); }]) {
      const facts = await collectServerFacts({
        runCommand: healthyCommands(),
        root: '/x',
        probes: { ...healthyProbes(), cpus },
      });

      expect(facts).toEqual({ ...HEALTHY, cpuModel: null, cpus: null });
    }
  });

  const failingCommands: [keyof ServerFacts, string][] = [
    ['diskBytes', 'df'],
    ['dockerVersion', 'docker --version'],
    ['composeVersion', 'docker compose version'],
  ];

  it.each(failingCommands)('reports %s as null when only `%s` fails', async (key, prefix) => {
    const facts = await collectServerFacts({
      runCommand: healthyCommands((argv) =>
        argv.join(' ').startsWith(prefix) ? new Error(`${prefix}: not found`) : undefined,
      ),
      root: '/x',
      probes: healthyProbes(),
    });

    expect(facts).toEqual({ ...HEALTHY, [key]: null });
  });

  it('reports diskBytes as null when df answers something unparseable', async () => {
    const facts = await collectServerFacts({
      runCommand: healthyCommands((argv) => (argv[0] === 'df' ? 'nonsense' : undefined)),
      root: '/x',
      probes: healthyProbes(),
    });

    expect(facts.diskBytes).toBeNull();
  });

  it('never throws, even when everything fails at once', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    const facts = await collectServerFacts({
      runCommand: healthyCommands(() => new Error('boom')),
      root: '/x',
      probes: {
        hostname: boom,
        release: boom,
        arch: boom,
        cpus: boom,
        totalmem: boom,
        readFile: boom,
        nodeVersion: boom,
      },
    });

    expect(Object.values(facts).every((value) => value === null)).toBe(true);
  });
});

describe('the parsers', () => {
  it('reads PRETTY_NAME, quoted or not', () => {
    expect(parseOsRelease('PRETTY_NAME="Ubuntu 24.04.1 LTS"\n')).toBe('Ubuntu 24.04.1 LTS');
    expect(parseOsRelease('ID=debian\nPRETTY_NAME=Debian GNU/Linux 12 (bookworm)\n')).toBe(
      'Debian GNU/Linux 12 (bookworm)',
    );
    expect(parseOsRelease('ID=alpine\n')).toBeNull();
    expect(parseOsRelease('PRETTY_NAME=""\n')).toBeNull();
  });

  it('reads the docker version out of its banner', () => {
    expect(parseDockerVersion('Docker version 27.3.1, build 1234abc')).toBe('27.3.1');
    expect(parseDockerVersion('Docker version 24.0.7-ce, build afdd53b')).toBe('24.0.7-ce');
    expect(parseDockerVersion('command not found')).toBeNull();
  });

  it('reads the compose version with or without the v', () => {
    expect(parseComposeVersion('v2.29.7\n')).toBe('2.29.7');
    expect(parseComposeVersion('2.29.7')).toBe('2.29.7');
    expect(parseComposeVersion('')).toBeNull();
  });
});
