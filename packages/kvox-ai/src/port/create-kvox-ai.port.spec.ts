import type { KvoxAiContext } from '@marinoscar/kvox-api/ports';

import type { KvoxAiReadiness, KvoxAiReason } from '../types/index.js';
import { createKvoxAi } from './create-kvox-ai.js';
import { featureOf } from './feature-names.js';
import type { KvoxAiReadinessReader } from './readiness.js';

// =============================================================================
// createKvoxAi: the port's own rules (issue #579, from the web port adapter #490)
// =============================================================================
//
// What the web edition's `PlatformKvoxAiAdapter` pinned in
// `apps/api/test/platform-kvox/platform-kvox-adapters.spec.ts` ("AI adapter"),
// moved here with the code: the feature vocabulary, the refusal of an unknown
// feature, `resolveTask`'s reason mapping and numbers (`requireKey: false`
// included), and a `capabilities()` that reports the reason and never throws. The
// readiness reader is scripted, as the facade was.
// =============================================================================

const CTX: KvoxAiContext = { userId: 'user-1', orgId: null, feature: 'notes.generate' };

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function readyReadiness(overrides: Partial<KvoxAiReadiness> = {}): KvoxAiReadiness {
  return {
    ok: true,
    reason: null,
    provider: 'openai',
    model: 'gpt-4o',
    source: 'default',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    reasoningEffort: 'none',
    hasKey: true,
    ...overrides,
  };
}

function notReady(reason: KvoxAiReason): KvoxAiReadiness {
  const noModel = reason === 'ai_not_configured';
  return readyReadiness({
    ok: false,
    reason,
    hasKey: reason !== 'ai_key_missing' && reason !== 'ai_not_configured',
    ...(noModel ? { provider: null, model: null, source: 'none' as const, contextWindowTokens: null, maxOutputTokens: null } : {}),
  });
}

function build(answer: KvoxAiReadiness | ((feature: string, requested: string | null) => KvoxAiReadiness) = readyReadiness(), graphEnabled: () => Promise<boolean> = async () => true) {
  const readiness = jest.fn(async (_user: string, feature: string, requested?: string | null) =>
    typeof answer === 'function' ? answer(feature, requested ?? null) : answer,
  );
  const reader: KvoxAiReadinessReader = { readiness };
  const runtime = { stream: jest.fn(), create: jest.fn(), readiness: jest.fn() };
  const port = createKvoxAi({ runtime, taskModels: { load: jest.fn() }, readiness: reader, graphEnabled });
  return { port, readiness, runtime };
}

describe('createKvoxAi: features and tasks', () => {
  it('maps the port vocabulary to the registered feature ids', () => {
    expect(featureOf('notes.generate')).toBe('note_generate');
    expect(featureOf('notes.title')).toBe('note_retitle');
    expect(featureOf('transcripts.name_check')).toBe('transcript_name_check');
    expect(featureOf('ask.respond')).toBe('graph_agent');
    expect(featureOf('graph.agent')).toBe('graph_agent');
    expect(featureOf('graph_extract')).toBe('graph_extract');
    expect(featureOf('nonsense')).toBeUndefined();
  });

  it('refuses an unknown feature with a capability error, spending nothing', async () => {
    const { port, runtime } = build();

    await expect(port.resolveTask({ ...CTX, feature: 'nonsense' }, 'nonsense')).rejects.toMatchObject({ errorClass: 'capability' });
    await expect(
      collect(port.generateText({ ...CTX, feature: 'nonsense' }, { target: {} as never, system: '', user: '' })),
    ).rejects.toMatchObject({ errorClass: 'capability' });
    expect(runtime.stream).not.toHaveBeenCalled();
  });

  it.each([
    ['ai_key_missing', 'key_missing'],
    ['ai_not_configured', 'not_configured'],
    ['graph_disabled', 'not_configured'],
    ['model_lacks_capability', 'capability'],
    ['model_not_permitted', 'capability'],
  ] as const)('resolveTask maps the readiness reason %s to %s', async (reason, errorClass) => {
    const { port } = build(notReady(reason));

    await expect(port.resolveTask(CTX, 'notes.generate')).rejects.toMatchObject({ errorClass });
  });

  it('resolveTask hands back the model numbers and asks readiness for the mapped feature', async () => {
    const { port, readiness } = build((_feature, requested) => readyReadiness({ model: requested ?? 'gpt-4o' }));

    const target = await port.resolveTask({ ...CTX, orgId: 'org-1' }, 'ask.respond', { model: 'gpt-4o' });

    expect(target).toMatchObject({ provider: 'openai', model: 'gpt-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_384 });
    expect(readiness).toHaveBeenLastCalledWith('user-1', 'graph_agent', 'gpt-4o');
  });

  it('resolveTask names the model without a key when the caller only counts tokens (requireKey: false)', async () => {
    const { port } = build(readyReadiness({ ok: false, reason: 'ai_key_missing', hasKey: false }));

    await expect(port.resolveTask(CTX, 'transcripts.name_check')).rejects.toMatchObject({ errorClass: 'key_missing' });
    await expect(port.resolveTask(CTX, 'transcripts.name_check', { requireKey: false })).resolves.toMatchObject({ model: 'gpt-4o' });
  });

  it('resolveTask gives an embeddings target the catalog input limit and no output', async () => {
    const { port } = build(readyReadiness({ model: 'text-embedding-3-small', contextWindowTokens: null, maxOutputTokens: null }));

    await expect(port.resolveTask(CTX, 'search.embed')).resolves.toMatchObject({ contextWindowTokens: 8191, maxOutputTokens: 0 });
  });

  it('capabilities reports the reason, the embeddings and never throws', async () => {
    const { port } = build(notReady('ai_key_missing'), async () => false);

    expect(await port.capabilities(CTX)).toMatchObject({
      available: false,
      reason: 'ai_key_missing',
      graphEnabled: false,
      embeddings: { dimensions: 1536 },
    });

    const broken = build(notReady('ai_key_missing'), () => Promise.reject(new Error('db down')));
    expect(await broken.port.capabilities(CTX)).toMatchObject({ available: false, reason: 'ai_not_configured', embeddings: null });
  });

  it('capabilities reads the graph switch from the policy when the host gives none', async () => {
    const runtime = { stream: jest.fn(), create: jest.fn(), readiness: jest.fn().mockResolvedValue({ hasKey: true }) };
    const load = jest.fn().mockResolvedValue({
      provider: 'openai',
      models: [{ id: 'gpt-4o', label: 'gpt-4o', structuredOutput: true, toolCalling: true, contextWindow: null, maxOutputTokens: null }],
      policy: { enabled: true, provider: 'openai', defaultModel: 'gpt-4o', graphEnabled: true, taskModels: {}, reasoningEffort: 'none', maxInputTokens: null, maxOutputTokens: null },
    });
    const port = createKvoxAi({ runtime, taskModels: { load } });

    await expect(port.capabilities(CTX)).resolves.toMatchObject({ available: true, graphEnabled: true, structuredOutput: true });
  });
});
