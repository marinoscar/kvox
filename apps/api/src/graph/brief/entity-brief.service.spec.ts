import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import * as queries from './brief-queries';
import { DIGEST_FAILURE_BACKOFF_MS, EntityBriefService, type EntityBriefOptions } from './entity-brief.service';

jest.mock('./brief-queries', () => ({
  ...jest.requireActual('./brief-queries'),
  briefItems: jest.fn(),
  entityRefs: jest.fn(),
  evidenceIdsFor: jest.fn(),
  graphDocCandidates: jest.fn(),
  newestChange: jest.fn(),
  oneHopPersonIds: jest.fn(),
  ownedEvidenceIds: jest.fn(),
  peopleChangeRelations: jest.fn(),
  visibleDocs: jest.fn(),
  workerIds: jest.fn(),
}));

const q = queries as jest.Mocked<typeof queries>;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = U(1);
const ENTITY = U(2);
const EV = U(3);
const DOC = U(4);
const USER = { id: OWNER, permissions: ['graph:read', 'transcripts:read', 'notes:read'] } as never;

/** A provider whose every property access throws — the brief must never touch it. */
const explodingProvider = new Proxy(
  {},
  {
    get() {
      throw new Error('the brief called an AI provider');
    },
  },
);

interface Setup {
  digest?: unknown;
  lastViewedAt?: Date | null;
  activeJob?: boolean;
  latestJob?: unknown;
  resolve?: jest.Mock;
  search?: jest.Mock;
  entity?: unknown;
}

function setup(over: Setup = {}) {
  const tx = { $executeRawUnsafe: jest.fn() };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    kgEntityDigest: { findFirst: jest.fn().mockResolvedValue(over.digest ?? null) },
    job: {
      findFirst: jest.fn(async (args: { where: { status?: unknown } }) =>
        args.where.status ? (over.activeJob ? { id: 'job-active' } : null) : (over.latestJob ?? null),
      ),
    },
  };
  const access = {
    require: jest.fn().mockResolvedValue(
      over.entity ?? { id: ENTITY, type: 'Organization', label: 'Acme', mergedIntoId: null },
    ),
  };
  const ontology = {
    effectiveSchemaFor: jest.fn().mockResolvedValue({ relationTypes: [{ key: 'HAS_ROLE', exclusive: 'soft' }] }),
  };
  const views = {
    lastViewedAt: jest.fn().mockResolvedValue(over.lastViewedAt ?? null),
    markViewed: jest.fn().mockResolvedValue(undefined),
  };
  const search = {
    search:
      over.search ??
      jest.fn().mockResolvedValue({
        results: [{ type: 'transcript', id: DOC, title: 'Call', score: 0.03, snippets: [{ html: '<mark>Acme</mark>', startMs: 10, field: 'segment' }] }],
      }),
  };
  const resolver = {
    resolve: over.resolve ?? jest.fn().mockResolvedValue({ provider: explodingProvider, model: 'model-x' }),
  };
  const enqueuer = { enqueue: jest.fn().mockResolvedValue({ id: 'job-new', status: 'pending' }) };
  const service = new EntityBriefService(
    prisma as never,
    access as never,
    ontology as never,
    views as never,
    search as never,
    resolver as never,
    enqueuer as never,
  );
  return { service, prisma, access, views, search, resolver, enqueuer };
}

const opts = (over: Partial<EntityBriefOptions> = {}): EntityBriefOptions => ({
  markViewed: true,
  enqueueStaleDigest: true,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  q.workerIds.mockResolvedValue(new Set());
  q.oneHopPersonIds.mockResolvedValue([]);
  q.briefItems.mockResolvedValue([]);
  q.peopleChangeRelations.mockResolvedValue([]);
  q.evidenceIdsFor.mockResolvedValue(new Map());
  q.entityRefs.mockResolvedValue(new Map());
  q.graphDocCandidates.mockResolvedValue([]);
  q.visibleDocs.mockResolvedValue([{ kind: 'transcript', id: DOC, title: 'Call', occurredAt: new Date() }]);
  q.ownedEvidenceIds.mockResolvedValue(new Set([EV]));
  // Something changed recently and there is no digest → stale.
  q.newestChange.mockResolvedValue({ at: new Date('2026-09-10T00:00:00Z'), writtenAt: new Date('2026-09-10T00:00:00Z') });
});

