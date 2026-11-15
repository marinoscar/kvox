import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTAINER_EGRESS_SCRIPT,
  VOICEPRINT_DOWNLOAD_HOSTS,
  VOICEPRINT_MODEL_URL,
  containerEgressArgv,
  createHostEgressProbe,
  type ProbeFetch,
  type ProbeResponse,
} from './voiceprint-egress.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function response(status: number, location: string | null = null): ProbeResponse {
  return { status, location, cancel: () => undefined };
}

/** A fetch that answers from a table keyed by URL and records what it was asked. */
function table(answers: Record<string, ProbeResponse>, asked: string[] = []): ProbeFetch {
  return async (url) => {
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) throw new Error('unexpected request');
    return answer;
  };
}

describe('the voice model constants', () => {
  it('equal the pinned manifest and download hosts of @marinoscar/kvox-ai (the CLI cannot depend on it)', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages', 'kvox-ai', 'src', 'voiceprints', 'voiceprint-files.ts'), 'utf8');

    expect(source).toContain(`url: '${VOICEPRINT_MODEL_URL}'`);
    const hostsBlock = /VOICEPRINT_DOWNLOAD_HOSTS[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    const hosts = [...hostsBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(hosts).toEqual([...VOICEPRINT_DOWNLOAD_HOSTS]);
  });
});

describe('the host egress probe', () => {
  const GITHUB = VOICEPRINT_MODEL_URL;
  const ASSET = 'https://release-assets.githubusercontent.com/blob?sig=secret-token';

  it('follows the redirect to an allowed host and passes on a 206, asking for one byte', async () => {
    const asked: string[] = [];
    const seen: Array<Record<string, string>> = [];
    const fetchImpl: ProbeFetch = async (url, init) => {
      seen.push(init.headers);
      return table({ [GITHUB]: response(302, ASSET), [ASSET]: response(206) }, asked)(url, init);
    };

    const result = await createHostEgressProbe(fetchImpl)(GITHUB, VOICEPRINT_DOWNLOAD_HOSTS, 1000);

    expect(result).toEqual({ ok: true });
    expect(asked).toEqual([GITHUB, ASSET]);
    expect(seen[0]).toEqual({ Range: 'bytes=0-0' });
  });

  it('refuses a redirect to a host that is not allowed, without contacting it or echoing the URL query', async () => {
    const asked: string[] = [];
    const evil = 'https://elsewhere.example.test/blob?sig=secret-token';
    const result = await createHostEgressProbe(table({ [GITHUB]: response(302, evil) }, asked))(GITHUB, VOICEPRINT_DOWNLOAD_HOSTS, 1000);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('elsewhere.example.test');
    expect(result.reason).not.toContain('secret-token');
    expect(asked).toEqual([GITHUB]);
  });

  it('refuses a redirect that leaves https', async () => {
    const result = await createHostEgressProbe(table({ [GITHUB]: response(302, 'http://github.com/x') }))(GITHUB, VOICEPRINT_DOWNLOAD_HOSTS, 1000);
    expect(result).toEqual({ ok: false, reason: 'a redirect left https' });
  });

  it('reports an HTTP error status, a redirect loop, a timeout and a network failure as fixed phrases', async () => {
    const probe = (fetchImpl: ProbeFetch) => createHostEgressProbe(fetchImpl)(GITHUB, VOICEPRINT_DOWNLOAD_HOSTS, 1000);

    expect(await probe(table({ [GITHUB]: response(403) }))).toEqual({ ok: false, reason: 'the server answered 403' });
    expect(await probe(table({ [GITHUB]: response(302, GITHUB) }))).toEqual({ ok: false, reason: 'too many redirects' });
    expect(
      await probe(async () => {
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      }),
    ).toEqual({ ok: false, reason: 'timed out' });
    expect(
      await probe(async () => {
        throw new Error('getaddrinfo ENOTFOUND github.com');
      }),
    ).toEqual({ ok: false, reason: 'the connection failed' });
  });
});

describe('the container egress script', () => {
  it('is valid JavaScript and its argv layout works under node -e (refuses a non-allowed host offline)', () => {
    const run = spawnSync(
      process.execPath,
      ['-e', CONTAINER_EGRESS_SCRIPT, 'https://elsewhere.example.test/x', '2000', 'github.com'],
      { encoding: 'utf8', timeout: 10_000 },
    );

    expect(run.status).toBe(0);
    const verdict = JSON.parse(run.stdout.trim()) as { ok: boolean; reason: string };
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('elsewhere.example.test');
  });

  it('is given the pinned URL, a timeout and every allowed host', () => {
    expect(containerEgressArgv(5000)).toEqual(['node', '-e', CONTAINER_EGRESS_SCRIPT, VOICEPRINT_MODEL_URL, '5000', ...VOICEPRINT_DOWNLOAD_HOSTS]);
  });
});
