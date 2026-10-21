import type { KvoxAiContext } from '@marinoscar/kvox-api/ports';

import { EMBEDDING_DIMENSIONS, KVOX_EMBEDDING, KVOX_LOCAL_EMBEDDING, type KvoxEmbeddingModel } from '../embedding/index.js';
import type { KvoxAiModelState } from '../runtime/index.js';
import { createKvoxAi } from './create-kvox-ai.js';
import { createKvoxAiReadiness } from './readiness.js';

// The embedding catalog is a host choice: the default entry is the web edition's
// (unchanged requests), the local entry is narrower, keyless and prefixed.

const ctx: KvoxAiContext = { userId: 'u', orgId: 'o', jobId: 'j', feature: 'search.embed' };

function noChat(): KvoxAiModelState {
  return {
    provider: null,
    models: [],
    policy: {
      enabled: false,
      provider: null,
      defaultModel: null,
      graphEnabled: false,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

function build(embedding?: KvoxEmbeddingModel, hasKey = true) {
  const runtime = {
    stream: jest.fn(),
    create: jest.fn(),
    embed: jest.fn(),
    readiness: jest.fn().mockResolvedValue({ hasKey }),
  };
  const port = createKvoxAi({
    runtime,
    taskModels: { load: async () => noChat() },
    ...(embedding !== undefined ? { embedding } : {}),
  });
  return { port, runtime };
}

const vec = (n: number, fill: number) => Array.from({ length: n }, (_, i) => fill + i * 0.001);
const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((s, x, i) => s + x * b[i]!, 0);
  return dot / (Math.hypot(...a) * Math.hypot(...b));
};

describe('createKvoxAi embedding entry', () => {
  describe('default entry (the web edition)', () => {
    it('sends the unchanged runtime request and returns the provider-reported model', async () => {
      const { port, runtime } = build();
      const v = vec(EMBEDDING_DIMENSIONS, 0.1);
      runtime.embed.mockResolvedValue({ model: 'text-embedding-3-small-0001', vectors: [v], inputTokens: 1 });

      const out = await port.embed(ctx, { inputs: ['a'] });

      expect(runtime.embed.mock.calls[0]![1]).toEqual({ input: ['a'], dimensions: 1536 });
      expect(runtime.embed.mock.calls[0]![0]).toMatchObject({ provider: 'openai', model: 'text-embedding-3-small' });
      expect(out).toEqual({ model: 'text-embedding-3-small-0001', dimensions: 1536, vectors: [v] });
    });

    it('applies no prefix for a query and forwards the purpose', async () => {
      const { port, runtime } = build();
      runtime.embed.mockResolvedValue({ vectors: [vec(1536, 0.1)], inputTokens: null });

      await port.embed(ctx, { inputs: ['a'], purpose: 'query' });

      expect(runtime.embed.mock.calls[0]![1]).toEqual({ input: ['a'], dimensions: 1536, purpose: 'query' });
    });

    it('reports storage width, native width and no floor', async () => {
      const { port } = build();
      const caps = await port.capabilities(ctx);
      expect(caps.embeddings).toEqual({ model: KVOX_EMBEDDING.model, dimensions: 1536, nativeDimensions: 1536 });
    });
  });

  describe('local entry', () => {
    it('omits dimensions, prefixes queries only, pads to 1536 and returns the catalog id', async () => {
      const { port, runtime } = build(KVOX_LOCAL_EMBEDDING);
      const native = vec(384, 0.2);
      runtime.embed.mockResolvedValue({ model: 'something-else', vectors: [native], inputTokens: null });

      const query = await port.embed(ctx, { inputs: ['hello'], purpose: 'query' });
      expect(runtime.embed.mock.calls[0]![1]).toEqual({
        input: [`${KVOX_LOCAL_EMBEDDING.queryPrefix}hello`],
        purpose: 'query',
      });
      expect(runtime.embed.mock.calls[0]![0]).toMatchObject({ provider: 'local', model: 'bge-small-en-v1.5-int8' });
      expect(query.model).toBe('bge-small-en-v1.5-int8');
      expect(query.dimensions).toBe(1536);
      expect(query.vectors[0]).toHaveLength(1536);
      expect(query.vectors[0]!.slice(0, 384)).toEqual(native);
      expect(query.vectors[0]!.slice(384).every((c) => c === 0)).toBe(true);

      await port.embed(ctx, { inputs: ['hello'] });
      expect(runtime.embed.mock.calls[1]![1]).toEqual({ input: ['hello'] });
    });

    it('keeps cosine similarity exact under padding', async () => {
      const { port, runtime } = build(KVOX_LOCAL_EMBEDDING);
      const a = vec(384, 0.3);
      const b = vec(384, -0.1);
      runtime.embed.mockResolvedValue({ vectors: [a, b], inputTokens: null });

      const out = await port.embed(ctx, { inputs: ['a', 'b'] });

      expect(cosine(out.vectors[0]!, out.vectors[1]!)).toBeCloseTo(cosine(a, b), 12);
    });

    it('rejects a vector that is not exactly the native width', async () => {
      const { port, runtime } = build(KVOX_LOCAL_EMBEDDING);
      runtime.embed.mockResolvedValue({ vectors: [vec(1536, 0.1)], inputTokens: null });

      await expect(port.embed(ctx, { inputs: ['a'] })).rejects.toMatchObject({ errorClass: 'other' });
    });

    it('uses its own batch ceiling', async () => {
      const { port, runtime } = build(KVOX_LOCAL_EMBEDDING);
      await expect(port.embed(ctx, { inputs: Array.from({ length: 33 }, () => 'x') })).rejects.toMatchObject({
        errorClass: 'other',
      });
      expect(runtime.embed).not.toHaveBeenCalled();
    });

    it('reports nativeDimensions and minSimilarity', async () => {
      const entry = { ...KVOX_LOCAL_EMBEDDING, minSimilarity: 0.4 };
      const { port } = build(entry);
      const caps = await port.capabilities(ctx);
      expect(caps.embeddings).toEqual({
        model: 'bge-small-en-v1.5-int8',
        dimensions: 1536,
        nativeDimensions: 384,
        minSimilarity: 0.4,
      });
    });

    it('is ready with no chat provider and no key when the runtime says the model is present', async () => {
      const { port, runtime } = build(KVOX_LOCAL_EMBEDDING, true);
      const target = await port.resolveTask(ctx, 'search_embed');
      expect(target).toMatchObject({ provider: 'local', model: 'bge-small-en-v1.5-int8', contextWindowTokens: 512 });
      expect(runtime.readiness).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local' }));
    });

    it('is ai_not_configured when the runtime says the model is absent', async () => {
      const { port } = build(KVOX_LOCAL_EMBEDDING, false);
      await expect(port.resolveTask(ctx, 'search_embed')).rejects.toBeDefined();
    });
  });

  describe('keyless readiness', () => {
    const reader = (hasKey: boolean, embedding?: KvoxEmbeddingModel) => {
      const runtime = { stream: jest.fn(), create: jest.fn(), readiness: jest.fn().mockResolvedValue({ hasKey }) };
      return createKvoxAiReadiness({ runtime, taskModels: { load: async () => noChat() }, ...(embedding ? { embedding } : {}) });
    };

    it('is ok with no chat provider when the runtime reports the model present', async () => {
      await expect(reader(true, KVOX_LOCAL_EMBEDDING).readiness('u', 'search_embed')).resolves.toMatchObject({
        ok: true,
        reason: null,
        provider: 'local',
        model: 'bge-small-en-v1.5-int8',
      });
    });

    it('is ai_not_configured when the runtime reports it absent', async () => {
      await expect(reader(false, KVOX_LOCAL_EMBEDDING).readiness('u', 'graph_embed')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_not_configured',
      });
    });

    it('leaves the keyed entry unchanged: no chat provider is ai_not_configured', async () => {
      await expect(reader(true).readiness('u', 'search_embed')).resolves.toMatchObject({
        ok: false,
        reason: 'ai_not_configured',
      });
    });
  });
});