const DIGEST = {
  entityId: ENTITY,
  ownerId: OWNER,
  summary: 'Acme chose blue',
  citations: { version: 1, statements: [{ text: 'Acme chose blue', evidenceIds: [EV, U(99)] }], dropped: 0 },
  coversUntil: new Date('2026-09-01T00:00:00Z'),
  generatedAt: new Date('2026-09-02T00:00:00Z'),
  model: 'model-x',
};

describe('EntityBriefService.getBrief — digest staleness and the enqueue gate', () => {
  it('stale + usable model → exactly one enqueue and digestPending, never a provider call', async () => {
    const { service, enqueuer, resolver } = setup();
    const res = await service.getBrief(USER, ENTITY, opts());
    expect(resolver.resolve).toHaveBeenCalledWith(OWNER, 'graph.digest');
    expect(enqueuer.enqueue).toHaveBeenCalledTimes(1);
    expect(enqueuer.enqueue).toHaveBeenCalledWith(OWNER, ENTITY);
    expect(res).toMatchObject({ digest: null, digestStale: true, digestPending: true, digestUnavailable: null });
  });

  it('an up-to-date digest is shown, not stale, and nothing is resolved or enqueued', async () => {
    q.newestChange.mockResolvedValue({ at: new Date('2026-08-01T00:00:00Z'), writtenAt: new Date('2026-08-01T00:00:00Z') });
    const { service, enqueuer, resolver } = setup({ digest: DIGEST });
    const res = await service.getBrief(USER, ENTITY, opts());
    expect(res.digestStale).toBe(false);
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    // Only evidence the caller still owns survives.
    expect(res.digest).toEqual({
      statements: [{ text: 'Acme chose blue', evidenceIds: [EV] }],
      coversUntil: DIGEST.coversUntil.toISOString(),
      generatedAt: DIGEST.generatedAt.toISOString(),
      model: 'model-x',
    });
  });

  it('a digest older than a back-dated write is stale', async () => {
    q.newestChange.mockResolvedValue({ at: new Date('2026-08-01T00:00:00Z'), writtenAt: new Date('2026-09-05T00:00:00Z') });
    const { service } = setup({ digest: DIGEST });
    expect((await service.getBrief(USER, ENTITY, opts())).digestStale).toBe(true);
  });

  it('nothing to summarize and no digest → not stale', async () => {
    q.newestChange.mockResolvedValue({ at: null, writtenAt: null });
    const { service, resolver } = setup();
    expect((await service.getBrief(USER, ENTITY, opts())).digestStale).toBe(false);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('with as_of: no digest, not stale, not pending, nothing enqueued, view untouched', async () => {
    const { service, enqueuer, resolver, views } = setup({ digest: DIGEST });
    const res = await service.getBrief(USER, ENTITY, opts({ asOf: '2024-01-15' }));
    expect(res).toMatchObject({ digest: null, digestStale: false, digestPending: false, digestUnavailable: null });
    expect(res.window.asOf).toBe('2024-01-15T00:00:00.000Z');
    expect(q.newestChange).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    expect(views.markViewed).not.toHaveBeenCalled();
  });

  it('enqueueStaleDigest: false (the Ask tool) reports staleness but never resolves or enqueues', async () => {
    const { service, enqueuer, resolver } = setup();
    const res = await service.getBrief(USER, ENTITY, opts({ enqueueStaleDigest: false, markViewed: false }));
    expect(res).toMatchObject({ digestStale: true, digestPending: false });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });

  it.each(['graph_disabled', 'ai_not_configured', 'ai_key_missing', 'model_lacks_capability'] as const)(
    'a resolver 409 (%s) is reported and nothing is enqueued',
    async (reason) => {
      const resolve = jest.fn().mockRejectedValue(new ConflictException({ message: 'no', details: { reason } }));
      const { service, enqueuer } = setup({ resolve });
      const res = await service.getBrief(USER, ENTITY, opts());
      expect(res).toMatchObject({ digestStale: true, digestPending: false, digestUnavailable: reason });
      expect(enqueuer.enqueue).not.toHaveBeenCalled();
    },
  );

  it('an unexpected resolver failure never breaks the brief', async () => {
    const { service, enqueuer } = setup({ resolve: jest.fn().mockRejectedValue(new BadRequestException('x')) });
    const res = await service.getBrief(USER, ENTITY, opts());
    expect(res).toMatchObject({ digestPending: false, digestUnavailable: null });
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });

  it('a pending job → digestPending without resolving or enqueueing again', async () => {
    const { service, enqueuer, resolver } = setup({ activeJob: true });
    const res = await service.getBrief(USER, ENTITY, opts());
    expect(res.digestPending).toBe(true);
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });

  it('a failure less than 15 minutes ago → no job; an older one → a job', async () => {
    const recent = setup({ latestJob: { status: 'failed', finishedAt: new Date(Date.now() - 60_000), createdAt: new Date() } });
    expect((await recent.service.getBrief(USER, ENTITY, opts())).digestPending).toBe(false);
    expect(recent.enqueuer.enqueue).not.toHaveBeenCalled();

    const old = setup({
      latestJob: { status: 'failed', finishedAt: new Date(Date.now() - DIGEST_FAILURE_BACKOFF_MS - 60_000), createdAt: new Date(0) },
    });
    expect((await old.service.getBrief(USER, ENTITY, opts())).digestPending).toBe(true);
    expect(old.enqueuer.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('EntityBriefService.getBrief — window and views', () => {
  it('since: query, then last view, then digest covers_until, then 30 days', async () => {
    const lastViewedAt = new Date('2026-09-05T00:00:00Z');
    const a = await setup({ lastViewedAt, digest: DIGEST }).service.getBrief(USER, ENTITY, opts({ since: '2026-01-01' }));
    expect(a.window).toMatchObject({ since: '2026-01-01T00:00:00.000Z', sinceSource: 'query' });
    const b = await setup({ lastViewedAt, digest: DIGEST }).service.getBrief(USER, ENTITY, opts());
    expect(b.window).toMatchObject({ since: lastViewedAt.toISOString(), sinceSource: 'last_viewed', lastViewedAt: lastViewedAt.toISOString() });
    const c = await setup({ digest: DIGEST }).service.getBrief(USER, ENTITY, opts());
    expect(c.window).toMatchObject({ since: DIGEST.coversUntil.toISOString(), sinceSource: 'digest' });
    const d = await setup().service.getBrief(USER, ENTITY, opts({ asOf: '2024-01-31' }));
    expect(d.window).toMatchObject({ since: '2024-01-01T00:00:00.000Z', sinceSource: 'default' });
  });

  it('records the view after assembling, and not with markViewed=false', async () => {
    const s = setup();
    await s.service.getBrief(USER, ENTITY, opts());
    expect(s.views.markViewed).toHaveBeenCalledWith(OWNER, ENTITY, expect.any(Date));
    expect(s.views.lastViewedAt.mock.invocationCallOrder[0]).toBeLessThan(s.views.markViewed.mock.invocationCallOrder[0]);
    const t = setup();
    await t.service.getBrief(USER, ENTITY, opts({ markViewed: false }));
    expect(t.views.markViewed).not.toHaveBeenCalled();
  });

  it('400 for an impossible date, 404 for a merged entity', async () => {
    await expect(setup().service.getBrief(USER, ENTITY, opts({ asOf: '2024-02-30' }))).rejects.toBeInstanceOf(BadRequestException);
    const merged = setup({ entity: { id: ENTITY, type: 'Person', label: 'x', mergedIntoId: U(9) } });
    await expect(merged.service.getBrief(USER, ENTITY, opts())).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EntityBriefService.getBrief — related sources', () => {
  it('includes a text-arm-only hit with inGraph: false (never graph-only)', async () => {
    const { service, search } = setup();
    const res = await service.getBrief(USER, ENTITY, opts());
    expect(search.search).toHaveBeenCalledWith({ q: 'Acme', types: 'transcript,note', limit: 20 }, USER);
    expect(res.related).toEqual([
      expect.objectContaining({ kind: 'transcript', id: DOC, inGraph: false, snippetHtml: '<mark>Acme</mark>', startMs: 10 }),
    ]);
  });

  it('a search refusal degrades to the graph arm and the brief still renders', async () => {
    q.graphDocCandidates.mockResolvedValue([{ kind: 'transcript', id: DOC, confidence: 0.8 }]);
    const { service } = setup({ search: jest.fn().mockRejectedValue(new ForbiddenException()) });
    const res = await service.getBrief(USER, ENTITY, opts());
    expect(res.related).toEqual([expect.objectContaining({ id: DOC, inGraph: true, snippetHtml: null })]);
  });
});
