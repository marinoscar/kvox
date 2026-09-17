import { describe, expect, it } from 'vitest';

import {
  COMPOSE_PROJECT_LABEL,
  DOCKER_QUERY_TIMEOUT_MS,
  dockerPortClaims,
  parseDockerPortLines,
} from './docker-ports.js';
import {
  CommandFailedError,
  type CommandResult,
  type RunCommandOptions,
} from './executor.js';

// =============================================================================
// Docker's own port claims  (issue #257)
// =============================================================================
//
// Every fixture below is real `docker inspect` output, captured against a live
// daemon rather than invented - the whole point of this module is that a
// STOPPED container's bindings survive in `HostConfig.PortBindings`, and a
// fixture somebody guessed would prove nothing about that.
// =============================================================================

type Runner = typeof import('./executor.js').runCommand;

interface Canned {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  throws?: Error;
}

/** A command table, plus the argv it was actually called with. */
function runner(table: (line: string) => Canned): {
  run: Runner;
  calls: () => readonly (readonly string[])[];
  timeouts: () => readonly (number | undefined)[];
} {
  const calls: (readonly string[])[] = [];
  const timeouts: (number | undefined)[] = [];

  const run = (async (
    argv: readonly string[],
    options: RunCommandOptions,
  ): Promise<CommandResult> => {
    calls.push([...argv]);
    timeouts.push(options.timeoutMs);
    const canned = table(argv.join(' '));
    if (canned.throws !== undefined) throw canned.throws;
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode ?? 0,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) throw new CommandFailedError(result.stderr, result);
    return result;
  }) as Runner;

  return { run, calls: () => calls, timeouts: () => timeouts };
}

describe('parseDockerPortLines', () => {
  it('reads the bindings of a container that has never been started', () => {
    // Captured from a real daemon. The same container's `docker ps -a` Ports
    // column and `.NetworkSettings.Ports` are both EMPTY, which is exactly why
    // this module reads HostConfig instead.
    const claims = parseDockerPortLines('/portverify||18080 18081\n');

    expect(claims).toEqual([
      { name: 'portverify', port: 18080 },
      { name: 'portverify', port: 18081 },
    ]);
  });

  it('expands a published range, which docker has already split per port', () => {
    // `-p 18090-18092:80-82` is stored as three separate bindings at create
    // time; nothing here has to understand range syntax.
    expect(parseDockerPortLines('/portrange||18090 18091 18092').map((c) => c.port)).toEqual([
      18090, 18091, 18092,
    ]);
  });

  it('ignores an unpublished mapping, whose HostPort is empty', () => {
    // `-p 80` with no host port means "docker picks one at start". It is not a
    // claim on any port, and must never be read as a claim on port 0.
    expect(parseDockerPortLines('/portrandom|demo| ')).toEqual([]);
  });

  it('carries the compose project, which is how the app knows its own containers', () => {
    expect(parseDockerPortLines('/demo-nginx-1|demo|3535')).toEqual([
      { name: 'demo-nginx-1', port: 3535, project: 'demo' },
    ]);
  });

  it('leaves the project off a container compose did not start', () => {
    const [claim] = parseDockerPortLines('/pgadmin||5050');

    expect(claim?.project).toBeUndefined();
  });

  it('keeps the containers it understands when one line is malformed', () => {
    // A docker version that renders one container oddly must not cost the
    // scan the other nine.
    const claims = parseDockerPortLines(
      ['/good||3535', 'nonsense with no separators', '', '/also-good|proj|3536'].join('\n'),
    );

    expect(claims.map((claim) => claim.name)).toEqual(['good', 'also-good']);
  });

  it('drops a port that is not a port', () => {
    expect(parseDockerPortLines('/weird||0 65536 -1 abc 3535').map((c) => c.port)).toEqual([3535]);
  });

  it('answers nothing for garbage', () => {
    expect(parseDockerPortLines('')).toEqual([]);
    expect(parseDockerPortLines('Error: No such object: deadbeef')).toEqual([]);
  });
});

describe('dockerPortClaims', () => {
  const TWO_CONTAINERS = ['/demo-nginx-1|demo|3535', '/pgadmin||5050 5051'].join('\n');

  it('lists every container including stopped ones, then inspects them', async () => {
    const { run, calls, timeouts } = runner((line) =>
      line.startsWith('docker ps')
        ? { stdout: 'aaaaaaaaaaaa\nbbbbbbbbbbbb\n' }
        : { stdout: TWO_CONTAINERS },
    );

    const claims = await dockerPortClaims({ cwd: '/srv/app', runCommand: run });

    // `-a`, not a bare `ps`: a stopped container is the case this exists for.
    expect(calls()[0]).toEqual(['docker', 'ps', '-aq']);
    // argv, never a shell string: the ids are separate arguments.
    expect(calls()[1]?.slice(0, 3)).toEqual(['docker', 'inspect', '--format']);
    expect(calls()[1]?.slice(-2)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(calls()[1]?.[3]).toContain(COMPOSE_PROJECT_LABEL);
    expect(calls()[1]?.[3]).toContain('HostConfig.PortBindings');
    // Short, so a wedged socket costs seconds rather than the install.
    expect(timeouts()).toEqual([DOCKER_QUERY_TIMEOUT_MS, DOCKER_QUERY_TIMEOUT_MS]);

    expect(claims).toEqual([
      { name: 'demo-nginx-1', port: 3535, project: 'demo' },
      { name: 'pgadmin', port: 5050 },
      { name: 'pgadmin', port: 5051 },
    ]);
  });

  it('does not inspect anything when there are no containers', async () => {
    const { run, calls } = runner(() => ({ stdout: '\n' }));

    expect(await dockerPortClaims({ cwd: '/srv/app', runCommand: run })).toEqual([]);
    expect(calls()).toHaveLength(1);
  });

  it('answers nothing when docker is not installed', async () => {
    const { run } = runner(() => ({ throws: new Error('spawn docker ENOENT') }));

    expect(await dockerPortClaims({ cwd: '/srv/app', runCommand: run })).toEqual([]);
  });

  it('answers nothing when the socket refuses', async () => {
    const { run } = runner(() => ({
      exitCode: 1,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    }));

    expect(await dockerPortClaims({ cwd: '/srv/app', runCommand: run })).toEqual([]);
  });

  it('answers nothing when the inspect half fails, not just the list', async () => {
    const { run } = runner((line) =>
      line.startsWith('docker ps')
        ? { stdout: 'aaaaaaaaaaaa\n' }
        : { throws: new Error('timed out') },
    );

    expect(await dockerPortClaims({ cwd: '/srv/app', runCommand: run })).toEqual([]);
  });

  it('honours an overridden timeout', async () => {
    const { run, timeouts } = runner(() => ({ stdout: '' }));

    await dockerPortClaims({ cwd: '/srv/app', runCommand: run, timeoutMs: 250 });

    expect(timeouts()).toEqual([250]);
  });
});
