import { KVOX_LOCAL_EMBEDDING } from '../embedding/index.js';
import { createLocalEmbedder } from './local-embedder.js';

// Runs only with a real model: KVOX_LOCAL_EMBEDDING_MODEL_DIR points at a directory
// that holds model.onnx, tokenizer.json and tokenizer_config.json (the installed
// model directory from downloadLocalEmbeddingModel). Jest's VM cannot run the
// runtime's dynamic import, so also set NODE_OPTIONS=--experimental-vm-modules:
//   NODE_OPTIONS=--experimental-vm-modules KVOX_LOCAL_EMBEDDING_MODEL_DIR=<dir> npm test -- local-embedder.integration
// (plain Node needs no flag).
const dir = process.env.KVOX_LOCAL_EMBEDDING_MODEL_DIR;
const maybe = dir ? describe : describe.skip;

maybe('the real bge-small-en-v1.5 int8 model', () => {
  it('gives 384-wide unit vectors and ranks the database sentence above the venue sentence', async () => {
    const embedder = await createLocalEmbedder({ modelPath: dir as string });
    try {
      const [q, db, venue, empty] = await embedder.embed([
        `${KVOX_LOCAL_EMBEDDING.queryPrefix}database migration plan`,
        'We agreed to move the Postgres schema to the new cluster and rehearse the migration on Friday.',
        'The wedding venue has a garden terrace and seats about eighty guests.',
        '',
      ]);
      for (const v of [q!, db!, venue!, empty!]) {
        expect(v).toHaveLength(384);
        expect(Math.hypot(...v)).toBeCloseTo(1, 4);
      }
      const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * (b[i] as number), 0);
      expect(dot(q!, db!)).toBeGreaterThan(dot(q!, venue!));
      const long = await embedder.embed(['word '.repeat(2000)]);
      expect(long[0]).toHaveLength(384);
    } finally {
      await embedder.dispose();
    }
  }, 120000);
});
