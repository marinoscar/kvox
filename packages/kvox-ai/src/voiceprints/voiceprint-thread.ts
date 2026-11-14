import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  type CreateVoiceprintEmbedderOptions,
  VoiceprintAudioError,
  type VoiceprintAudioErrorCode,
  type VoiceprintEmbedder,
} from './voiceprint-embedder.js';
import { VOICEPRINT_MANIFEST } from './voiceprint-files.js';

// =============================================================================
// The voiceprint embedder in a worker thread (issue #823)
// =============================================================================
//
// `session.run` blocks its thread (about 4 s of CPU per 60 s of audio), so the
// embedder runs in a `node:worker_threads` Worker and the caller's event loop
// stays free. The sample buffer is TRANSFERRED to the worker (the caller's
// Float32Array is detached by the call). The worker is created on the first
// call; if it crashes, every pending call rejects and the next call starts a
// new one. `dispose()` terminates it.
//
// The worker entry is `voiceprint-worker.js` next to this file (the compiled
// CommonJS `dist/`). Under a TypeScript runner there is no such `.js`; pass
// `workerPath`.
// =============================================================================

/**
 * What {@link createThreadedVoiceprintEmbedder} takes.
 *
 * @stability experimental
 */
export interface CreateThreadedVoiceprintEmbedderOptions extends CreateVoiceprintEmbedderOptions {
  /** The worker entry script. Default: `voiceprint-worker.js` beside this module (tests, a bundler). */
  workerPath?: string;
}

interface Pending {
  resolve(v: Float32Array): void;
  reject(e: Error): void;
}

type WorkerReply =
  | { id: number; embedding: ArrayBuffer }
  | { id: number; error: { name: string; code?: string; message: string } };

/**
 * Creates a {@link VoiceprintEmbedder} that runs the model in a worker thread.
 *
 * @remarks
 * Same interface as `createVoiceprintEmbedder`, but `embed` does not block the
 * calling thread. The model loads inside the worker on the first call. The
 * samples' buffer is transferred, so the passed array is empty afterwards.
 *
 * @param o - the installed model directory, optional thread count and worker path.
 * @returns the embedder (nothing is loaded until the first `embed`).
 *
 * @stability experimental
 */
export function createThreadedVoiceprintEmbedder(o: CreateThreadedVoiceprintEmbedderOptions): VoiceprintEmbedder {
  const workerPath = o.workerPath ?? join(__dirname, 'voiceprint-worker.js');
  let worker: Worker | undefined;
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, Pending>();

  const failAll = (err: Error): void => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const start = (): Worker => {
    if (!existsSync(workerPath)) {
      throw new Error(`The voiceprint worker script was not found at ${workerPath}; pass workerPath.`);
    }
    const w = new Worker(workerPath, { workerData: { modelPath: o.modelPath, numThreads: o.numThreads } });
    w.on('message', (msg: WorkerReply) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (pending.size === 0) w.unref();
      if ('error' in msg) {
        if (msg.error.name === 'VoiceprintAudioError') {
          p.reject(new VoiceprintAudioError(msg.error.code as VoiceprintAudioErrorCode, msg.error.message));
        } else {
          p.reject(new Error(msg.error.message));
        }
      } else {
        p.resolve(new Float32Array(msg.embedding));
      }
    });
    const gone = (err: Error): void => {
      if (worker === w) worker = undefined; // recreated on the next call
      failAll(err);
    };
    w.on('error', (err) => gone(err instanceof Error ? err : new Error(String(err))));
    w.on('exit', (code) => gone(new Error(`The voiceprint worker exited (code ${code}).`)));
    // An idle worker must not keep a host process alive; one with calls in flight must.
    w.unref();
    return w;
  };

  return {
    model: VOICEPRINT_MANIFEST.model,
    dimensions: 512,
    embed(samples) {
      if (disposed) return Promise.reject(new Error('The voiceprint embedder was disposed.'));
      return new Promise<Float32Array>((resolve, reject) => {
        let w: Worker;
        try {
          w = worker ??= start();
        } catch (err) {
          reject(err as Error);
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        w.ref();
        // Transfer a private buffer of exactly the samples (a view may share a larger one).
        const copy = samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength ? samples : samples.slice();
        const buffer = copy.buffer as ArrayBuffer;
        w.postMessage({ id, samples: buffer }, [buffer]);
      });
    },
    async dispose() {
      disposed = true;
      const w = worker;
      worker = undefined;
      failAll(new Error('The voiceprint embedder was disposed.'));
      if (w) {
        w.removeAllListeners();
        w.on('error', () => undefined);
        await w.terminate();
      }
    },
  };
}
