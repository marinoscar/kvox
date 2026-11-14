import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VOICEPRINT_DIMENSIONS, VOICEPRINT_DOWNLOAD_HOSTS, VOICEPRINT_MANIFEST, VOICEPRINT_SAMPLE_RATE, type VoiceprintManifest } from './voiceprint-files.js';
import { downloadVoiceprintModel, removeVoiceprintModel, VoiceprintDownloadError, voiceprintModelStatus } from './voiceprint-model.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const BODY = Buffer.from('voiceprint-model-bytes-'.repeat(40));

function manifestFor(host: string, path = '/a'): VoiceprintManifest {
  return {
    model: VOICEPRINT_MANIFEST.model,
    license: 'Apache-2.0',
    files: [{ name: 'model.onnx', url: `https://${host}${path}`, size: BODY.length, sha256: sha(BODY) }],
  };
}

describe('the pinned manifest', () => {
  it('pins one https file with a size and a lowercase sha256, and the release hosts', () => {
    expect(VOICEPRINT_MANIFEST.model).toBe('campplus-en-voxceleb-16k');
    expect(VOICEPRINT_MANIFEST.license).toBe('Apache-2.0');
    expect(VOICEPRINT_MANIFEST.files).toHaveLength(1);
    const f = VOICEPRINT_MANIFEST.files[0]!;
    expect(f.name).toBe('model.onnx');
    expect(f.url).toBe(
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
    );
    expect(f.size).toBe(29596978);
    expect(f.sha256).toBe('357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b');
    expect(new URL(f.url).hostname).toBe('github.com');
    expect(VOICEPRINT_DOWNLOAD_HOSTS).toEqual(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
    expect(VOICEPRINT_DIMENSIONS).toBe(512);
    expect(VOICEPRINT_SAMPLE_RATE).toBe(16000);
  });
});

describe('downloadVoiceprintModel', () => {
  let server: Server;
  let port = 0;
  let hits: string[] = [];
  let corrupt = false;
  let dir = '';

  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    return fetch(`http://127.0.0.1:${port}${url.pathname}`, { ...init, headers: { 'x-host': url.hostname } });
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.headers['x-host']}${req.url}`);
      if (req.url === '/a') {
        res.writeHead(302, { location: 'https://release-assets.githubusercontent.com/blob' }).end();
      } else if (req.url === '/blob') {
        res.writeHead(200, { 'content-length': BODY.length }).end(corrupt ? Buffer.alloc(BODY.length, 1) : BODY);
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
    corrupt = false;
    dir = await fsp.mkdtemp(join(tmpdir(), 'kvox-voiceprint-'));
  });
  afterEach(() => fsp.rm(dir, { recursive: true, force: true }));

  const opts = (extra: object = {}) => ({ directory: dir, manifest: manifestFor('github.com'), fetch: localFetch, ...extra });

  it('follows an allowlisted redirect, verifies, installs and records, with progress', async () => {
    const progress: [number, number][] = [];
    const { path } = await downloadVoiceprintModel(opts({ onProgress: (r: number, t: number) => progress.push([r, t]) }));
    expect(path).toBe(join(dir, 'campplus-en-voxceleb-16k'));
    expect(await fsp.readFile(join(path, 'model.onnx'))).toEqual(BODY);
    const record = JSON.parse(await fsp.readFile(join(path, 'installed.json'), 'utf8'));
    expect(record.model).toBe('campplus-en-voxceleb-16k');
    expect(progress.at(-1)).toEqual([BODY.length, BODY.length]);
    expect((await fsp.readdir(dir)).filter((n) => n.startsWith('.stage-'))).toEqual([]);
  });

  it('is idempotent: a second run makes no request', async () => {
    await downloadVoiceprintModel(opts());
    hits = [];
    await downloadVoiceprintModel(opts());
    expect(hits).toEqual([]);
  });

  it('refuses a checksum mismatch and installs nothing', async () => {
    corrupt = true;
    const err = await downloadVoiceprintModel(opts()).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceprintDownloadError);
    expect(err.code).toBe('checksum_mismatch');
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('refuses a redirect to a host outside the allowlist before requesting it', async () => {
    const err = await downloadVoiceprintModel(opts({ manifest: manifestFor('github.com', '/evil') })).catch((e) => e);
    expect(err.code).toBe('host_refused');
    expect(err.host).toBe('evil.example');
    expect(hits.some((h) => h.startsWith('evil.example'))).toBe(false);
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('refuses a first URL that is not https or not allowlisted', async () => {
    for (const url of ['http://github.com/a', 'https://other.test/a']) {
      const m = manifestFor('github.com');
      const err = await downloadVoiceprintModel(opts({ manifest: { ...m, files: [{ ...m.files[0]!, url }] } })).catch((e) => e);
      expect(err.code).toBe('host_refused');
    }
    expect(hits).toEqual([]);
  });

  it('refuses a body larger than the pinned size', async () => {
    const m = manifestFor('github.com');
    const err = await downloadVoiceprintModel(opts({ manifest: { ...m, files: [{ ...m.files[0]!, size: 10 }] } })).catch((e) => e);
    expect(err.code).toBe('download_too_large');
  });

  it('stops on abort and cleans up', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await downloadVoiceprintModel(opts({ signal: ac.signal })).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceprintDownloadError);
    expect(err.code).toBe('download_failed');
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});

describe('status and removal', () => {
  it('reports not installed, then installed, then removed', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'kvox-voiceprint-'));
    try {
      expect(await voiceprintModelStatus(dir)).toEqual({ installed: false });
      const model = join(dir, VOICEPRINT_MANIFEST.model);
      await fsp.mkdir(model);
      const f = VOICEPRINT_MANIFEST.files[0]!;
      await fsp.writeFile(join(model, f.name), Buffer.alloc(f.size));
      await fsp.writeFile(
        join(model, 'installed.json'),
        JSON.stringify({ model: VOICEPRINT_MANIFEST.model, files: [{ name: f.name, size: f.size, sha256: f.sha256 }] }),
      );
      expect(await voiceprintModelStatus(dir)).toEqual({ installed: true, path: model });
      await fsp.writeFile(join(model, f.name), 'short');
      expect((await voiceprintModelStatus(dir)).installed).toBe(false);
      await fsp.mkdir(join(dir, '.stage-abc'));
      await removeVoiceprintModel(dir);
      expect(await fsp.readdir(dir)).toEqual([]);
      await removeVoiceprintModel(join(dir, 'missing'));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
