import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadVerifiedFile, type VerifiedDownloadErrors } from './verified-download.js';

class E extends Error {
  constructor(public kind: string, message: string) {
    super(message);
  }
}
const errors: VerifiedDownloadErrors = {
  invalid: (t, c) => new E(`invalid:${c}`, t),
  refusedHost: (t) => new E('refused', t),
  failed: (t) => new E('failed', t),
  mismatch: () => new E('mismatch', ''),
  tooLarge: () => new E('too_large', ''),
  isOwn: (e) => e instanceof E,
};
const body = Buffer.from('hello world');
const sha = createHash('sha256').update(body).digest('hex');

describe('downloadVerifiedFile', () => {
  let dir = '';
  beforeEach(async () => void (dir = await fsp.mkdtemp(join(tmpdir(), 'kvox-dl-'))));
  afterEach(() => fsp.rm(dir, { recursive: true, force: true }));
  const base = (fetchImpl: typeof fetch) => ({
    url: 'https://a.test/f',
    sha256: sha,
    maxBytes: 1000,
    allowedHosts: new Set(['a.test']),
    destination: join(dir, 'out.part'),
    fetch: fetchImpl,
    errors,
  });

  it('writes the verified file and returns its size', async () => {
    const n = await downloadVerifiedFile(base(async () => new Response(body)));
    expect(n).toBe(body.length);
    expect(await fsp.readFile(join(dir, 'out.part'))).toEqual(body);
  });

  it('deletes the file on a mismatch', async () => {
    await expect(downloadVerifiedFile({ ...base(async () => new Response('other')) })).rejects.toMatchObject({ kind: 'mismatch' });
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('checks every redirect hop and caps the hop count', async () => {
    let hop = 0;
    const loop = async () => new Response(null, { status: 302, headers: { location: `https://a.test/${(hop += 1)}` } });
    await expect(downloadVerifiedFile(base(loop))).rejects.toMatchObject({ kind: 'failed', message: 'Too many redirects.' });
    const evil = async () => new Response(null, { status: 302, headers: { location: 'http://a.test/x' } });
    await expect(downloadVerifiedFile(base(evil))).rejects.toMatchObject({ kind: 'refused' });
  });

  it('refuses credentials and ports in the URL', async () => {
    const f = async () => new Response(body);
    await expect(downloadVerifiedFile({ ...base(f), url: 'https://u:p@a.test/f' })).rejects.toMatchObject({ kind: 'refused' });
    await expect(downloadVerifiedFile({ ...base(f), url: 'https://a.test:8443/f' })).rejects.toMatchObject({ kind: 'refused' });
  });
});
