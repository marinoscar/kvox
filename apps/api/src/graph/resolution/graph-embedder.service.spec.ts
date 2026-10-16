import { AiAuthError } from '../../ai-port/ai-errors';
import { EMBEDDING_DIMENSIONS } from '../../ai-port/embedding-catalog';
import { FakeKvoxAi, fakeVector } from '../../ai-port/testing/fake-kvox-ai';
import { GraphEmbedder, vectorLiteral } from './graph-embedder.service';

const USER = '11111111-1111-4111-8111-111111111111';

async function ready(ai: FakeKvoxAi) {
  const resolution = await new GraphEmbedder(ai).resolve(USER, 'job-7');
  if (!resolution.ok) throw new Error(`not ready: ${resolution.reason}`);
  return resolution;
}

describe('GraphEmbedder (#475)', () => {
  it('asks readiness for the graph_embed feature and reports the catalog model and batch size', async () => {
    const ai = new FakeKvoxAi();
    const resolution = await ready(ai);
    expect(ai.lastCall('readiness')?.feature).toBe('graph_embed');
    expect(resolution).toEqual(
      expect.objectContaining({ providerId: 'openai', model: 'text-embedding-3-small', maxBatchSize: 128 }),
    );
  });

  it.each([
    ['ai_key_missing', 'ai_key_missing'],
    ['model_lacks_capability', 'embedding_unsupported'],
    ['ai_not_configured', 'ai_not_configured'],
    ['graph_disabled', 'ai_not_configured'],
  ] as const)('maps the readiness reason %s onto the search spelling %s', async (reason, expected) => {
    const ai = new FakeKvoxAi();
    ai.setNotReady(reason);
    expect(await new GraphEmbedder(ai).resolve(USER)).toEqual({ ok: false, reason: expected });
  });

  it('embeds in order, chunked at the catalog batch size, under the calling job', async () => {
    const ai = new FakeKvoxAi();
    const resolution = await ready(ai);
    const texts = Array.from({ length: 130 }, (_, i) => `text ${i}`);

    const vectors = await resolution.embed(texts);

    expect(vectors).toHaveLength(130);
    expect(vectors[129]).toEqual(fakeVector('text 129'));
    const calls = ai.callsOf('embed');
    expect(calls.map((c) => (c.request as { texts: string[] }).texts.length)).toEqual([128, 2]);
    expect(calls.every((c) => c.feature === 'graph_embed' && c.jobId === 'job-7' && c.userId === USER)).toBe(true);
  });

  it('throws on a vector of the wrong width instead of storing it', async () => {
    // The fake refuses a bad width itself; script the port's answer past that check.
    const ai = new FakeKvoxAi();
    jest.spyOn(ai, 'embed').mockResolvedValue({ vectors: [[0.1, 0.2]], promptTokens: null, model: 'm' });
    const resolution = await ready(ai);
    await expect(resolution.embed(['a'])).rejects.toThrow(`exactly ${EMBEDDING_DIMENSIONS} components`);
  });

  it('throws when the count of vectors differs from the batch', async () => {
    const ai = new FakeKvoxAi();
    jest.spyOn(ai, 'embed').mockResolvedValue({ vectors: [], promptTokens: null, model: 'm' });
    const resolution = await ready(ai);
    await expect(resolution.embed(['a'])).rejects.toThrow('returned 0 vector(s) for a 1-input batch');
  });

  it('lets a mapped provider error through (the job decides)', async () => {
    const ai = new FakeKvoxAi();
    ai.queueEmbedError(new AiAuthError('refused'));
    const resolution = await ready(ai);
    await expect(resolution.embed(['a'])).rejects.toBeInstanceOf(AiAuthError);
  });

  it('formats a pgvector literal', () => {
    expect(vectorLiteral([1, 2.5])).toBe('[1,2.5]');
  });
});
