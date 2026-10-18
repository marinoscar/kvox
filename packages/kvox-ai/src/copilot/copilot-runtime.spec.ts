import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AiError } from '@marinoscar/platform-ai-providers';

import { COPILOT_EGRESS_HOSTS } from './copilot-egress.js';
import { COPILOT_RUNTIME_VERSION, prepareCopilotRuntime } from './copilot-runtime.js';

// =============================================================================
// prepareCopilotRuntime (issue #630): directories, bundled first, opt-in download
// =============================================================================
// Real temporary directories, an injected `fetch`, no network and no SDK.
// =============================================================================

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const HOST = 'downloads.example.test';
const URL_OK = `https://${HOST}/copilot/1.0.98/copilot-runtime`;
const BODY = Buffer.from('#!/bin/sh\necho copilot-runtime\n'.repeat(200));

/** A response whose body arrives in `chunks` pieces. */
function reply(body: Buffer, init: { status?: number; headers?: Record<string, string>; chunks?: number } = {}): Response {
  const pieces = init.chunks ?? 3;
  const size = Math.ceil(body.length / pieces);
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= body.length) return controller.close();
      controller.enqueue(new Uint8Array(body.subarray(at, at + size)));
      at += size;
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { 'content-length': String(body.length), ...(init.headers ?? {}) },
  });
}

/** The error's machine-readable context (`getResponse().details`). */
function detailsOf(err: AiError | undefined): Record<string, unknown> | undefined {
  return err?.getResponse().details;
}

async function refusal(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (err) {
    expect(AiError.isAiError(err)).toBe(true);
    return err as AiError;
  }
  throw new Error('expected a refusal');
}

