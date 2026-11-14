import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VoiceprintAudioError } from './voiceprint-embedder.js';
import { createThreadedVoiceprintEmbedder } from './voiceprint-thread.js';

// A fake worker with the real protocol: it answers with a 512-wide unit vector
// whose first value is the first sample; a 7777-sample input is "too short",
// a 9999-sample input crashes the worker.
const FAKE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.on('message', (msg) => {
  const x = new Float32Array(msg.samples);
  if (x.length === 9999) process.exit(3);
  if (x.length === 7777) {
    parentPort.postMessage({ id: msg.id, error: { name: 'VoiceprintAudioError', code: 'too_short', message: 'short' } });
    return;
  }
  if (x.length === 8888) {
    parentPort.postMessage({ id: msg.id, error: { name: 'Error', message: 'boom ' + workerData.modelPath } });
    return;
  }
  const v = new Float32Array(512); v[0] = 1; v[1] = x[0];
  parentPort.postMessage({ id: msg.id, embedding: v.buffer }, [v.buffer]);
});
`;

describe('createThreadedVoiceprintEmbedder', () => {
  let dir = '';
  let workerPath = '';
  beforeAll(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'kvox-vpthread-'));
    workerPath = join(dir, 'fake-worker.js');
    await fsp.writeFile(workerPath, FAKE_WORKER);
  });
  afterAll(() => fsp.rm(dir, { recursive: true, force: true }));

  const make = () => createThreadedVoiceprintEmbedder({ modelPath: '/models/x', workerPath });
  const audio = (n: number, first = 0.5): Float32Array => {
    const a = new Float32Array(n);
    a[0] = first;
    return a;
  };

  it('embeds through the worker and transfers the buffer', async () => {
    const e = make();
    try {
      expect(e.dimensions).toBe(512);
      expect(e.model).toBe('campplus-en-voxceleb-16k');
      const input = audio(16000, 0.25);
      const v = await e.embed(input);
      expect(v).toHaveLength(512);
      expect(v[1]).toBeCloseTo(0.25);
      expect(input.length).toBe(0); // detached by the transfer
    } finally {
      await e.dispose();
    }
  });

  it('copies a view of a larger buffer instead of transferring the whole buffer', async () => {
    const e = make();
    try {
      const big = new Float32Array(20000);
      big[100] = 0.75;
      const view = big.subarray(100, 8100);
      const v = await e.embed(view);
      expect(v[1]).toBeCloseTo(0.75);
      expect(big.length).toBe(20000); // not detached
    } finally {
      await e.dispose();
    }
  });

  it('answers concurrent calls to the right callers', async () => {
    const e = make();
    try {
      const out = await Promise.all([e.embed(audio(8000, 0.1)), e.embed(audio(8000, 0.2)), e.embed(audio(8000, 0.3))]);
      expect(out.map((v) => Math.round((v[1] as number) * 10))).toEqual([1, 2, 3]);
    } finally {
      await e.dispose();
    }
  });

  it('rebuilds a typed audio error and a plain error', async () => {
    const e = make();
    try {
      const typed = await e.embed(audio(7777)).catch((x) => x);
      expect(typed).toBeInstanceOf(VoiceprintAudioError);
      expect(typed.code).toBe('too_short');
      await expect(e.embed(audio(8888))).rejects.toThrow('boom /models/x');
    } finally {
      await e.dispose();
    }
  });

  it('rejects pending calls when the worker crashes and starts a new one on the next call', async () => {
    const e = make();
    try {
      await expect(e.embed(audio(9999))).rejects.toThrow(/exited/);
      const v = await e.embed(audio(8000, 0.5));
      expect(v[1]).toBeCloseTo(0.5);
    } finally {
      await e.dispose();
    }
  });

  it('refuses calls after dispose and fails clearly when the worker script is missing', async () => {
    const e = make();
    await e.dispose();
    await expect(e.embed(audio(8000))).rejects.toThrow(/disposed/);
    const missing = createThreadedVoiceprintEmbedder({ modelPath: 'x', workerPath: join(dir, 'nope.js') });
    await expect(missing.embed(audio(8000))).rejects.toThrow(/not found/);
    await missing.dispose();
  });
});
