import { ConflictException } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { RateLimitError } from '../../jobs/rate-limit.error';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { KG_ENTITY_DIGEST_JOB_TYPE } from '../job-types';
import * as queries from './brief-queries';
import { DigestCitationError } from './citation-validation';
import { EntityDigestHandler, ENTITY_DIGEST_MAX_RUNTIME_MS } from './entity-digest.handler';

jest.mock('./brief-queries', () => ({
  ...jest.requireActual('./brief-queries'),
  digestItems: jest.fn(),
  digestRelations: jest.fn(),
  newestChange: jest.fn(),
  evidenceIdsFor: jest.fn(),
  ownedEvidenceIds: jest.fn(),
}));

const q = queries as jest.Mocked<typeof queries>;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = U(1);
const ENTITY = U(2);
const ITEM = U(3);
const EV = U(4);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function makeJob(payload: unknown = { entityId: ENTITY, ownerId: OWNER }): Job {
  return { id: 'job-1', type: KG_ENTITY_DIGEST_JOB_TYPE, payload } as unknown as Job;
}

function setup(over: { resolve?: jest.Mock; generateStructured?: jest.Mock; entity?: unknown; previous?: unknown } = {}) {
  const generateStructured =
    over.generateStructured ??
    jest.fn().mockResolvedValue({
      value: { statements: [{ text: 'Acme chose blue', factRefs: ['F1'] }, { text: 'Uncited', factRefs: [] }] },
      usage: { promptTokens: 120, completionTokens: 30 },
      finishReason: 'stop',
    });
  const provider = {
    id: 'openai',
    label: 'OpenAI',
    settingsSchema: { safeParse: () => ({ success: true, data: {} }) },
    generateStructured,
  };
  const resolver = {
    resolve:
      over.resolve ??
      jest.fn().mockResolvedValue({ provider, providerId: 'openai', model: 'model-x', reasoningEffort: 'low', policy: { providers: {} } }),
  };
  const prisma = {
    kgEntity: {
      findFirst: jest.fn().mockResolvedValue(
        over.entity === undefined
          ? { id: ENTITY, type: 'Organization', label: 'Acme', reviewStatus: 'accepted', mergedIntoId: null }
          : over.entity,
      ),
    },
    kgEntityDigest: {
      findFirst: jest.fn().mockResolvedValue(over.previous ?? null),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const registry = { register: jest.fn() };
  const credentials = { getSecret: jest.fn().mockResolvedValue('sk-user') };
  const throttle = { registerProviderKey: jest.fn() };
  const ontology = {
    effectiveSchemaFor: jest.fn().mockResolvedValue({
      relationTypes: [{ key: 'HAS_ROLE', exclusive: 'soft', label: 'Has role' }],
      relationType: (k: string) => (k === 'HAS_ROLE' ? { label: 'Has role' } : undefined),
    }),
  };
  const handler = new EntityDigestHandler(
    registry as never,
    prisma as never,
    resolver as never,
    credentials as never,
    throttle as never,
    ontology as never,
  );
  return { handler, prisma, resolver, credentials, throttle, generateStructured, registry };
}

beforeEach(() => {
  jest.clearAllMocks();
  q.digestItems.mockResolvedValue([
    {
      id: ITEM,
      kind: 'decision',
      title: null,
      statement: 'Acme chose the blue plan',
      status: 'active',
      occurredAt: new Date('2026-09-10T00:00:00Z'),
      dueAt: null,
      sensitivity: null,
    },
  ]);
  q.digestRelations.mockResolvedValue([]);
  q.newestChange.mockResolvedValue({ at: new Date('2026-09-10T00:00:00Z'), writtenAt: new Date('2026-09-11T00:00:00Z') });
  q.evidenceIdsFor.mockResolvedValue(new Map([[`item:${ITEM}`, [EV]]]));
  q.ownedEvidenceIds.mockResolvedValue(new Set());
});

describe('EntityDigestHandler', () => {
  it('declares its type, a one-attempt five-minute profile, and no node members', () => {
    const { handler, registry } = setup();
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('kg.entity_digest');
    expect(handler.profile).toEqual({ maxRuntimeMs: ENTITY_DIGEST_MAX_RUNTIME_MS, maxAttempts: 1 });
    expect(ENTITY_DIGEST_MAX_RUNTIME_MS).toBe(5 * 60_000);
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
  });

  it('writes the cited statements, drops the uncited one, and records covers_until', async () => {
    const { handler, prisma, throttle, generateStructured, resolver } = setup();
    await handler.process(makeJob());

    expect(resolver.resolve).toHaveBeenCalledWith(OWNER, 'graph.digest');
    expect(throttle.registerProviderKey).toHaveBeenCalledWith('kg.entity_digest', aiProviderThrottleKey(OWNER));
    // Registered BEFORE the call.
    expect(throttle.registerProviderKey.mock.invocationCallOrder[0]).toBeLessThan(generateStructured.mock.invocationCallOrder[0]);

    const request = generateStructured.mock.calls[0][1];
    expect(request).toMatchObject({ model: 'model-x', schemaName: 'entity_digest', maxOutputTokens: 1200, timeoutMs: 60_000 });
    expect(request.userContent).toContain('F1: [2026-09-10, decision] Acme chose the blue plan');
    expect(request.userContent).not.toMatch(UUID);

    const upsert = prisma.kgEntityDigest.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ entityId: ENTITY });
    expect(upsert.create).toMatchObject({
      entityId: ENTITY,
      ownerId: OWNER,
      summary: 'Acme chose blue',
      model: 'model-x',
      coversUntil: new Date('2026-09-10T00:00:00Z'),
      citations: { version: 1, statements: [{ text: 'Acme chose blue', evidenceIds: [EV] }], dropped: 1 },
    });
  });

  it.each(['graph_disabled', 'ai_not_configured', 'ai_key_missing', 'model_lacks_capability'])(
    'returns normally without a provider call on a resolver 409 (%s)',
    async (reason) => {
      const resolve = jest.fn().mockRejectedValue(new ConflictException({ message: 'no', details: { reason } }));
      const { handler, prisma } = setup({ resolve });
      await expect(handler.process(makeJob())).resolves.toBeUndefined();
      expect(prisma.kgEntityDigest.upsert).not.toHaveBeenCalled();
      expect(q.digestItems).not.toHaveBeenCalled();
    },
  );

  it('rethrows a RateLimitError so the queue defers it', async () => {
    const generateStructured = jest.fn().mockRejectedValue(new RateLimitError('slow down'));
    const { handler, prisma } = setup({ generateStructured });
    await expect(handler.process(makeJob())).rejects.toBeInstanceOf(RateLimitError);
    expect(prisma.kgEntityDigest.upsert).not.toHaveBeenCalled();
  });

  it('fails the job and keeps the previous digest when every statement is uncited', async () => {
    const generateStructured = jest.fn().mockResolvedValue({
      value: { statements: [{ text: 'x', factRefs: [] }, { text: 'y', factRefs: ['F42'] }] },
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });
    const { handler, prisma } = setup({ generateStructured });
    await expect(handler.process(makeJob())).rejects.toBeInstanceOf(DigestCitationError);
    expect(prisma.kgEntityDigest.upsert).not.toHaveBeenCalled();
    expect(prisma.kgEntityDigest.update).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['merged', { id: ENTITY, type: 'Person', label: 'x', reviewStatus: 'merged', mergedIntoId: U(9) }],
    ['unreviewed', { id: ENTITY, type: 'Person', label: 'x', reviewStatus: 'unreviewed', mergedIntoId: null }],
  ])('returns normally and writes nothing for a %s entity', async (_name, entity) => {
    const { handler, prisma, resolver } = setup({ entity });
    await handler.process(makeJob());
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(prisma.kgEntityDigest.upsert).not.toHaveBeenCalled();
  });

  it('ignores an unreadable payload', async () => {
    const { handler, prisma } = setup();
    await handler.process(makeJob({ entityId: 'nope' }));
    expect(prisma.kgEntity.findFirst).not.toHaveBeenCalled();
  });

  it('moves the markers without a provider call when nothing is new', async () => {
    q.digestItems.mockResolvedValue([]);
    const previous = {
      entityId: ENTITY,
      coversUntil: new Date('2026-09-01T00:00:00Z'),
      generatedAt: new Date('2026-09-02T00:00:00Z'),
      citations: { version: 1, statements: [] },
    };
    const { handler, prisma, generateStructured } = setup({ previous });
    await handler.process(makeJob());
    expect(generateStructured).not.toHaveBeenCalled();
    expect(prisma.kgEntityDigest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityId: ENTITY }, data: expect.objectContaining({ coversUntil: new Date('2026-09-10T00:00:00Z') }) }),
    );
  });

  it('asks the queries for prompt-safe rows only (no personal facts without the opt-in)', async () => {
    const { handler } = setup();
    await handler.process(makeJob());
    // includePersonalFacts is the last argument of both reads.
    expect(q.digestItems.mock.calls[0][5]).toBe(false);
    expect(q.newestChange.mock.calls[0][5]).toBe(false);
  });
});
