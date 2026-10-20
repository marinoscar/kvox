import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AiError } from '@marinoscar/platform-ai-providers';

import { COPILOT_EGRESS_HOSTS } from './copilot-egress.js';
import {
  COPILOT_RUNTIME_VERSION,
  prepareCopilotRuntime,
  type CopilotRuntimeDownload,
  type CopilotRuntimeOptions,
} from './copilot-runtime.js';

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

  describe('installed (offline reuse of an earlier download)', () => {
    const EXTRACTED = 'wrapper';
    const archiveDownload = (extract: NonNullable<CopilotRuntimeDownload['extract']>): CopilotRuntimeDownload => ({
      allowedHosts: [HOST],
      url: `https://${HOST}/rt.tgz`,
      sha256: sha(BODY),
      extract,
    });
    const fileDownload = (): CopilotRuntimeDownload => ({ allowedHosts: [HOST], url: URL_OK, sha256: sha(BODY) });
    const extractor = async (_archive: string, dest: string): Promise<string> => {
      await mkdir(join(dest, 'prebuilds'), { recursive: true });
      await writeFile(join(dest, 'prebuilds', 'copilot-runtime'), EXTRACTED);
      return join('prebuilds', 'copilot-runtime');
    };
    const noFetch = (): { stub: jest.Mock; fetch: typeof globalThis.fetch } => {
      const stub = jest.fn();
      return { stub, fetch: stub as unknown as typeof globalThis.fetch };
    };
    const install = (download: CopilotRuntimeDownload) =>
      prepareCopilotRuntime({
        dataDirectory: data,
        download,
        fetch: jest.fn().mockResolvedValue(reply(BODY)) as unknown as typeof globalThis.fetch,
      });
    const dataDirExists = (): Promise<boolean> =>
      stat(data).then(
        () => true,
        () => false,
      );

    describe('a hit', () => {
      it('reuses a single-file install with no download, no fetch, and the same download object as `installed`', async () => {
        const download = fileDownload();
        const first = await install(download);
        const { stub, fetch } = noFetch();

        const again = await prepareCopilotRuntime({ dataDirectory: data, installed: download, fetch });

        expect(again).toMatchObject({
          source: 'cached',
          verified: true,
          runtimePath: first.runtimePath,
          version: COPILOT_RUNTIME_VERSION,
        });
        expect(stub).not.toHaveBeenCalled();
        expect(await readFile(again.runtimePath)).toEqual(BODY);
      });

      it('reuses an install given as only the pin (sha256, no URL or hosts)', async () => {
        const first = await install(fileDownload());
        const { stub, fetch } = noFetch();
        const again = await prepareCopilotRuntime({ dataDirectory: data, installed: { sha256: `sha256:${sha(BODY).toUpperCase()}` }, fetch });
        expect(again).toMatchObject({ source: 'cached', runtimePath: first.runtimePath });
        expect(stub).not.toHaveBeenCalled();
      });

      it('reuses an extracted (archive) install with no download, no fetch and no extractor call', async () => {
        const download = archiveDownload(extractor);
        const first = await install(download);
        const { stub, fetch } = noFetch();
        const extract = jest.fn();

        const again = await prepareCopilotRuntime({ dataDirectory: data, installed: { ...download, extract }, fetch });

        expect(again).toMatchObject({ source: 'cached', verified: true, runtimePath: first.runtimePath });
        expect(await readFile(again.runtimePath, 'utf8')).toBe(EXTRACTED);
        expect(stub).not.toHaveBeenCalled();
        expect(extract).not.toHaveBeenCalled();
      });

      it('reuses an install of a custom version', async () => {
        const first = await install({ ...fileDownload(), version: '9.9.9' });
        const again = await prepareCopilotRuntime({ dataDirectory: data, installed: { sha256: sha(BODY), version: '9.9.9' } });
        expect(again).toMatchObject({ source: 'cached', version: '9.9.9', runtimePath: first.runtimePath });
      });
    });

    describe('a miss is runtime_missing, with no fetch', () => {
      const miss = async (installed: CopilotRuntimeOptions['installed']): Promise<void> => {
        const { stub, fetch } = noFetch();
        const err = await refusal(prepareCopilotRuntime({ dataDirectory: data, installed, fetch }));
        expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
        expect(detailsOf(err)).toMatchObject({ check: 'runtime_missing' });
        expect(stub).not.toHaveBeenCalled();
      };

      it('when nothing is installed', async () => {
        await miss({ sha256: sha(BODY) });
      });

      it('when the installed record has a different SHA-256', async () => {
        await install(fileDownload());
        await miss({ sha256: sha('another runtime') });
      });

      it('when the installed version directory is another version', async () => {
        await install(fileDownload());
        await miss({ sha256: sha(BODY), version: '0.0.1' });
      });

      it('when the installed single file no longer hashes to the pin', async () => {
        const first = await install(fileDownload());
        await writeFile(first.runtimePath, 'tampered');
        await miss({ sha256: sha(BODY) });
      });

      it('when the installed runtime file was removed', async () => {
        const first = await install(fileDownload());
        await rm(first.runtimePath);
        await miss({ sha256: sha(BODY) });
      });

      it('when `installed` carries no sha256', async () => {
        await install(fileDownload());
        await miss({ version: COPILOT_RUNTIME_VERSION });
        await miss({});
      });
    });

    describe('option mistakes are AI_INVALID_REQUEST, thrown before any directory is created', () => {
      it.each([
        ['a version that escapes', { sha256: 'a'.repeat(64), version: '../x' }],
        ['a version with a separator', { sha256: 'a'.repeat(64), version: 'a/b' }],
        ['a version that escapes and no sha256', { version: '../x' }],
        ['a malformed sha256', { sha256: 'abc' }],
        ['a non-hex sha256', { sha256: 'z'.repeat(64) }],
      ])('refuses %s', async (_name, installed) => {
        const { stub, fetch } = noFetch();
        const err = await refusal(prepareCopilotRuntime({ dataDirectory: data, installed, fetch }));
        expect(err.code).toBe('AI_INVALID_REQUEST');
        expect(stub).not.toHaveBeenCalled();
        expect(await dataDirExists()).toBe(false);
      });
    });

    describe('precedence', () => {
      it('the bundled runtime wins over a matching install, with no fetch', async () => {
        const download = fileDownload();
        await install(download);
        const path = await bundled();
        const { stub, fetch } = noFetch();

        const rt = await prepareCopilotRuntime({
          dataDirectory: data,
          bundledRuntimePath: path,
          bundledSha256: sha('bundled runtime'),
          installed: download,
          fetch,
        });

        expect(rt).toMatchObject({ source: 'bundled', runtimePath: path, verified: true });
        expect(stub).not.toHaveBeenCalled();
      });

      it('a bundled checksum mismatch is still an error, not a fall back to `installed`', async () => {
        const download = fileDownload();
        await install(download);
        const err = await refusal(
          prepareCopilotRuntime({
            dataDirectory: data,
            bundledRuntimePath: await bundled(),
            bundledSha256: sha('something else'),
            installed: download,
          }),
        );
        expect(detailsOf(err)).toMatchObject({ check: 'checksum_mismatch' });
      });

      it('with `download` present, `installed` is ignored: the download path decides (its own cache applies)', async () => {
        const download = fileDownload();
        const first = await install(download);
        const { stub, fetch } = noFetch();

        const again = await prepareCopilotRuntime({
          dataDirectory: data,
          download,
          installed: { sha256: sha('a different pin'), version: '0.0.1' },
          fetch,
        });

        expect(again).toMatchObject({ source: 'cached', runtimePath: first.runtimePath, version: COPILOT_RUNTIME_VERSION });
        expect(stub).not.toHaveBeenCalled();
      });

      it('with `download` present and nothing installed, a matching `installed` does not stop the download', async () => {
        const fetch = jest.fn().mockResolvedValue(reply(BODY));
        const rt = await prepareCopilotRuntime({
          dataDirectory: data,
          download: fileDownload(),
          installed: { sha256: sha(BODY) },
          fetch: fetch as unknown as typeof globalThis.fetch,
        });
        expect(rt.source).toBe('downloaded');
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('COPILOT_EGRESS_HOSTS', () => {
  it('lists the original three hosts and the three per-plan Copilot API hosts (issue #646), in order', () => {
    expect([...COPILOT_EGRESS_HOSTS]).toEqual([
      'api.githubcopilot.com',
      'api.individual.githubcopilot.com',
      'api.business.githubcopilot.com',
      'api.enterprise.githubcopilot.com',
      'github.com',
      'api.github.com',
    ]);
  });

  it.each([
    'api.githubcopilot.com',
    'github.com',
    'api.github.com',
    'api.individual.githubcopilot.com',
    'api.business.githubcopilot.com',
    'api.enterprise.githubcopilot.com',
  ])('contains %s', (host) => {
    expect(COPILOT_EGRESS_HOSTS).toContain(host);
  });

  it('has no wildcard, no proxy host and no telemetry host', () => {
    for (const host of COPILOT_EGRESS_HOSTS) {
      expect(host).not.toContain('*');
      expect(host).not.toMatch(/^proxy\./);
      expect(host).not.toContain('proxy');
      expect(host).not.toContain('telemetry');
    }
  });

  it('is plain lowercase hostnames: no scheme, port, path, wildcard or duplicates', () => {
    for (const host of COPILOT_EGRESS_HOSTS) {
      expect(host).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
      expect(host).toBe(host.toLowerCase());
    }
    expect(new Set(COPILOT_EGRESS_HOSTS).size).toBe(COPILOT_EGRESS_HOSTS.length);
  });

  it('is frozen, so a host cannot widen it by accident', () => {
    expect(Object.isFrozen(COPILOT_EGRESS_HOSTS)).toBe(true);
    expect(() => (COPILOT_EGRESS_HOSTS as string[]).push('evil.example.test')).toThrow(TypeError);
  });
});
