import { KVOX_CLASSIFY_RATE_LIMIT, KvoxRateLimitError } from '../src/ports/index.js';

// =============================================================================
// KvoxRateLimitError classifies itself (issue #492, epic #491)
// =============================================================================
//
// A queue that sees the error directly (the web edition's transcript handlers
// register with the platform queue, not through the jobs port) asks the thrown
// value whether it is a rate limit through the well-known `jobs.classifyRateLimit`
// symbol. The key must stay a `Symbol.for` of that exact string.
// =============================================================================

describe('KvoxRateLimitError', () => {
  it('answers the queue\'s self-classification question with the provider\'s hint', () => {
    const error = new KvoxRateLimitError('transcription-provider', 30_000);
    const classify = (error as unknown as Record<symbol, () => unknown>)[Symbol.for('jobs.classifyRateLimit')];

    expect(KVOX_CLASSIFY_RATE_LIMIT).toBe(Symbol.for('jobs.classifyRateLimit'));
    expect(classify.call(error)).toEqual({ rateLimited: true, retryAfterMs: 30_000 });
  });

  it('reports no opinion, not zero, when the provider gave no hint', () => {
    expect(new KvoxRateLimitError('k')[KVOX_CLASSIFY_RATE_LIMIT]()).toEqual({ rateLimited: true, retryAfterMs: null });
  });

  it('keeps its default message and takes a custom one', () => {
    expect(new KvoxRateLimitError('bucket').message).toBe('Rate limited on bucket');
    expect(new KvoxRateLimitError('bucket', undefined, 'AssemblyAI said slow down').message).toBe('AssemblyAI said slow down');
  });
});
