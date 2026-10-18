import { platformAdapter } from './adapters.js';

// =============================================================================
// platformAdapter (issue #578): the lean provider package's adapter factories
// =============================================================================
//
// No network and no key: the adapters are only constructed, never called.
// =============================================================================

describe('platformAdapter', () => {
  it('builds the OpenAI adapter from the lean factory', () => {
    const adapter = platformAdapter('openai');
    expect(adapter.id).toBe('openai');
    expect(adapter.responses).toBeDefined();
    expect(adapter.embeddings).toBeDefined();
  });

  it('builds the OpenAI-compatible adapter from the lean factory', () => {
    const adapter = platformAdapter('openai-compatible');
    expect(adapter.id).toBe('openai-compatible');
    expect(adapter.responses).toBeDefined();
  });

  it('builds a fresh adapter on every call', () => {
    expect(platformAdapter('openai')).not.toBe(platformAdapter('openai'));
  });
});
