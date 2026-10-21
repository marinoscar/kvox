import { KvoxAiError } from '@marinoscar/kvox-api/ports';

import { KVOX_LOCAL_EMBEDDING } from '../embedding/index.js';
import { createLocalEmbeddingRuntime } from './local-embedding-runtime.js';

const call = { userId: 'u', feature: 'search' as never, provider: 'local', model: KVOX_LOCAL_EMBEDDING.model };

describe('createLocalEmbeddingRuntime', () => {
  it('passes texts and purpose through and reports no token count', async () => {
    const seen: unknown[] = [];
    const rt = createLocalEmbeddingRuntime({
      embed: async (texts, purpose) => (seen.push([texts, purpose]), texts.map(() => [1, 0])),
      ready: () => true,
    });
    const out = await rt.embed!(call, { input: ['a', 'b'], purpose: 'query' });
    expect(out).toEqual({ vectors: [[1, 0], [1, 0]], inputTokens: null, model: 'bge-small-en-v1.5-int8' });
    await rt.embed!(call, { input: ['c'] });
    expect(seen).toEqual([[['a', 'b'], 'query'], [['c'], 'document']]);
  });

  it('answers readiness from ready(), sync or async', async () => {
    const a = createLocalEmbeddingRuntime({ embed: async () => [], ready: () => false });
    const b = createLocalEmbeddingRuntime({ embed: async () => [], ready: async () => true });
    expect(await a.readiness(call)).toEqual({ hasKey: false });
    expect(await b.readiness(call)).toEqual({ hasKey: true });
  });

  it('refuses everything that is not embedding with a capability error', async () => {
    const rt = createLocalEmbeddingRuntime({ embed: async () => [], ready: () => true });
    expect(() => rt.stream(call, {} as never)).toThrow(KvoxAiError);
    await expect(rt.create(call, {} as never)).rejects.toMatchObject({ errorClass: 'capability' });
    try {
      rt.stream(call, {} as never);
    } catch (e) {
      expect((e as KvoxAiError).errorClass).toBe('capability');
    }
  });
});