describe('prepareCopilotRuntime', () => {
  let root: string;
  let data: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kvox-copilot-runtime-'));
    data = join(root, 'copilot');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function bundled(content = 'bundled runtime'): Promise<string> {
    const path = join(root, 'bundle', 'copilot-runtime');
    await mkdir(join(root, 'bundle'), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  describe('directories', () => {
    it('creates the base directory and an EMPTY working directory, cleaning leftovers', async () => {
      const work = join(data, 'work');
      await mkdir(join(work, 'nested'), { recursive: true });
      await writeFile(join(work, 'AGENTS.md'), 'leftover');
      await writeFile(join(work, 'nested', 'CLAUDE.md'), 'leftover');

      const rt = await prepareCopilotRuntime({ dataDirectory: data, bundledRuntimePath: await bundled() });

      expect(rt.workingDirectory).toBe(work);
      expect(await readdir(rt.workingDirectory)).toEqual([]);
      expect((await stat(rt.baseDirectory)).isDirectory()).toBe(true);
      expect(rt.baseDirectory.startsWith(data)).toBe(true);
    });

    it('refuses a relative dataDirectory', async () => {
      const err = await refusal(prepareCopilotRuntime({ dataDirectory: 'copilot' }));
      expect(err.code).toBe('AI_INVALID_REQUEST');
    });

    it('with neither a bundled path nor a download, says no runtime is available', async () => {
      const err = await refusal(prepareCopilotRuntime({ dataDirectory: data }));
      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(detailsOf(err)).toMatchObject({ check: 'runtime_missing' });
    });
  });

  describe('bundled runtime', () => {
    it('is preferred over a download: no fetch is made', async () => {
      const fetch = jest.fn();
      const path = await bundled();
      const rt = await prepareCopilotRuntime({
        dataDirectory: data,
        bundledRuntimePath: path,
        bundledSha256: sha('bundled runtime'),
        download: { allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY) },
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(rt).toMatchObject({ runtimePath: path, source: 'bundled', verified: true, version: COPILOT_RUNTIME_VERSION });
    });

    it('reads a sibling .sha256 file and reports the host-given version', async () => {
      const path = await bundled();
      await writeFile(`${path}.sha256`, `${sha('bundled runtime')}  copilot-runtime\n`);
      const rt = await prepareCopilotRuntime({ dataDirectory: data, bundledRuntimePath: path, bundledVersion: '1.2.3' });
      expect(rt).toMatchObject({ verified: true, version: '1.2.3' });
    });

    it('is unverified, and says so, when there is no expected checksum', async () => {
      const rt = await prepareCopilotRuntime({ dataDirectory: data, bundledRuntimePath: await bundled() });
      expect(rt.verified).toBe(false);
    });

    it('refuses a bundled checksum mismatch, with no fallback to a download', async () => {
      const fetch = jest.fn();
      const err = await refusal(
        prepareCopilotRuntime({
          dataDirectory: data,
          bundledRuntimePath: await bundled(),
          bundledSha256: sha('something else'),
          download: { allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY) },
          fetch: fetch as unknown as typeof globalThis.fetch,
        }),
      );
      expect(detailsOf(err)).toMatchObject({ check: 'checksum_mismatch' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses a missing bundled file', async () => {
      const err = await refusal(prepareCopilotRuntime({ dataDirectory: data, bundledRuntimePath: join(root, 'nope') }));
      expect(detailsOf(err)).toMatchObject({ check: 'runtime_missing' });
    });
  });

  describe('download policy', () => {
    const run = (download: Record<string, unknown>, fetch = jest.fn()) =>
      prepareCopilotRuntime({
        dataDirectory: data,
        download: download as never,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }).then(
        () => ({ fetch, error: undefined as AiError | undefined }),
        (error: unknown) => ({ fetch, error: error as AiError }),
      );

    it('refuses a host that is not in allowedHosts, before any fetch', async () => {
      const { fetch, error } = await run({ allowedHosts: ['other.example.test'], url: URL_OK, sha256: sha(BODY) });
      expect(error?.code).toBe('AI_INVALID_REQUEST');
      expect(detailsOf(error)).toMatchObject({ check: 'download_host_refused' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['http', `http://${HOST}/x`],
      ['credentials', `https://user:pw@${HOST}/x`],
      ['a non-default port', `https://${HOST}:8443/x`],
      ['a look-alike subdomain', `https://evil.${HOST}/x`],
      ['a suffix trick', `https://${HOST}.evil.test/x`],
    ])('refuses %s', async (_name, url) => {
      const { fetch, error } = await run({ allowedHosts: [HOST], url, sha256: sha(BODY) });
      expect(detailsOf(error)).toMatchObject({ check: 'download_host_refused' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses an empty allowedHosts and a manifest URL on a foreign host, before any fetch', async () => {
      const a = await run({ allowedHosts: [], url: URL_OK, sha256: sha(BODY) });
      const b = await run({ allowedHosts: [HOST], manifestUrl: 'https://elsewhere.example.test/m.json' });
      expect(detailsOf(a.error)).toMatchObject({ check: 'download_host_refused' });
      expect(detailsOf(b.error)).toMatchObject({ check: 'download_host_refused' });
      expect(a.fetch).not.toHaveBeenCalled();
      expect(b.fetch).not.toHaveBeenCalled();
    });

    it('needs a pin or a manifest, and a well-formed checksum', async () => {
      expect((await run({ allowedHosts: [HOST] })).error?.code).toBe('AI_INVALID_REQUEST');
      expect((await run({ allowedHosts: [HOST], url: URL_OK, sha256: 'abc' })).error?.code).toBe('AI_INVALID_REQUEST');
      expect((await run({ allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY), version: '../x' })).error?.code).toBe(
        'AI_INVALID_REQUEST',
      );
    });

    it('refuses a redirect to another host before requesting it', async () => {
      const fetch = jest.fn().mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://evil.example.test/runtime' } }),
      );
      const { error } = await run({ allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY) }, fetch);
      expect(detailsOf(error)).toMatchObject({ check: 'download_host_refused' });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('follows a redirect inside the allowed hosts', async () => {
      const fetch = jest
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `https://${HOST}/real` } }))
        .mockResolvedValueOnce(reply(BODY));
      const { error } = await run({ allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY) }, fetch);
      expect(error).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    });
  });

  describe('download', () => {
    it('downloads, reports progress, verifies, installs atomically and marks it executable', async () => {
      const fetch = jest.fn().mockResolvedValue(reply(BODY, { chunks: 4 }));
      const progress: { received: number; total?: number }[] = [];

      const rt = await prepareCopilotRuntime({
        dataDirectory: data,
        download: {
          allowedHosts: [HOST.toUpperCase()],
          url: URL_OK,
          sha256: `sha256:${sha(BODY).toUpperCase()}`,
          onProgress: (p) => progress.push(p),
        },
        fetch: fetch as unknown as typeof globalThis.fetch,
      });

      expect(rt).toMatchObject({ source: 'downloaded', verified: true, version: COPILOT_RUNTIME_VERSION });
      expect(rt.runtimePath).toBe(join(data, 'runtime', COPILOT_RUNTIME_VERSION, 'copilot-runtime'));
      expect(await readFile(rt.runtimePath)).toEqual(BODY);
      if (process.platform !== 'win32') expect((await stat(rt.runtimePath)).mode & 0o111).not.toBe(0);

      expect(progress[0]).toEqual({ received: 0, total: BODY.length });
      expect(progress.at(-1)).toEqual({ received: BODY.length, total: BODY.length });
      expect(progress.length).toBeGreaterThan(2);
      expect(progress.map((p) => p.received)).toEqual([...progress.map((p) => p.received)].sort((a, b) => a - b));

      // No partial or staging leftovers beside the install.
      expect(await readdir(join(data, 'runtime'))).toEqual([COPILOT_RUNTIME_VERSION]);
    });

    it('reuses an earlier install of the same checksum without touching the network', async () => {
      const options = { dataDirectory: data, download: { allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY) } };
      await prepareCopilotRuntime({
        ...options,
        fetch: jest.fn().mockResolvedValue(reply(BODY)) as unknown as typeof globalThis.fetch,
      });
      const fetch = jest.fn();
      const again = await prepareCopilotRuntime({ ...options, fetch: fetch as unknown as typeof globalThis.fetch });
      expect(again.source).toBe('cached');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('re-downloads when the installed single file was altered', async () => {
      const options = { dataDirectory: data, download: { allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY) } };
      const first = await prepareCopilotRuntime({
        ...options,
        fetch: jest.fn().mockResolvedValue(reply(BODY)) as unknown as typeof globalThis.fetch,
      });
      await writeFile(first.runtimePath, 'tampered');
      const fetch = jest.fn().mockResolvedValue(reply(BODY));
      const again = await prepareCopilotRuntime({ ...options, fetch: fetch as unknown as typeof globalThis.fetch });
      expect(again.source).toBe('downloaded');
      expect(await readFile(again.runtimePath)).toEqual(BODY);
    });

    it('refuses a checksum mismatch and deletes the partial download', async () => {
      const fetch = jest.fn().mockResolvedValue(reply(Buffer.from('not the runtime')));
      const err = await refusal(
        prepareCopilotRuntime({
          dataDirectory: data,
          download: { allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY) },
          fetch: fetch as unknown as typeof globalThis.fetch,
        }),
      );
      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(detailsOf(err)).toMatchObject({ check: 'checksum_mismatch' });
      expect(await readdir(join(data, 'runtime'))).toEqual([]);
    });

    it('refuses a body larger than maxBytes', async () => {
      const fetch = jest.fn().mockResolvedValue(reply(BODY, { headers: { 'content-length': '' } }));
      const err = await refusal(
        prepareCopilotRuntime({
          dataDirectory: data,
          download: { allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY), maxBytes: 100 },
          fetch: fetch as unknown as typeof globalThis.fetch,
        }),
      );
      expect(detailsOf(err)).toMatchObject({ check: 'download_too_large' });
      expect(await readdir(join(data, 'runtime'))).toEqual([]);
    });

    it('reports an HTTP failure without the URL', async () => {
      const fetch = jest.fn().mockResolvedValue(new Response('no', { status: 404 }));
      const err = await refusal(
        prepareCopilotRuntime({
          dataDirectory: data,
          download: { allowedHosts: [HOST], url: `${URL_OK}?sig=secret-signature`, sha256: sha(BODY) },
          fetch: fetch as unknown as typeof globalThis.fetch,
        }),
      );
      expect(detailsOf(err)).toMatchObject({ check: 'download_failed' });
      expect(err.message).not.toContain('secret-signature');
    });

    it('redacts a token that appears in a network error', async () => {
      const fetch = jest.fn().mockRejectedValue(new Error('socket hang up for gho_abcdef123456 Bearer abc.def'));
      const err = await refusal(
        prepareCopilotRuntime({
          dataDirectory: data,
          download: { allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY) },
          fetch: fetch as unknown as typeof globalThis.fetch,
        }),
      );
      expect(err.message).not.toMatch(/gho_abcdef|abc\.def/);
      expect(err.message).toContain('[redacted]');
    });

    it('resolves a manifest from an allowed host, then downloads what it names', async () => {
      const manifest = JSON.stringify({ version: '1.0.99', url: `https://${HOST}/files/rt.bin`, sha256: sha(BODY) });
      const fetch = jest
        .fn()
        .mockResolvedValueOnce(new Response(manifest, { status: 200 }))
        .mockResolvedValueOnce(reply(BODY));
      const rt = await prepareCopilotRuntime({
        dataDirectory: data,
        download: { allowedHosts: [HOST], manifestUrl: `https://${HOST}/manifest.json` },
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      expect(rt.version).toBe('1.0.99');
      expect(rt.runtimePath).toBe(join(data, 'runtime', '1.0.99', 'rt.bin'));
    });

    it('refuses a manifest that names a file on another host, before downloading it', async () => {
      const manifest = JSON.stringify({ version: '1.0.99', url: 'https://evil.example.test/rt.bin', sha256: sha(BODY) });
      const fetch = jest.fn().mockResolvedValueOnce(new Response(manifest, { status: 200 }));
      const err = await refusal(
        prepareCopilotRuntime({
          dataDirectory: data,
          download: { allowedHosts: [HOST], manifestUrl: `https://${HOST}/manifest.json` },
          fetch: fetch as unknown as typeof globalThis.fetch,
        }),
      );
      expect(detailsOf(err)).toMatchObject({ check: 'download_host_refused' });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    describe('with an extractor', () => {
      it('verifies the archive first, then installs what the extractor returns', async () => {
        const extract = jest.fn(async (archive: string, dest: string) => {
          expect(await readFile(archive)).toEqual(BODY);
          await mkdir(join(dest, 'prebuilds', 'linux-x64'), { recursive: true });
          await writeFile(join(dest, 'prebuilds', 'linux-x64', 'copilot-runtime'), 'wrapper');
          await writeFile(join(dest, 'prebuilds', 'linux-x64', 'runtime.node'), 'node');
          return join('prebuilds', 'linux-x64', 'copilot-runtime');
        });
        const rt = await prepareCopilotRuntime({
          dataDirectory: data,
          download: { allowedHosts: [HOST], url: `https://${HOST}/rt.tgz`, sha256: sha(BODY), extract },
          fetch: jest.fn().mockResolvedValue(reply(BODY)) as unknown as typeof globalThis.fetch,
        });
        expect(await readFile(rt.runtimePath, 'utf8')).toBe('wrapper');
        expect(await readFile(join(rt.runtimePath, '..', 'runtime.node'), 'utf8')).toBe('node');
        expect(await readdir(join(data, 'runtime'))).toEqual([COPILOT_RUNTIME_VERSION]);
      });

      it('does not call the extractor when the checksum is wrong', async () => {
        const extract = jest.fn();
        await refusal(
          prepareCopilotRuntime({
            dataDirectory: data,
            download: { allowedHosts: [HOST], url: `https://${HOST}/rt.tgz`, sha256: sha('other'), extract },
            fetch: jest.fn().mockResolvedValue(reply(BODY)) as unknown as typeof globalThis.fetch,
          }),
        );
        expect(extract).not.toHaveBeenCalled();
      });

      it('refuses a runtime path that escapes the install directory', async () => {
        const err = await refusal(
          prepareCopilotRuntime({
            dataDirectory: data,
            download: {
              allowedHosts: [HOST],
              url: `https://${HOST}/rt.tgz`,
              sha256: sha(BODY),
              extract: async () => join('..', '..', 'evil'),
            },
            fetch: jest.fn().mockResolvedValue(reply(BODY)) as unknown as typeof globalThis.fetch,
          }),
        );
        expect(detailsOf(err)).toMatchObject({ check: 'runtime_missing' });
        expect(await readdir(join(data, 'runtime'))).toEqual([]);
      });
    });
  });
});

describe('COPILOT_EGRESS_HOSTS', () => {
  it('lists the three hosts the issue names, lowercase, with no scheme or wildcard', () => {
    expect([...COPILOT_EGRESS_HOSTS]).toEqual(['api.githubcopilot.com', 'github.com', 'api.github.com']);
    for (const host of COPILOT_EGRESS_HOSTS) expect(host).toMatch(/^[a-z0-9.-]+$/);
  });

  it('is frozen, so a host cannot widen it by accident', () => {
    expect(Object.isFrozen(COPILOT_EGRESS_HOSTS)).toBe(true);
  });
});
