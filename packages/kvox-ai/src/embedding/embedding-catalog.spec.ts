import { EMBEDDING_DIMENSIONS, EmbeddingShapeError, KVOX_EMBEDDING } from './embedding-catalog.js';

describe('the embedding catalog', () => {
  it('pins the stored contract: model, width, input ceiling and batch size', () => {
    expect(KVOX_EMBEDDING).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxInputTokens: 8191,
      maxBatchSize: 128,
    });
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
    expect(KVOX_EMBEDDING.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  it('keeps the batch below the platform ceiling of 256 on purpose', () => {
    expect(KVOX_EMBEDDING.maxBatchSize).toBeLessThan(256);
  });

  it('EmbeddingShapeError is a plain, retryable Error carrying its kind', () => {
    const error = new EmbeddingShapeError('dimension', 'got 768');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(EmbeddingShapeError);
    expect(error.kind).toBe('dimension');
    expect(error.name).toBe('EmbeddingShapeError');
  });
});
