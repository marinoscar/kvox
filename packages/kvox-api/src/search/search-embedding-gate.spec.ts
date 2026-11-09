import type { KvoxAiCapabilities } from '../ports/index.js';
import { embeddingGateFor } from './search-embedding-gate.js';

const caps = (embeddings: KvoxAiCapabilities['embeddings']): KvoxAiCapabilities => ({
  available: true,
  structuredOutput: true,
  toolCalling: true,
  embeddings,
  graphEnabled: true,
});

describe('embeddingGateFor', () => {
  it('carries nativeDimensions and minSimilarity of a padded model', () => {
    expect(
      embeddingGateFor(caps({ model: 'bge', dimensions: 1536, nativeDimensions: 384, minSimilarity: 0.5 })),
    ).toEqual({ ok: true, model: 'bge', dimensions: 1536, nativeDimensions: 384, minSimilarity: 0.5 });
  });

  it('carries the provider and the graph calibration of a catalog entry (#681)', () => {
    const graphCalibration = { vectorFloor: 0.83, itemCosine: 0.87, itemSameConfidentCosine: 0.95 };
    expect(
      embeddingGateFor(caps({ provider: 'local', model: 'bge', dimensions: 1536, graphCalibration })),
    ).toEqual({ ok: true, provider: 'local', model: 'bge', dimensions: 1536, graphCalibration });
  });

  it('omits both when the model declares neither', () => {
    expect(embeddingGateFor(caps({ model: 'm', dimensions: 1536 }))).toEqual({
      ok: true,
      model: 'm',
      dimensions: 1536,
    });
  });

  it('still refuses a storage width other than 1536 (search never pads or truncates)', () => {
    expect(embeddingGateFor(caps({ model: 'm', dimensions: 384 }))).toEqual({
      ok: false,
      reason: 'embeddings_unavailable',
      mismatch: { model: 'm', dimensions: 384 },
    });
  });
});
