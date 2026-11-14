import * as fs from 'node:fs';
import { join } from 'node:path';

import { createVoiceprintEmbedder } from './voiceprint-embedder.js';
import { VOICEPRINT_DIMENSIONS } from './voiceprint-files.js';

// Runs only with a real model: KVOX_VOICEPRINT_MODEL_DIR points at a directory
// that holds model.onnx (the installed model directory from downloadVoiceprintModel).
// Jest's VM cannot run the runtime's dynamic import, so also set
// NODE_OPTIONS=--experimental-vm-modules:
//   NODE_OPTIONS=--experimental-vm-modules KVOX_VOICEPRINT_MODEL_DIR=<dir> npm test -- voiceprint-embedder.integration
// The audio is synthetic (a tone with noise); no recording is committed.
const dir = process.env.KVOX_VOICEPRINT_MODEL_DIR;
const maybe = dir && fs.existsSync(join(dir, 'model.onnx')) ? describe : describe.skip;

maybe('the real CAM++ voiceprint model', () => {
  it('gives deterministic 512-wide unit vectors', async () => {
    const embedder = await createVoiceprintEmbedder({ modelPath: dir as string });
    try {
      let seed = 1;
      const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
      const x = Float32Array.from({ length: 16000 * 3 }, (_, i) => 0.25 * Math.sin(i / 11) * Math.sin(i / 4000) + 0.02 * rnd());
      const a = await embedder.embed(x);
      const b = await embedder.embed(x);
      expect(a).toHaveLength(VOICEPRINT_DIMENSIONS);
      expect(Math.hypot(...a)).toBeCloseTo(1, 4);
      expect(Array.from(b)).toEqual(Array.from(a));
      const other = await embedder.embed(Float32Array.from({ length: 16000 * 3 }, () => 0.1 * rnd()));
      expect(Array.from(other)).not.toEqual(Array.from(a));
    } finally {
      await embedder.dispose();
    }
  }, 120000);
});
