import { EMBEDDING_DIMENSIONS, KVOX_EMBEDDING, KVOX_LOCAL_EMBEDDING } from './embedding-catalog.js';

describe('the embedding catalog', () => {
  it('pins the stored contract: model, width, input ceiling and batch size', () => {
    expect(KVOX_EMBEDDING).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      storageDimensions: 1536,
      maxInputTokens: 8191,
      maxBatchSize: 128,
      keyless: false,
    });
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
    expect(KVOX_EMBEDDING.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  it('keeps the batch below the platform ceiling of 256 on purpose', () => {
    expect(KVOX_EMBEDDING.maxBatchSize).toBeLessThan(256);
  });

  it('describes the local model: 384 native, stored in the 1536 column, keyless, query prefix only', () => {
    expect(KVOX_LOCAL_EMBEDDING).toMatchObject({
      provider: 'local',
      model: 'bge-small-en-v1.5-int8',
      dimensions: 384,
      storageDimensions: EMBEDDING_DIMENSIONS,
      maxInputTokens: 512,
      maxBatchSize: 32,
      keyless: true,
      queryPrefix: 'Represent this sentence for searching relevant passages: ',
    });
    expect(KVOX_LOCAL_EMBEDDING.documentPrefix).toBeUndefined();
    expect(KVOX_LOCAL_EMBEDDING.minSimilarity).toBe(0.45);
  });
});
