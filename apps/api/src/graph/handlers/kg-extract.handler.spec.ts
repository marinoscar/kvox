import { ConflictException } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { AiAuthError, AiRefusedError, AiStructuredOutputError } from '../../ai/ai-errors';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { GRAPH_PREFERENCE_DEFAULTS } from '../preferences/graph-preferences.defaults';
import { ProposalStageRegistry, type ProposalStage } from '../extraction/proposal-stage';
import type { ProposedRow } from '../extraction/validate';
import { IDS, goodAnswer, makeInput } from '../../../test/graph/extraction-fixtures';
import { KgExtractHandler, readKgExtractPayload } from './kg-extract.handler';

const PROPOSAL = '1a000000-0000-4000-8000-000000000001';

const payload = {
  proposalId: PROPOSAL,
  noteId: IDS.note,
  noteVersion: 2,
  userId: IDS.owner,
  model: 'gpt-4o',
  reason: 'user_request',
};

const job = (p: unknown = payload) => ({ id: 'job-1', payload: p }) as unknown as Job;

function harness(options: { answer?: unknown; stages?: ProposalStage[] } = {}) {
  const calls: string[] = [];
  const generateStructured = jest.fn(async () => {
    calls.push('provider');
    return { value: options.answer ?? goodAnswer(), usage: { promptTokens: 1234, completionTokens: 321 }, finishReason: 'stop' };
  });
  const provider = {
    id: 'openai',
    label: 'OpenAI',
    settingsSchema: z.object({}).passthrough(),
    countTokens: (t: string) => Math.ceil(t.length / 4),
    generateStructured,
  };
  const resolution = {
    providerId: 'openai',
    provider,
    model: 'gpt-4o',
    reasoningEffort: 'medium',
    countTokens: (t: string) => Math.ceil(t.length / 4),
    descriptor: { id: 'gpt-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_000, structuredOutput: true },
    policy: { maxOutputTokens: 8_000, maxInputTokens: 100_000, requestTimeoutMs: 60_000, providers: { openai: {} } },
    source: 'requested',
    keyConfigured: true,
  };

  let written: ProposedRow[] = [];
  let ids: string[] = [];
  const writer = {
    recordPrompt: jest.fn(async () => {
      calls.push('recordPrompt');
    }),
    writeItems: jest.fn(async (_p: string, _o: string, rows: ProposedRow[]) => {
      calls.push('writeItems');
      written = rows;
      ids = rows.map((_, i) => `item-${i}`);
      return ids;
    }),
    finalize: jest.fn(async () => {
      calls.push('finalize');
      return true;
    }),
    markFailed: jest.fn(async () => undefined),
  };

  const prisma = {
    kgProposal: {
      findUnique: jest.fn(async (args: { select: Record<string, boolean> }) =>
        args.select.userGuidance ? { userGuidance: null } : { id: PROPOSAL, status: 'extracting', ownerId: IDS.owner },
      ),
    },
    note: { findUnique: jest.fn(async () => ({ id: IDS.note, ownerId: IDS.owner, deletedAt: null, status: 'ready' })) },
    kgProposalItem: {
      findMany: jest.fn(async () =>
        written.map((row, i) => ({ id: ids[i], kind: row.kind, payload: row.payload, resolution: row.resolution, flags: row.flags, decision: 'pending' })),
      ),
    },
  };

  const registry = { register: jest.fn() };
  const loader = { load: jest.fn(async () => makeInput()) };
  const resolver = { resolve: jest.fn(async () => resolution) };
  const credentials = { getSecret: jest.fn(async () => 'sk-test-key') };
  const throttle = {
    registerProviderKey: jest.fn(() => {
      calls.push('throttle');
    }),
  };
  const stages = new ProposalStageRegistry();
  for (const stage of options.stages ?? []) stages.register(stage);
  const preferences = { get: jest.fn(async () => GRAPH_PREFERENCE_DEFAULTS) };

  const handler = new KgExtractHandler(
    registry as never,
    prisma as never,
    loader as never,
    resolver as never,
    credentials as never,
    throttle as never,
    writer as never,
    stages,
    preferences as never,
  );
  return { handler, calls, writer, prisma, resolver, credentials, throttle, generateStructured, loader, registry };
}

describe('KgExtractHandler (#363)', () => {
  it('declares its profile, and is server-only', () => {
    const { handler } = harness();
    expect(handler.type).toBe('kg.extract');
    expect(handler.profile).toEqual({ maxRuntimeMs: 600_000, maxAttempts: 1 });
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
  });

  it('registers itself on module init', () => {
    const { handler, registry } = harness();
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('the happy path writes items, evidence and stats, then moves extracting → draft', async () => {
    const { handler, writer } = harness();
    await handler.process(job());

    const [proposalId, ownerId, rows, stats] = writer.writeItems.mock.calls[0] as unknown as [string, string, ProposedRow[], Record<string, unknown>];
    expect(proposalId).toBe(PROPOSAL);
    expect(ownerId).toBe(IDS.owner);
    expect(rows[0].payload).toEqual(expect.objectContaining({ ref: 'meeting', type: 'Meeting' }));
    for (const row of rows) expect(row.evidence.length).toBeGreaterThan(0);
    expect(stats).toEqual(expect.objectContaining({ usage: { inputTokens: 1234, outputTokens: 321 } }));

    const [, noteId, decisions, finalStats] = writer.finalize.mock.calls[0] as unknown as [string, string, Array<{ id: string; decision: string }>, Record<string, unknown>];
    expect(noteId).toBe(IDS.note);
    expect(decisions).toHaveLength(rows.length);
    expect(finalStats).toEqual(
      expect.objectContaining({
        phase: 'ready',
        proposed: { entities: 3, relations: 2, items: 2 },
        dropped: { uncited: 0, invalid: 0, unknownType: 0, dangling: 0 },
      }),
    );
    expect(writer.markFailed).not.toHaveBeenCalled();
  });

  it('applies the pre-check: a model-claimed match waits, the meeting is accepted', async () => {
    const { handler, writer } = harness();
    await handler.process(job());
    const rows = writer.writeItems.mock.calls[0][2] as ProposedRow[];
    const decisions = (writer.finalize.mock.calls[0] as unknown[])[2] as Array<{ decision: string }>;
    const decisionOf = (ref: string) => decisions[rows.findIndex((r) => r.kind === 'entity' && r.payload.ref === ref)].decision;
    expect(decisionOf('meeting')).toBe('accept');
    expect(decisionOf('k1')).toBe('pending');
    expect(decisionOf('e1')).toBe('accept');
  });

  it('records the prompt BEFORE the provider call, and registers the per-user throttle key right before it', async () => {
    const { handler, calls, writer, throttle, generateStructured } = harness();
    await handler.process(job());
    expect(calls.indexOf('recordPrompt')).toBeLessThan(calls.indexOf('provider'));
    expect(calls.indexOf('throttle')).toBe(calls.indexOf('provider') - 1);
    expect(throttle.registerProviderKey).toHaveBeenCalledWith('kg.extract', `ai-provider:${IDS.owner}`);
    expect(writer.recordPrompt).toHaveBeenCalledWith(
      PROPOSAL,
      expect.objectContaining({ model: 'gpt-4o', provider: 'openai', systemPrompt: expect.any(String), userContent: expect.any(String) }),
    );
    expect(generateStructured).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'gpt-4o', schemaName: 'kg_extraction', maxOutputTokens: 8_000, timeoutMs: 60_000 }),
    );
  });

  it('re-validates the payload model through the resolver', async () => {
    const { handler, resolver } = harness();
    await handler.process(job());
    expect(resolver.resolve).toHaveBeenCalledWith(IDS.owner, 'graph.extract', 'gpt-4o');
  });

  it('rethrows a RateLimitError and leaves the proposal untouched', async () => {
    const { handler, writer, generateStructured } = harness();
    generateStructured.mockRejectedValueOnce(new RateLimitError('slow down', 30_000));
    await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);
    expect(writer.markFailed).not.toHaveBeenCalled();
    expect(writer.finalize).not.toHaveBeenCalled();
  });

  it.each([
    ['auth', new AiAuthError('Your key was refused.', 'openai')],
    ['refusal', new AiRefusedError('Declined.', undefined, 'openai')],
    ['invalid_output', new AiStructuredOutputError('Cut off.', 'truncated', 'openai')],
  ])('a terminal %s failure marks the proposal failed and returns', async (errorClass, error) => {
    const { handler, writer, generateStructured } = harness();
    generateStructured.mockRejectedValueOnce(error);
    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(writer.markFailed).toHaveBeenCalledWith(PROPOSAL, expect.anything(), { errorClass, message: error.message });
  });

  it('a malformed answer is invalid_output, returns, and writes no items', async () => {
    const { handler, writer } = harness({ answer: { entities: 'nope' } });
    await handler.process(job());
    expect(writer.markFailed).toHaveBeenCalledWith(PROPOSAL, expect.anything(), expect.objectContaining({ errorClass: 'invalid_output' }));
    expect(writer.writeItems).not.toHaveBeenCalled();
  });

  it('an over-budget prompt is a budget failure, and the provider is never called', async () => {
    const { handler, writer, generateStructured, resolver } = harness();
    const r = await resolver.resolve();
    resolver.resolve.mockResolvedValueOnce({ ...r, policy: { ...r.policy, maxInputTokens: 10 } });
    await handler.process(job());
    expect(generateStructured).not.toHaveBeenCalled();
    expect(writer.markFailed).toHaveBeenCalledWith(PROPOSAL, expect.anything(), expect.objectContaining({ errorClass: 'budget' }));
    // The prompt was recorded all the same.
    expect(writer.recordPrompt).toHaveBeenCalled();
  });

  it('a missing key is an auth failure, and the provider is never called', async () => {
    const { handler, writer, credentials, generateStructured } = harness();
    credentials.getSecret.mockResolvedValueOnce(null as never);
    await handler.process(job());
    expect(generateStructured).not.toHaveBeenCalled();
    expect(writer.markFailed).toHaveBeenCalledWith(PROPOSAL, expect.anything(), expect.objectContaining({ errorClass: 'auth' }));
  });

  it('a resolver refusal (graph switched off since the request) fails the proposal and returns', async () => {
    const { handler, writer, resolver } = harness();
    resolver.resolve.mockRejectedValueOnce(
      new ConflictException({ message: 'Connected knowledge is switched off.', details: { reason: 'graph_disabled' } }),
    );
    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(writer.markFailed).toHaveBeenCalledWith(PROPOSAL, expect.anything(), {
      errorClass: 'refusal',
      message: 'Connected knowledge is switched off.',
    });
  });

  it('an unexpected error marks the proposal failed and rethrows', async () => {
    const { handler, writer, generateStructured } = harness();
    generateStructured.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(handler.process(job())).rejects.toThrow('socket hang up');
    expect(writer.markFailed).toHaveBeenCalledWith(PROPOSAL, expect.anything(), {
      errorClass: 'other',
      message: 'Extraction failed because of an unexpected error.',
    });
  });

  it('runs stages in order, after the items are written and before finalize, merging their stats', async () => {
    const order: string[] = [];
    const stage = (name: string, n: number): ProposalStage => ({
      name,
      order: n,
      run: async (ctx) => {
        order.push(name);
        ctx.stats.ran = true;
        expect(ctx.preferences).toBe(GRAPH_PREFERENCE_DEFAULTS);
        expect(ctx.proposalId).toBe(PROPOSAL);
      },
    });
    const { handler, calls, writer } = harness({ stages: [stage('temporal-closing', 300), stage('resolution', 100), stage('work-item-dedup', 200)] });
    await handler.process(job());
    expect(order).toEqual(['resolution', 'work-item-dedup', 'temporal-closing']);
    expect(calls.indexOf('writeItems')).toBeLessThan(calls.indexOf('finalize'));
    const finalStats = (writer.finalize.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
    expect(finalStats.resolution).toEqual({ ran: true });
  });

  it('a stage that throws fails the proposal, naming the stage, and the job fails', async () => {
    const { handler, writer } = harness({
      stages: [{ name: 'resolution', order: 100, run: async () => Promise.reject(new Error('boom')) }],
    });
    await expect(handler.process(job())).rejects.toThrow('boom');
    expect(writer.markFailed).toHaveBeenCalledWith(PROPOSAL, expect.anything(), {
      errorClass: 'other',
      message: "Extraction failed in the 'resolution' step.",
    });
    expect(writer.finalize).not.toHaveBeenCalled();
  });

  it('a stage rate limit defers the job without failing the proposal', async () => {
    const { handler, writer } = harness({
      stages: [{ name: 'resolution', order: 100, run: async () => Promise.reject(new RateLimitError('later', 1000)) }],
    });
    await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);
    expect(writer.markFailed).not.toHaveBeenCalled();
  });

  it('is a no-op for an unreadable payload or a proposal no longer extracting', async () => {
    const a = harness();
    await a.handler.process(job({ nope: true }));
    expect(a.loader.load).not.toHaveBeenCalled();

    const b = harness();
    b.prisma.kgProposal.findUnique.mockResolvedValueOnce({ id: PROPOSAL, status: 'discarded', ownerId: IDS.owner } as never);
    await b.handler.process(job());
    expect(b.loader.load).not.toHaveBeenCalled();
    expect(b.writer.markFailed).not.toHaveBeenCalled();
  });

  it('a note deleted meanwhile fails the proposal and returns', async () => {
    const { handler, writer, prisma } = harness();
    prisma.note.findUnique.mockResolvedValueOnce(null as never);
    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(writer.markFailed).toHaveBeenCalledWith(PROPOSAL, expect.anything(), expect.objectContaining({ errorClass: 'other' }));
  });

  it('reads its payload strictly', () => {
    expect(readKgExtractPayload(payload)).toEqual(payload);
    expect(readKgExtractPayload({ ...payload, reason: 'cron' })).toBeNull();
    expect(readKgExtractPayload({ ...payload, noteVersion: 0 })).toBeNull();
  });
});
