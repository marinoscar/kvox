import { KvoxAiError, KvoxRateLimitError } from '../../ports/index.js';
import {
  ADJUDICATION_PROMPT_HEADINGS,
  ADJUDICATION_SCHEMA_NAME,
  buildAdjudicationSystemPrompt,
  buildAdjudicationUserContent,
  readVerdicts,
  type AdjudicationPair,
} from './adjudication-prompt.js';
import { AdjudicationService } from './adjudication.service.js';

const USER = '11111111-1111-4111-8111-111111111111';

function pair(n: number, type = 'Person'): AdjudicationPair {
  return {
    pairId: `p${n}`,
    type,
    mention: { label: `Sarah ${n}`, aliases: ['S.'], props: { title: 'CTO' }, quotes: ['Sarah said hi'] },
    candidate: {
      entityId: `aaaaaaa${n % 10}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      label: 'Sarah Chen',
      aliases: ['Sarah Chen', 'Sally'],
      props: {},
      quotes: ['x'.repeat(400)],
      neighbourhood: ['WORKS_FOR → Northwind Robotics (2019–)'],
    },
  };
}

function build(options: { answer?: (req: { user: string }) => unknown; throwOn?: number } = {}) {
  let count = 0;
  const recorded: Array<{ ctx: any; req: any }> = [];
  const ai = {
    generateStructured: jest.fn(async (ctx: unknown, req: { user: string }) => {
      count += 1;
      recorded.push({ ctx, req } as { ctx: any; req: any });
      if (options.throwOn === count) throw new KvoxAiError('rate_limit', 'slow down', 1000);
      const ids = [...req.user.matchAll(/## Pair (p\d+)/g)].map((m) => m[1]);
      return {
        value: options.answer ? options.answer(req) : { verdicts: ids.map((pairId) => ({ pairId, verdict: 'same', rationale: 'ok' })) },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
  };
  const resolver = {
    resolve: jest.fn(async () => ({
      target: { provider: 'openai', model: 'gpt-adjudicate', contextWindowTokens: 128000, maxOutputTokens: 16000, source: 'task' },
      providerId: 'openai',
      model: 'gpt-adjudicate',
      reasoningEffort: 'low',
      policy: { maxOutputTokens: 8000, maxInputTokens: 100000, reasoningEffort: 'none' },
      modelLimits: { contextWindowTokens: 128000, maxOutputTokens: 16000 },
    })),
  };
  const ontology = {
    effectiveSchemaFor: jest.fn(async () => ({
      entityType: (key: string) => ({ key, label: key, description: `A ${key}.`, disambiguation: [`Rule for ${key}.`] }),
    })),
  };
  const service = new AdjudicationService({} as never, resolver as never, ai as never, ontology as never);
  return { service, ai: { calls: recorded }, resolver };
}

describe('AdjudicationService.adjudicate', () => {
  it('batches ≤ 20 pairs per call (45 pairs → 3 calls) on the graph.adjudicate model', async () => {
    const { service, ai, resolver } = build();
    const pairs = Array.from({ length: 45 }, (_, i) => pair(i + 1));
    const out = await service.adjudicate(USER, pairs, { jobType: 'kg.extract' });
    expect(ai.calls).toHaveLength(3);
    expect(resolver.resolve).toHaveBeenCalledWith(USER, 'graph.adjudicate');
    expect(out.size).toBe(45);
    expect(out.get('p45')).toEqual({ verdict: 'same', rationale: 'ok', model: 'gpt-adjudicate' });
    const call = ai.calls[0];
    expect(call.ctx).toEqual(expect.objectContaining({ userId: USER, orgId: null, feature: 'graph.adjudicate' }));
    expect(call.req.target).toEqual(expect.objectContaining({ model: 'gpt-adjudicate' }));
    expect(call.req).toEqual(expect.objectContaining({ schemaName: ADJUDICATION_SCHEMA_NAME, jsonSchema: expect.any(Object) }));
  });

  it('ignores a verdict for an unknown pair id and treats a missing one as uncertain', async () => {
    const { service } = build({
      answer: () => ({
        verdicts: [
          { pairId: 'p1', verdict: 'different', rationale: 'another company' },
          { pairId: 'p99', verdict: 'same', rationale: 'ghost' },
        ],
      }),
    });
    const out = await service.adjudicate(USER, [pair(1), pair(2)], { jobType: 'kg.extract' });
    expect(out.get('p1')?.verdict).toBe('different');
    expect(out.get('p2')?.verdict).toBe('uncertain');
    expect(out.has('p99')).toBe(false);
  });

  it('defers a rate limit on the calling user\'s own throttle key', async () => {
    const { service } = build({ throwOn: 2 });
    const failure = await service
      .adjudicate(USER, Array.from({ length: 21 }, (_, i) => pair(i + 1)), { jobType: 'kg.resolve' })
      .catch((error: unknown) => error);
    expect((failure as KvoxRateLimitError).throttleKey).toBe(`ai-provider:${USER}`);
  });

  it('passes the calling job id so the usage row links to it', async () => {
    const { service, ai } = build();
    await service.adjudicate(USER, [pair(1)], { jobType: 'kg.extract', jobId: 'job-9' });
    expect(ai.calls[0].ctx.jobId).toBe('job-9');
  });

  it('rethrows a KvoxRateLimitError', async () => {
    const { service } = build({ throwOn: 1 });
    await expect(service.adjudicate(USER, [pair(1)], { jobType: 'kg.extract' })).rejects.toBeInstanceOf(KvoxRateLimitError);
  });

  it('makes no call for no pairs', async () => {
    const { service, ai, resolver } = build();
    expect((await service.adjudicate(USER, [], { jobType: 'kg.extract' })).size).toBe(0);
    expect(ai.calls).toHaveLength(0);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});

describe('AdjudicationService.adjudicateItems (#365)', () => {
  function itemPair(n: number) {
    return {
      pairId: `p${n}`,
      kind: 'commitment',
      subjectType: 'Project',
      proposed: { title: 'Ship', statement: 'Sarah ships the migration by May.', occurredAt: null, dueAt: '2026-05-01', ownerLabel: 'Sarah', quotes: [] },
      existing: { title: 'Ship', statement: 'Sarah ships the migration.', occurredAt: null, dueAt: '2026-04-01', status: 'open', ownerLabel: 'Sarah' },
    };
  }

  it('batches ≤ 20 item pairs per call on graph.adjudicate', async () => {
    const { service, ai, resolver } = build({
      answer: (req) => ({
        verdicts: [...req.user.matchAll(/## Pair (p\d+)/g)].map((m) => ({
          pairId: m[1],
          verdict: 'same',
          changes: { status: null, dueAt: '2026-05-01' },
          rationale: 'new date',
        })),
      }),
    });
    const out = await service.adjudicateItems(USER, Array.from({ length: 21 }, (_, i) => itemPair(i + 1)), { jobType: 'kg.extract' });
    expect(ai.calls).toHaveLength(2);
    expect(resolver.resolve).toHaveBeenCalledWith(USER, 'graph.adjudicate');
    expect(out.get('p21')).toEqual({
      verdict: 'same',
      changes: { status: null, dueAt: '2026-05-01' },
      rationale: 'new date',
      model: 'gpt-adjudicate',
    });
    expect(ai.calls[0].req).toEqual(expect.objectContaining({ schemaName: 'kg_item_adjudication' }));
  });

  it('leaves an unanswered pair out, and rethrows a KvoxRateLimitError', async () => {
    const { service } = build({ answer: () => ({ verdicts: [] }) });
    expect((await service.adjudicateItems(USER, [itemPair(1)], { jobType: 'kg.extract' })).size).toBe(0);
    const limited = build({ throwOn: 1 });
    await expect(limited.service.adjudicateItems(USER, [itemPair(1)], { jobType: 'kg.extract' })).rejects.toBeInstanceOf(KvoxRateLimitError);
  });
});

describe('the adjudication prompt', () => {
  it('uses the exported headings and bounds quotes to 200 characters', () => {
    const content = buildAdjudicationUserContent([pair(1)]);
    const h = ADJUDICATION_PROMPT_HEADINGS;
    expect(content).toContain(`${h.pair} p1 (Person)`);
    expect(content).toContain(`${h.mention} Sarah 1`);
    expect(content).toContain(`${h.candidate} aaaaaaa1: Sarah Chen`);
    expect(content).toContain(h.neighbourhood);
    expect(content).toContain('WORKS_FOR → Northwind Robotics (2019–)');
    const longQuote = content.split('\n').find((l) => l.startsWith('  - "x'))!;
    expect(longQuote.length).toBeLessThanOrEqual(200 + 6);
  });

  it('states the rule and carries the type description and disambiguation', () => {
    const system = buildAdjudicationSystemPrompt([{ key: 'Person', description: 'A human.', disambiguation: ['Match on employer.'] }]);
    expect(system).toContain('`uncertain` is a good answer');
    expect(system).toContain('Never guess from a shared first name alone');
    expect(system).toContain('same real-world Person');
    expect(system).toContain('A human.');
    expect(system).toContain('- Match on employer.');
  });

  it('reads verdicts leniently, clipping an over-long rationale', () => {
    const out = readVerdicts({ verdicts: [{ pairId: 'p1', verdict: 'same', rationale: 'r'.repeat(900) }, { pairId: 'p1', verdict: 'different', rationale: '' }, 'junk'] }, new Set(['p1']));
    expect(out.get('p1')).toEqual({ verdict: 'same', rationale: 'r'.repeat(500) });
    expect(readVerdicts(null, new Set(['p1'])).size).toBe(0);
  });
});
