import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NoteAccessService } from '../../notes/access/note-access.service';
import { GRAPH_PREFERENCE_DEFAULTS } from '../preferences/graph-preferences.defaults';
import { IDS, makeInput, schemaFor } from '../../../test/graph/extraction-fixtures';
import { GraphExtractionService, KG_EXTRACT_PRIORITY } from './graph-extraction.service';

const USER = { id: IDS.owner, email: 'o@example.test', roles: ['Viewer'], permissions: ['graph:write', 'graph:read'], isActive: true };

function noteRow(over: Record<string, unknown> = {}) {
  return { id: IDS.note, ownerId: IDS.owner, status: 'ready', currentVersion: 2, deletedAt: null, title: 'Pilot kickoff', ...over };
}

function resolution(over: Record<string, unknown> = {}) {
  return {
    providerId: 'openai',
    model: 'gpt-4o',
    reasoningEffort: 'medium',
    countTokens: (t: string) => Math.ceil(t.length / 4),
    descriptor: { id: 'gpt-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_000 },
    policy: { maxOutputTokens: 8_000, maxInputTokens: 100_000, requestTimeoutMs: 60_000, providers: {} },
    source: 'task',
    keyConfigured: true,
    ...over,
  };
}

const conflict = (reason: string) => new ConflictException({ message: reason, details: { reason } });

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
}

function harness() {
  const tx = {
    kgProposal: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'proposal-1', createdAt: new Date('2026-03-05T00:00:00Z'), ...args.data })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'proposal-1',
        noteVersion: 2,
        createdAt: new Date('2026-03-05T00:00:00Z'),
        ...args.data,
      })),
    },
  };
  const prisma = {
    note: { findUnique: jest.fn(async () => noteRow()) },
    kgEntity: { findMany: jest.fn(async () => [] as Array<{ id: string }>) },
    user: { findFirst: jest.fn(async () => ({ id: IDS.owner }) as { id: string } | null) },
    auditEvent: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const resolver = { resolve: jest.fn(async () => resolution()) };
  const aiSettings = { get: jest.fn(async () => ({ graphEnabled: true })) };
  const preferences = { get: jest.fn(async () => GRAPH_PREFERENCE_DEFAULTS) };
  const ontology = { effectiveSchemaFor: jest.fn(async () => schemaFor()) };
  const loader = { load: jest.fn(async () => makeInput()) };
  const jobs = { enqueueWithin: jest.fn(async () => ({ id: 'job-1' })) };

  const service = new GraphExtractionService(
    prisma as never,
    new NoteAccessService(prisma as never),
    resolver as never,
    aiSettings as never,
    preferences as never,
    ontology as never,
    loader as never,
    jobs as never,
  );
  return { service, prisma, tx, resolver, aiSettings, preferences, loader, jobs };
}

async function rejection(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
}

const bodyOf = (e: HttpException) => e.getResponse() as { message: string; details?: Record<string, unknown> };

