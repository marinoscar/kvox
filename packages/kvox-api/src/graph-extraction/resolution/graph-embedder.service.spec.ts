import { SEARCH_EMBEDDING_DIMENSIONS } from '../../search/index.js';
import { KvoxAiError } from '../../ports/index.js';
import { createFakeKvoxAi, type FakeKvoxAi } from '../../testing/index.js';
import { resolveGraphExtractionOptions } from '../graph-extraction.options.js';
import { GraphEmbedder, vectorLiteral } from './graph-embedder.service.js';

const USER = '11111111-1111-4111-8111-111111111111';

function fakeAi(extra: Parameters<typeof createFakeKvoxAi>[0] = {}): FakeKvoxAi {
  return createFakeKvoxAi({
    script: { embeddingDimensions: SEARCH_EMBEDDING_DIMENSIONS, embeddingModel: 'text-embedding-3-small', ...extra.script },
  });
}

const embedder = (ai: FakeKvoxAi, batchSize = 128) =>
  new GraphEmbedder(ai, resolveGraphExtractionOptions({ embedding: { batchSize } }));

async function ready(ai: FakeKvoxAi) {
  const resolution = await embedder(ai).resolve(USER, 'job-7');
  if (!resolution.ok) throw new Error(`not ready: ${resolution.reason}`);
  return resolution;
}

describe('GraphEmbedder (#475)', () => {
  it('asks capabilities for the graph.embed feature and reports the host model and batch size', async () => {
    const ai = fakeAi();
    const resolution = await ready(ai);
    expect(ai.calls.find((c) => c.method === 'capabilities')?.ctx).toEqual(
      expect.objectContaining({ userId: USER, orgId: null, feature: 'graph.embed', jobId: 'job-7' }),
    );
    expect(resolution).toEqual(
      expect.objectContaining({ providerId: 'openai', model: 'text-embedding-3-small', maxBatchSize: 128 }),
    );
  });

  it.each([
    ['a missing key', { available: false, reason: 'ai_key_missing' }, 'ai_key_missing'],
    ['an unconfigured AI', { available: false, reason: 'ai_not_configured' }, 'ai_not_configured'],
    ['no embeddings model', { embeddings: null }, 'embeddings_unavailable'],
    ['vectors of another width', { embeddings: { model: 'big', dimensions: 3072 } }, 'embeddings_unavailable'],
  ] as const)('refuses on %s with %s', async (_label, capabilities, expected) => {
    const ai = fakeAi({ script: { capabilities: capabilities as never } });
    expect(await embedder(ai).resolve(USER)).toEqual({ ok: false, reason: expected });
  });

  it('embeds in order, chunked at the batch size, under the calling job', async () => {
    const ai = fakeAi();
    const resolution = await ready(ai);
    const texts = Array.from({ length: 130 }, (_, i) => `text ${i}`);

    const vectors = await resolution.embed(texts);

    expect(vectors).toHaveLength(130);
    expect(vectors[129]).toHaveLength(SEARCH_EMBEDDING_DIMENSIONS);
    const calls = ai.calls.filter((c) => c.method === 'embed');
    expect(calls.map((c) => (c.req as { inputs: string[] }).inputs.length)).toEqual([128, 2]);
    expect(calls.every((c) => c.ctx?.feature === 'graph.embed' && c.ctx?.jobId === 'job-7' && c.ctx?.userId === USER)).toBe(true);
  });

  it('chunks at the host\'s smaller batch size', async () => {
    const ai = fakeAi();
    const resolution = await embedder(ai, 50).resolve(USER);
    if (!resolution.ok) throw new Error('not ready');
    expect(resolution.maxBatchSize).toBe(50);
    await resolution.embed(Array.from({ length: 120 }, (_, i) => `t${i}`));
    expect(ai.calls.filter((c) => c.method === 'embed').map((c) => (c.req as { inputs: string[] }).inputs.length)).toEqual([50, 50, 20]);
  });

  it('throws on a vector of the wrong width instead of storing it', async () => {
    const ai = fakeAi();
    jest.spyOn(ai, 'embed').mockResolvedValue({ vectors: [[0.1, 0.2]], dimensions: 2, model: 'm' });
    const resolution = await ready(ai);
    await expect(resolution.embed(['a'])).rejects.toThrow(`exactly ${SEARCH_EMBEDDING_DIMENSIONS} components`);
  });

  it('throws when the count of vectors differs from the batch', async () => {
    const ai = fakeAi();
    jest.spyOn(ai, 'embed').mockResolvedValue({ vectors: [], dimensions: SEARCH_EMBEDDING_DIMENSIONS, model: 'm' });
    const resolution = await ready(ai);
    await expect(resolution.embed(['a'])).rejects.toThrow('returned 0 vector(s) for a 1-input batch');
  });

  it('lets a mapped provider error through (the job decides)', async () => {
    const ai = fakeAi();
    const resolution = await ready(ai);
    ai.script.failWith = new KvoxAiError('auth', 'refused');
    await expect(resolution.embed(['a'])).rejects.toBeInstanceOf(KvoxAiError);
  });

  it('formats a pgvector literal', () => {
    expect(vectorLiteral([1, 2.5])).toBe('[1,2.5]');
  });
});
