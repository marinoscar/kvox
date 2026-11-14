import { parentPort, workerData } from 'node:worker_threads';

import { createVoiceprintEmbedder, VoiceprintAudioError, type VoiceprintEmbedder } from './voiceprint-embedder.js';

// =============================================================================
// The worker-thread entry of the threaded voiceprint embedder (issue #823)
// =============================================================================
//
// Loaded by `voiceprint-thread.ts` as `voiceprint-worker.js` next to it (the
// compiled CommonJS output). Not exported by the entry point. Protocol:
//
//   in : { id, samples: ArrayBuffer }            (the main thread transfers the buffer)
//   out: { id, embedding: ArrayBuffer }          (transferred back)
//     or { id, error: { name, code?, message } }
// =============================================================================

if (!parentPort) throw new Error('voiceprint-worker must run in a worker thread.');
const port = parentPort;
const options = workerData as { modelPath: string; numThreads?: number };
let embedder: Promise<VoiceprintEmbedder> | undefined;

port.on('message', (msg: { id: number; samples: ArrayBuffer }) => {
  void (async () => {
    try {
      embedder ??= createVoiceprintEmbedder(options);
      const e = await (embedder.catch((err) => {
        embedder = undefined; // retry loading on the next request
        throw err;
      }));
      const v = await e.embed(new Float32Array(msg.samples));
      const out = v.buffer as ArrayBuffer;
      port.postMessage({ id: msg.id, embedding: out }, [out]);
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      port.postMessage({
        id: msg.id,
        error: {
          name: err instanceof VoiceprintAudioError ? 'VoiceprintAudioError' : (e.name ?? 'Error'),
          ...(e.code ? { code: e.code } : {}),
          message: e.message ?? String(err),
        },
      });
    }
  })();
});
