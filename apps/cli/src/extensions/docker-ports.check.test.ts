import { describe, expect, it } from 'vitest';

import {
  COMPOSE_PROJECT_LABEL,
  createDockerPortsCheck,
  dockerPortClaims,
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
