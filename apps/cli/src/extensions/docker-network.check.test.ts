import { describe, expect, it } from 'vitest';

import { DEVNET_CHECK_ID, createDockerNetworkCheck, type DockerProbe } from './docker-network.check.js';

const CONTEXT = {
  deployRoot: '/opt/infra/apps/myapp',
  bindPort: 3535,
  proxyRoot: '/opt/infra/proxy',
  domain: undefined,
  env: undefined,
  skipProxy: false,
} as const;

describe('the docker-network-devnet check', () => {
  it('passes when the network exists, asking docker about devnet by name', async () => {
    const asked: string[][] = [];
    const probe: DockerProbe = async (args) => {
      asked.push([...args]);
      return { ok: true };
    };

    const result = await createDockerNetworkCheck(probe).run(CONTEXT);

    expect(result).toEqual({ status: 'pass', detail: 'exists' });
    expect(asked).toEqual([['network', 'inspect', 'devnet']]);
  });

  it('warns, never fails, when it is absent, and says install creates it', async () => {
    const result = await createDockerNetworkCheck(async () => ({ ok: false })).run(CONTEXT);

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('install creates it');
    expect(result.remedy).toContain('docker network create devnet');
  });

  it('is a recommended check under the id the deploy end-to-end workflow asserts, after the daemon check', () => {
    const check = createDockerNetworkCheck();

    expect(check.id).toBe(DEVNET_CHECK_ID);
    expect(check.id).toBe('docker-network-devnet');
    expect(check.severity).toBe('recommended');
    expect(check.requires).toEqual(['docker-daemon']);
  });
});
