import { describe, expect, it } from 'vitest';

import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  createDockerPortsCheck,
  dockerPortClaims,
  isPathUnder,
  parseDockerPortLines,
  type DockerRunner,
} from './docker-ports.check.js';

// The docker output shapes below were confirmed against a real daemon on a
// created-but-never-started container (#257): `HostConfig.PortBindings` survives
// the container being stopped, `NetworkSettings.Ports` does not.

const CONTEXT = {
  deployRoot: '/opt/infra/apps/myapp',
  bindPort: 3535,
  proxyRoot: '/opt/infra/proxy',
  domain: undefined,
  env: undefined,
  skipProxy: false,
} as const;

function docker(answers: { ps: string; inspect: string } | 'down'): DockerRunner {
  return async (args) => {
    if (answers === 'down') throw new Error('Cannot connect to the Docker daemon');
    if (args[0] === 'ps') return answers.ps;
    if (args[0] === 'inspect') return answers.inspect;
    throw new Error(`unexpected docker ${args[0]}`);
  };
}

describe('parseDockerPortLines', () => {
  it('reads name, compose project and every published host port', () => {
    expect(parseDockerPortLines('/pgadmin|tools|18080 18081 \n/web|myapp|3535 \n')).toEqual([
      { name: 'pgadmin', project: 'tools', port: 18080 },
      { name: 'pgadmin', project: 'tools', port: 18081 },
      { name: 'web', project: 'myapp', port: 3535 },
    ]);
  });

  it('leaves the project out for a container compose did not start', () => {
    expect(parseDockerPortLines('/handmade||9000 ')).toEqual([{ name: 'handmade', port: 9000 }]);
  });

  it('treats an unpublished mapping (empty HostPort) as no claim, not a claim on port 0', () => {
    expect(parseDockerPortLines('/internal|tools| ')).toEqual([]);
  });

  it('drops a line it does not understand without losing the others', () => {
    expect(parseDockerPortLines('garbage\n/a|p|8080 \n<no value>|x\n|p|9090 ')).toEqual([
      { name: 'a', project: 'p', port: 8080 },
    ]);
  });

  it('ignores out-of-range and non-numeric ports', () => {
    expect(parseDockerPortLines('/a|p|0 70000 http 443 ')).toEqual([{ name: 'a', project: 'p', port: 443 }]);
  });
});

describe('parseDockerPortLines: the compose working directory (fourth field)', () => {
  it('reads the working directory as the fourth field', () => {
    expect(parseDockerPortLines('/web|myapp|3535 |/opt/infra/apps/myapp/repo/infra/compose\n')).toEqual([
      { name: 'web', project: 'myapp', port: 3535, workingDir: '/opt/infra/apps/myapp/repo/infra/compose' },
    ]);
  });

  it('keeps the whole remainder of the line, spaces in the path included', () => {
    expect(parseDockerPortLines('/web|myapp|3535 |/opt/my apps/myapp/repo|x')).toEqual([
      { name: 'web', project: 'myapp', port: 3535, workingDir: '/opt/my apps/myapp/repo|x' },
    ]);
  });

  it('still parses the three-field lines, with no workingDir', () => {
    expect(parseDockerPortLines('/web|myapp|3535 ')).toEqual([{ name: 'web', project: 'myapp', port: 3535 }]);
  });

  it('leaves workingDir out when the fourth field is empty', () => {
    expect(parseDockerPortLines('/handmade||9000 |')).toEqual([{ name: 'handmade', port: 9000 }]);
  });

  it('gives every port of one container the same working directory', () => {
    expect(parseDockerPortLines('/web|myapp|80 443 |/srv/myapp')).toEqual([
      { name: 'web', project: 'myapp', port: 80, workingDir: '/srv/myapp' },
      { name: 'web', project: 'myapp', port: 443, workingDir: '/srv/myapp' },
    ]);
  });
});

describe('isPathUnder', () => {
  it('is true for the root itself', () => {
    expect(isPathUnder('/opt/infra/apps/myapp', '/opt/infra/apps/myapp')).toBe(true);
  });

  it('is true for a child and a deeper descendant', () => {
    expect(isPathUnder('/opt/infra/apps/myapp/repo', '/opt/infra/apps/myapp')).toBe(true);
    expect(isPathUnder('/opt/infra/apps/myapp/repo/infra/compose', '/opt/infra/apps/myapp')).toBe(true);
  });

  it('ignores a trailing slash on either side', () => {
    expect(isPathUnder('/opt/infra/apps/myapp/repo/', '/opt/infra/apps/myapp/')).toBe(true);
  });

  it('is false for a sibling whose name only starts with the root name', () => {
    expect(isPathUnder('/opt/infra/apps/myapp-2/repo', '/opt/infra/apps/myapp')).toBe(false);
  });

  it('is false for the parent and for an unrelated path', () => {
    expect(isPathUnder('/opt/infra/apps', '/opt/infra/apps/myapp')).toBe(false);
    expect(isPathUnder('/srv/other', '/opt/infra/apps/myapp')).toBe(false);
  });

  it('resolves `..` before comparing', () => {
    expect(isPathUnder('/opt/infra/apps/myapp/../other', '/opt/infra/apps/myapp')).toBe(false);
    expect(isPathUnder('/opt/infra/apps/myapp/repo/..', '/opt/infra/apps/myapp')).toBe(true);
  });
});

describe('the inspect format', () => {
  it('reads the create-time bindings and the compose project label', () => {
    let format = '';
    const run: DockerRunner = async (args) => {
      if (args[0] === 'ps') return 'abc\n';
      format = String(args[2]);
      return '';
    };

    return dockerPortClaims(run).then(() => {
      expect(format).toContain('.HostConfig.PortBindings');
      expect(format).not.toContain('NetworkSettings');
      expect(format).toContain(COMPOSE_PROJECT_LABEL);
      expect(format).toContain(COMPOSE_WORKING_DIR_LABEL);
    });
  });
});

