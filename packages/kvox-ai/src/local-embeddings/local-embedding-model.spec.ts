import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_EMBEDDING_DOWNLOAD_HOSTS, LOCAL_EMBEDDING_MANIFEST, type LocalEmbeddingManifest } from './local-embedding-files.js';
import {
  downloadLocalEmbeddingModel,
  LocalEmbeddingDownloadError,
  localEmbeddingModelStatus,
  removeLocalEmbeddingModel,
} from './local-embedding-model.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const BODIES = { a: Buffer.from('model-bytes-'.repeat(50)), b: Buffer.from('{"tok":1}') };

function manifestFor(host: string): LocalEmbeddingManifest {
  return {
    model: LOCAL_EMBEDDING_MANIFEST.model,
    license: 'MIT',
    files: [
      { name: 'model.onnx', url: `https://${host}/a`, size: BODIES.a.length, sha256: sha(BODIES.a) },
      { name: 'tokenizer.json', url: `https://${host}/b`, size: BODIES.b.length, sha256: sha(BODIES.b) },
    ],
  };
}

describe('the pinned manifest', () => {
  it('names a commit-pinned https URL, a size and a lowercase sha256 for every file', () => {
    expect(LOCAL_EMBEDDING_MANIFEST.files.map((f) => f.name)).toEqual(['model.onnx', 'tokenizer.json', 'tokenizer_config.json']);
    for (const f of LOCAL_EMBEDDING_MANIFEST.files) {
      expect(f.url).toMatch(/^https:\/\/huggingface\.co\/Xenova\/bge-small-en-v1\.5\/resolve\/ea104dacec62c0de699686887e3f920caeb4f3e3\//);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.size).toBeGreaterThan(0);
    }
    expect(LOCAL_EMBEDDING_DOWNLOAD_HOSTS).toContain('huggingface.co');
  });
});

describe('downloadLocalEmbeddingModel', () => {
  let server: Server;
  let port = 0;
  let hits: string[] = [];
  let corruptB = false;
  let dir = '';

  // Routes https://ANY-HOST/PATH to the local http server; Location headers stay https.
  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    return fetch(`http://127.0.0.1:${port}${url.pathname}`, { ...init, headers: { 'x-host': url.hostname } });
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.headers['x-host']}${req.url}`);
      if (req.url === '/a') {
        res.writeHead(302, { location: 'https://cdn.test/blob-a' }).end();
      } else if (req.url === '/blob-a') {
        res.writeHead(200, { 'content-length': BODIES.a.length }).end(BODIES.a);
      } else if (req.url === '/b') {
        res.writeHead(200).end(corruptB ? Buffer.from('{"tok":2}') : BODIES.b);
      } else if (req.url === '/evil') {
        res.writeHead(302, { location: 'https://evil.example/steal' }).end();
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(async () => {
    hits = [];
    corruptB = false;
    dir = await fsp.mkdtemp(join(tmpdir(), 'kvox-localemb-'));
  });
  afterEach(() => fsp.rm(dir, { recursive: true, force: true }));

  const opts = (extra: object = {}) => ({
    directory: dir,
    manifest: manifestFor('huggingface.co'),
    allowedHosts: ['huggingface.co', 'cdn.test'],
    fetch: localFetch,
    ...extra,
  });

  it('downloads through an allowlisted redirect, verifies, installs and records, with progress', async () => {
    const progress: [number, number][] = [];
    const { path } = await downloadLocalEmbeddingModel(opts({ onProgress: (r: number, t: number) => progress.push([r, t]) }));
    expect(path).toBe(join(dir, 'bge-small-en-v1.5-int8'));
    expect(await fsp.readFile(join(path, 'model.onnx'))).toEqual(BODIES.a);
    const record = JSON.parse(await fsp.readFile(join(path, 'installed.json'), 'utf8'));
    expect(record.model).toBe('bge-small-en-v1.5-int8');
    expect(record.files).toHaveLength(2);
    expect(progress.at(-1)).toEqual([BODIES.a.length + BODIES.b.length, BODIES.a.length + BODIES.b.length]);
    expect((await fsp.readdir(dir)).filter((n) => n.startsWith('.stage-'))).toEqual([]);
  });

  it('is idempotent: a second run makes no request', async () => {
    await downloadLocalEmbeddingModel(opts());
    hits = [];
    await downloadLocalEmbeddingModel(opts());
    expect(hits).toEqual([]);
  });

  it('refuses a checksum mismatch and installs nothing', async () => {
    corruptB = true;
    const err = await downloadLocalEmbeddingModel(opts()).catch((e) => e);
    expect(err).toBeInstanceOf(LocalEmbeddingDownloadError);
    expect(err.code).toBe('checksum_mismatch');
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('refuses a redirect to a host outside the allowlist before requesting it', async () => {
    const m = manifestFor('huggingface.co');
    const manifest = { ...m, files: [{ ...m.files[0]!, url: 'https://huggingface.co/evil' }] };
    const err = await downloadLocalEmbeddingModel(opts({ manifest })).catch((e) => e);
    expect(err.code).toBe('host_refused');
    expect(err.host).toBe('evil.example');
    expect(hits.some((h) => h.startsWith('evil.example'))).toBe(false);
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('refuses a first URL that is not https or not allowlisted', async () => {
    const m = manifestFor('huggingface.co');
    for (const url of ['http://huggingface.co/a', 'https://other.test/a']) {
      const manifest = { ...m, files: [{ ...m.files[0]!, url }] };
      const err = await downloadLocalEmbeddingModel(opts({ manifest })).catch((e) => e);
      expect(err.code).toBe('host_refused');
    }
    expect(hits).toEqual([]);
  });

  it('refuses a body larger than the pinned size', async () => {
    const m = manifestFor('huggingface.co');
    const manifest = { ...m, files: [{ ...m.files[0]!, size: 10 }] };
    const err = await downloadLocalEmbeddingModel(opts({ manifest })).catch((e) => e);
    expect(err.code).toBe('download_too_large');
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('stops on abort and cleans up', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await downloadLocalEmbeddingModel(opts({ signal: ac.signal })).catch((e) => e);
    expect(err).toBeInstanceOf(LocalEmbeddingDownloadError);
    expect(err.code).toBe('download_failed');
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('aborts mid-stream', async () => {
    const ac = new AbortController();
    const err = await downloadLocalEmbeddingModel(opts({ signal: ac.signal, onProgress: (r: number) => r > 0 && ac.abort() })).catch((e) => e);
    expect(err.code).toBe('download_failed');
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});

describe('status and removal', () => {
  it('reports not installed, then installed, then removed', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'kvox-localemb-'));
    try {
      expect(await localEmbeddingModelStatus(dir)).toEqual({ installed: false });
      const model = join(dir, LOCAL_EMBEDDING_MANIFEST.model);
      await fsp.mkdir(model);
      for (const f of LOCAL_EMBEDDING_MANIFEST.files) await fsp.writeFile(join(model, f.name), Buffer.alloc(f.size));
      await fsp.writeFile(
        join(model, 'installed.json'),
        JSON.stringify({
          model: LOCAL_EMBEDDING_MANIFEST.model,
          files: LOCAL_EMBEDDING_MANIFEST.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
        }),
      );
      expect(await localEmbeddingModelStatus(dir)).toEqual({ installed: true, path: model });
      await fsp.writeFile(join(model, 'tokenizer_config.json'), 'short');
      expect((await localEmbeddingModelStatus(dir)).installed).toBe(false);
      await removeLocalEmbeddingModel(dir);
      expect(await fsp.readdir(dir)).toEqual([]);
      await removeLocalEmbeddingModel(join(dir, 'missing'));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
