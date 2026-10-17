import { z } from 'zod';

import { AiInputError, AiStructuredOutputError } from '../ai-errors';
import { EMBEDDING_DIMENSIONS } from '@marinoscar/kvox-ai';
import { FakeKvoxAi, fakeVector, notReadyReadiness } from './fake-kvox-ai';

// The test double other specs build on. It must behave like the real adapter wherever a
// caller can observe it, or a spec passes against the fake and fails in production.

const base = { userId: 'u1', orgId: 'o1', jobId: 'j1' };

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('FakeKvoxAi', () => {
  it('is ready by default, and a spec can refuse per feature or for all', async () => {
    const ai = new FakeKvoxAi();

    await expect(ai.readiness('u1', 'note_generate')).resolves.toMatchObject({ ok: true, hasKey: true });
    await expect(ai.readiness('u1', 'note_generate', 'gpt-x')).resolves.toMatchObject({
      model: 'gpt-x',
      source: 'requested',
    });

    ai.setReadinessFor('graph_extract', notReadyReadiness('graph_disabled'));
    await expect(ai.readiness('u1', 'graph_extract')).resolves.toMatchObject({ ok: false, reason: 'graph_disabled' });
    await expect(ai.readiness('u1', 'note_generate')).resolves.toMatchObject({ ok: true });

    ai.setNotReady('ai_key_missing');
    await expect(ai.readiness('u1', 'note_generate')).resolves.toMatchObject({
      ok: false,
      reason: 'ai_key_missing',
      hasKey: false,
    });
  });

  it('streams scripted deltas then a done event, and records the call', async () => {
    const ai = new FakeKvoxAi().queueStream(['Hello ', 'world']);

    const out = await collect(
      ai.streamText({ ...base, feature: 'note_generate', system: 's', user: 'u' }),
    );

    expect(out).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
      { type: 'done', finishReason: 'stop', model: 'gpt-4o', usage: { inputTokens: null, outputTokens: null } },
    ]);
    expect(ai.lastCall('streamText')).toMatchObject({
      method: 'streamText',
      userId: 'u1',
      orgId: 'o1',
      jobId: 'j1',
      feature: 'note_generate',
    });
  });

  it('can die mid-stream, or fail before the first delta', async () => {
    const ai = new FakeKvoxAi()
      .queueStream({ deltas: ['half'], failAfter: new Error('socket') })
      .queueStreamError(new AiInputError('bad'));
    const req = { ...base, feature: 'note_generate' as const, system: 's', user: 'u' };

    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of ai.streamText(req)) seen.push(event);
      })(),
    ).rejects.toThrow('socket');
    expect(seen).toEqual([{ type: 'delta', text: 'half' }]);

    await expect(collect(ai.streamText(req))).rejects.toBeInstanceOf(AiInputError);
  });

  it('answers structured calls from the queue, re-validated with the caller schema', async () => {
    const ai = new FakeKvoxAi()
      .queueStructured({ n: 1 }, { usage: { inputTokens: 5, outputTokens: 2 } })
      .queueStructured({ n: 'nope' });
    const schema = z.object({ n: z.number() });
    const req = { ...base, feature: 'graph_extract' as const, system: 's', user: 'u', schemaName: 'x', schema };

    await expect(ai.generateStructured(req)).resolves.toEqual({
      value: { n: 1 },
      model: 'gpt-4o',
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    await expect(ai.generateStructured(req)).rejects.toBeInstanceOf(AiStructuredOutputError);
  });

  it('throws on a structured call with nothing queued, rather than inventing an answer', async () => {
    const ai = new FakeKvoxAi();

    await expect(
      ai.generateStructured({
        ...base,
        feature: 'graph_extract',
        system: 's',
        user: 'u',
        schemaName: 'kg_extraction',
        schema: z.unknown(),
      }),
    ).rejects.toThrow(/no structured reply queued for "kg_extraction"/);
  });

  it('embeds deterministically, 1536 wide, and enforces the real batch rules', async () => {
    const ai = new FakeKvoxAi();
    const req = (texts: string[]) => ({ ...base, feature: 'search_embed' as const, texts });

    const first = await ai.embed(req(['alpha', 'beta']));
    const again = await ai.embed(req(['alpha']));

    expect(first.vectors).toHaveLength(2);
    expect(first.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(again.vectors[0]).toEqual(first.vectors[0]);
    expect(first.vectors[0]).not.toEqual(first.vectors[1]);
    expect(first.model).toBe('text-embedding-3-small');
    expect(fakeVector('alpha')).toEqual(first.vectors[0]);

    await expect(ai.embed(req([]))).rejects.toBeInstanceOf(AiInputError);
    await expect(ai.embed(req(Array.from({ length: 129 }, () => 'x')))).rejects.toBeInstanceOf(AiInputError);
  });

  it('rejects scripted vectors of the wrong width, as the real adapter does', async () => {
    const ai = new FakeKvoxAi().queueEmbed([[1, 2, 3]]);

    await expect(ai.embed({ ...base, feature: 'search_embed', texts: ['a'] })).rejects.toThrow(/width/);
  });

  it('records every call and resets cleanly', async () => {
    const ai = new FakeKvoxAi().queueStream('x');
    await collect(ai.streamText({ userId: 'u', feature: 'note_retitle', system: 's', user: 'u' }));
    await ai.readiness('u', 'note_retitle');

    expect(ai.calls.map((call) => call.method)).toEqual(['streamText', 'readiness']);
    expect(ai.callsOf('readiness')).toHaveLength(1);
    expect(ai.pending().streamText).toBe(0);

    ai.reset();
    expect(ai.calls).toHaveLength(0);
  });
});