describe('GraphExtractionService.request (#363)', () => {
  it('creates an extracting proposal and its job in one transaction, audits, and answers with the estimate', async () => {
    const { service, tx, jobs, prisma, loader } = harness();
    const out = await service.request(USER, IDS.note, { model: 'gpt-4o' });

    expect(tx.kgProposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: IDS.owner,
        kind: 'extraction',
        status: 'extracting',
        noteId: IDS.note,
        noteVersion: 2,
        model: 'gpt-4o',
        provider: 'openai',
        stats: expect.objectContaining({ phase: 'extracting' }),
      }),
    });
    expect(jobs.enqueueWithin).toHaveBeenCalledWith(tx, {
      type: 'kg.extract',
      reason: 'rerun',
      subjectType: 'note',
      subjectId: IDS.note,
      priority: KG_EXTRACT_PRIORITY,
      payload: { proposalId: 'proposal-1', noteId: IDS.note, noteVersion: 2, userId: IDS.owner, model: 'gpt-4o', reason: 'user_request' },
    });
    expect(tx.kgProposal.update).toHaveBeenCalledWith({ where: { id: 'proposal-1' }, data: { jobId: 'job-1' } });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'graph.extraction_requested',
        targetType: 'note',
        targetId: IDS.note,
        meta: { proposalId: 'proposal-1', model: 'gpt-4o', reason: 'user_request', guidance: false },
      }),
    });
    expect(out.proposal).toEqual(
      expect.objectContaining({ id: 'proposal-1', noteId: IDS.note, noteVersion: 2, status: 'extracting', model: 'gpt-4o', providerId: 'openai' }),
    );
    expect(out.estimate).toEqual(expect.objectContaining({ requests: 1, fits: true, keyConfigured: true, maxOutputTokens: 8_000 }));
    expect(loader.load).toHaveBeenCalledWith({ userId: IDS.owner, noteId: IDS.note, noteVersion: 2, guidance: null });
  });

  it('stores guidance on the proposal and in the audit', async () => {
    const { service, tx, prisma } = harness();
    await service.request(USER, IDS.note, { userGuidance: { pinnedEntityIds: [], entityTypes: ['Person'], instructions: 'Focus.' } });
    expect(tx.kgProposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userGuidance: { pinnedEntityIds: [], entityTypes: ['Person'], instructions: 'Focus.' } }),
    });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: expect.objectContaining({ guidance: true }) }) });
  });

  describe('404', () => {
    it.each([
      ['missing', null],
      ['deleted', noteRow({ deletedAt: new Date() })],
      ['not yours', noteRow({ ownerId: '99999999-0000-4000-8000-000000000000' })],
    ])('the same 404 for a note that is %s', async (_label, row) => {
      const { service, prisma } = harness();
      prisma.note.findUnique.mockResolvedValueOnce(row as never);
      const error = await rejection(service.request(USER, IDS.note, {}));
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe('Note not found');
    });
  });

  describe('409', () => {
    it('note_not_ready when the note is not ready', async () => {
      const { service, prisma } = harness();
      prisma.note.findUnique.mockResolvedValueOnce(noteRow({ status: 'generating' }) as never);
      const error = await rejection(service.request(USER, IDS.note, {}));
      expect(error).toBeInstanceOf(ConflictException);
      expect(bodyOf(error).details).toEqual({ reason: 'note_not_ready' });
    });

    it.each(['graph_disabled', 'ai_not_configured', 'ai_key_missing', 'model_lacks_capability'])(
      '%s from the task resolver passes through unchanged',
      async (reason) => {
        const { service, resolver, tx } = harness();
        resolver.resolve.mockRejectedValueOnce(conflict(reason));
        const error = await rejection(service.request(USER, IDS.note, {}));
        expect(bodyOf(error).details).toEqual({ reason });
        expect(tx.kgProposal.create).not.toHaveBeenCalled();
      },
    );

    it('extraction_running when the extracting-proposal index refuses the insert', async () => {
      const { service, tx, prisma } = harness();
      tx.kgProposal.create.mockRejectedValueOnce(p2002());
      const error = await rejection(service.request(USER, IDS.note, {}));
      expect(error).toBeInstanceOf(ConflictException);
      expect(bodyOf(error).details).toEqual({ reason: 'extraction_running' });
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('400', () => {
    it('a model the resolver refuses', async () => {
      const { service, resolver } = harness();
      resolver.resolve.mockRejectedValueOnce(new BadRequestException({ message: 'not permitted', details: { reason: 'model_not_permitted' } }));
      const error = await rejection(service.request(USER, IDS.note, { model: 'gpt-nope' }));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(resolver.resolve).toHaveBeenCalledWith(IDS.owner, 'graph.extract', 'gpt-nope');
    });

    it('unknown type keys, named', async () => {
      const { service } = harness();
      const error = await rejection(
        service.request(USER, IDS.note, {
          userGuidance: { pinnedEntityIds: [], entityTypes: ['Person', 'Team'], relationTypes: ['RELATED_TO'], instructions: '' },
        }),
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(bodyOf(error).details).toEqual({ unknownTypes: ['Team', 'RELATED_TO'] });
    });

    it('pins that are not live entities of yours, named', async () => {
      const { service, prisma } = harness();
      prisma.kgEntity.findMany.mockResolvedValueOnce([{ id: IDS.sarah }]);
      const error = await rejection(
        service.request(USER, IDS.note, { userGuidance: { pinnedEntityIds: [IDS.sarah, IDS.pilot], instructions: '' } }),
      );
      expect(bodyOf(error).details).toEqual({ invalidPinnedIds: [IDS.pilot] });
      expect(prisma.kgEntity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ownerId: IDS.owner, mergedIntoId: null, reviewStatus: { in: ['accepted', 'edited'] } }),
        }),
      );
    });

    it('over budget, with the numbers', async () => {
      const { service, resolver, tx } = harness();
      resolver.resolve.mockResolvedValueOnce(resolution({ policy: { maxOutputTokens: 8_000, maxInputTokens: 50 } }));
      const error = await rejection(service.request(USER, IDS.note, {}));
      expect(error).toBeInstanceOf(BadRequestException);
      const body = bodyOf(error);
      expect(body.details).toEqual({ promptTokens: expect.any(Number), availableInputTokens: 50, model: 'gpt-4o' });
      expect(body.message).toMatch(/^This source is approximately [\d,]+ tokens; gpt-4o allows 50 for input/);
      expect(tx.kgProposal.create).not.toHaveBeenCalled();
    });
  });
});