describe('the bind-port-not-promised check', () => {
  it('fails when a STOPPED foreign container is configured to publish the port', async () => {
    const check = createDockerPortsCheck(docker({ ps: 'abc\n', inspect: '/pgadmin|tools|3535 \n' }));

    const result = await check.run(CONTEXT);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('pgadmin');
    expect(result.remedy).toContain('--port');
  });

  it("never counts this deployment's own containers (a resume is not refused by its own stack)", async () => {
    const check = createDockerPortsCheck(docker({ ps: 'abc\n', inspect: '/myapp-nginx-1|myapp|3535 \n' }));

    expect((await check.run(CONTEXT)).status).toBe('pass');
  });

  describe('with the deployment\'s recorded compose project', () => {
    const LEGACY = { ...CONTEXT, deployRoot: '/opt/infra/apps/kvox', composeProject: 'compose' };

    it('never counts a container of that project even when the folder name differs (legacy "compose")', async () => {
      const check = createDockerPortsCheck(docker({ ps: 'abc\n', inspect: '/compose-nginx-1|compose|3535 \n' }));

      expect((await check.run(LEGACY)).status).toBe('pass');
    });

    it('still fails on a container of another project and names it', async () => {
      const check = createDockerPortsCheck(
        docker({ ps: 'abc\ndef\n', inspect: '/compose-nginx-1|compose|3535 \n/web|other|3535 \n' }),
      );

      const result = await check.run(LEGACY);

      expect(result.status).toBe('fail');
      expect(result.detail).toContain('web');
      expect(result.detail).not.toContain('compose-nginx-1');
    });

    it('falls back to the folder name when no project is recorded', async () => {
      const check = createDockerPortsCheck(docker({ ps: 'abc\n', inspect: '/kvox-nginx-1|kvox|3535 \n' }));

      expect((await check.run({ ...CONTEXT, deployRoot: '/opt/infra/apps/kvox' })).status).toBe('pass');
    });

    it('does not use the folder name once a project is given', async () => {
      const check = createDockerPortsCheck(docker({ ps: 'abc\n', inspect: '/kvox-nginx-1|kvox|3535 \n' }));

      const result = await check.run({ ...CONTEXT, deployRoot: '/opt/infra/apps/kvox', composeProject: 'myapp' });

      expect(result.status).toBe('fail');
      expect(result.detail).toContain('kvox-nginx-1');
    });
  });

  describe('with the compose working directory (issue #736)', () => {
    const SERVER = { ...CONTEXT, deployRoot: '/opt/infra/apps/kvox', composeProject: 'compose' };

    it("passes for the deployment's own nginx started by the pre-platform CLI (the production failure)", async () => {
      const check = createDockerPortsCheck(
        docker({ ps: 'abc\n', inspect: '/kvox-nginx-1|kvox|3535 |/opt/infra/apps/kvox/repo/infra/compose\n' }),
      );

      const result = await check.run(SERVER);

      expect(result.status).toBe('pass');
    });

    it('still fails for a foreign container whose working directory is elsewhere', async () => {
      const check = createDockerPortsCheck(
        docker({ ps: 'abc\n', inspect: '/web|tools|3535 |/opt/infra/apps/tools/repo/infra/compose\n' }),
      );

      const result = await check.run(SERVER);

      expect(result.status).toBe('fail');
      expect(result.detail).toContain('web');
    });

    it('still fails for a sibling folder that merely shares the name prefix', async () => {
      const check = createDockerPortsCheck(
        docker({ ps: 'abc\n', inspect: '/kvox-2-nginx-1|kvox-2|3535 |/opt/infra/apps/kvox-2/repo/infra/compose\n' }),
      );

      const result = await check.run(SERVER);

      expect(result.status).toBe('fail');
      expect(result.detail).toContain('kvox-2-nginx-1');
    });

    it('still fails for a foreign container with no working directory label', async () => {
      const check = createDockerPortsCheck(docker({ ps: 'abc\n', inspect: '/handmade||3535 |\n' }));

      expect((await check.run(SERVER)).status).toBe('fail');
    });

    it('reports only the foreign container when the own one carries the same port', async () => {
      const check = createDockerPortsCheck(
        docker({
          ps: 'abc\ndef\n',
          inspect:
            '/kvox-nginx-1|kvox|3535 |/opt/infra/apps/kvox/repo/infra/compose\n/web|tools|3535 |/srv/tools\n',
        }),
      );

      const result = await check.run(SERVER);

      expect(result.status).toBe('fail');
      expect(result.detail).toContain('web');
      expect(result.detail).not.toContain('kvox-nginx-1');
    });
  });

  it('passes when nothing claims the port', async () => {
    const check = createDockerPortsCheck(docker({ ps: 'abc\n', inspect: '/other|tools|8080 \n' }));

    expect((await check.run(CONTEXT)).status).toBe('pass');
  });

  it('passes on a host with no containers at all', async () => {
    expect((await createDockerPortsCheck(docker({ ps: '\n', inspect: '' })).run(CONTEXT)).status).toBe('pass');
  });

  it('skips, never fails, when Docker cannot be asked', async () => {
    const result = await createDockerPortsCheck(docker('down')).run(CONTEXT);

    expect(result.status).toBe('skip');
  });

  it('is a required check that waits for the Docker daemon check', () => {
    const check = createDockerPortsCheck();

    expect(check.severity).toBe('required');
    expect(check.requires).toEqual(['docker-daemon']);
  });
});