describe('GraphExtractionService.estimate (#363)', () => {
  it('resolves without requiring a key and reports keyConfigured', async () => {
    const { service, resolver } = harness();
    resolver.resolve.mockResolvedValueOnce(resolution({ keyConfigured: false }));
    const out = await service.estimate(USER, IDS.note, 'gpt-4o');
    expect(resolver.resolve).toHaveBeenCalledWith(IDS.owner, 'graph.extract', 'gpt-4o', { requireKey: false });
    expect(out).toEqual(
      expect.objectContaining({ providerId: 'openai', model: 'gpt-4o', keyConfigured: false, requests: 1, fits: true, availableInputTokens: 100_000 }),
    );
    expect(out.inputTokens).toBeGreaterThan(0);
  });

  it('404 for a note that is not yours', async () => {
    const { service, prisma } = harness();
    prisma.note.findUnique.mockResolvedValueOnce(noteRow({ ownerId: '99999999-0000-4000-8000-000000000000' }) as never);
    await expect(service.estimate(USER, IDS.note)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GraphExtractionService.enqueueForReadyNote (#363)', () => {
  it('queues one extraction with no guidance and the default task model when every gate is open', async () => {
    const { service, jobs, resolver, tx } = harness();
    await expect(service.enqueueForReadyNote(IDS.note, IDS.owner)).resolves.toBe('proposal-1');
    expect(resolver.resolve).toHaveBeenCalledWith(IDS.owner, 'graph.extract');
    expect(tx.kgProposal.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userGuidance: Prisma.DbNull }) });
    expect(jobs.enqueueWithin).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ reason: 'upload', payload: expect.objectContaining({ reason: 'note_ready' }) }),
    );
  });

  type Gate = (h: ReturnType<typeof harness>) => void;
  const gates: Array<[string, Gate]> = [
    ['ai.graphEnabled is off', (h) => h.aiSettings.get.mockResolvedValueOnce({ graphEnabled: false })],
    ['the owner lacks graph:write', (h) => h.prisma.user.findFirst.mockResolvedValueOnce(null)],
    [
      'auto-extract is off',
      (h) =>
        h.preferences.get.mockResolvedValueOnce({ ...GRAPH_PREFERENCE_DEFAULTS, extraction: { autoExtract: false } }),
    ],
    ['the resolver refuses (no key)', (h) => h.resolver.resolve.mockRejectedValueOnce(conflict('ai_key_missing'))],
    ['the resolver refuses (lacks capability)', (h) => h.resolver.resolve.mockRejectedValueOnce(conflict('model_lacks_capability'))],
    ['the note is no longer ready', (h) => h.prisma.note.findUnique.mockResolvedValueOnce(noteRow({ status: 'generating' }) as never)],
    ['an extraction is already running', (h) => h.tx.kgProposal.create.mockRejectedValueOnce(p2002())],
  ];

  it.each(gates)('is a silent no-op when %s', async (_label, close) => {
    const h = harness();
    close(h);
    await expect(h.service.enqueueForReadyNote(IDS.note, IDS.owner)).resolves.toBeNull();
    expect(h.prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('checks graph:write through the role-permission join', async () => {
    const { service, prisma } = harness();
    await service.enqueueForReadyNote(IDS.note, IDS.owner);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: IDS.owner,
          userRoles: { some: { role: { rolePermissions: { some: { permission: { name: 'graph:write' } } } } } },
        }),
      }),
    );
  });

  it('an unexpected failure propagates (the caller logs it)', async () => {
    const { service, resolver } = harness();
    resolver.resolve.mockRejectedValueOnce(new Error('db down'));
    await expect(service.enqueueForReadyNote(IDS.note, IDS.owner)).rejects.toThrow('db down');
  });
});
