import { ConflictException } from '@nestjs/common';

import type { KvoxAiCapabilities } from '../../ports/index.js';

import { SearchIndexStatusService } from './search-index-status.service.js';
import { SEARCH_INDEX_REQUEST_CAP } from './dto/search-index-status.dto.js';
import {
  SEARCH_DOC_NOTE,
  SEARCH_DOC_TRANSCRIPT,
  SEARCH_REASON_EMBEDDING_UNSUPPORTED,
  SEARCH_REASON_KEY_INVALID,
  SEARCH_REASON_KEY_MISSING,
  SEARCH_REASON_NOT_CONFIGURED,
} from './job-types.js';

// =============================================================================
// SearchIndexStatusService (issue #191, epic #165)
// =============================================================================
//
// The claims worth pinning are the ones a later change could quietly break
// without anything else noticing:
//
//   1. OWNER SCOPING. Another user's documents and another user's index rows
//      are never counted and never queued. This is a BILLING boundary, not a
//      tidiness one — indexing spends the document owner's own vendor account.
//   2. A DOCUMENT WITH NO STATE ROW IS `unindexed`. The four database states
//      all require a row; the state that matters most has none, and reporting
//      only the four would render a wholly unsearchable library as three
//      reassuring zeroes.
//   3. THE CAP IS REAL. A bounded number of jobs per press, with the shortfall
//      reported rather than dropped.
//   4. THE 409s HAPPEN BEFORE ANY JOB IS QUEUED. Work that is certain to skip
//      is refused with a reason, not queued and silently wasted.
//
// The Prisma double below answers the library statements by the BOUND owner id
// rather than returning a canned list (and asserts the statement itself filters
// live rows), so claim 1 is tested against the service's own query shape
// instead of against a mock that would answer identically either way.
// =============================================================================

interface FakeDocument {
  id: string;
  ownerId: string;
  title: string;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface FakeState {
  ownerId: string;
  documentType: string;
  documentId: string;
  status: string;
  reason: string | null;
  lastError: string | null;
  model: string | null;
  indexedAt: Date | null;
  updatedAt: Date;
}

const MODEL = 'text-embedding-3-small';

function at(iso: string): Date {
  return new Date(iso);
}

function doc(overrides: Partial<FakeDocument> & { id: string }): FakeDocument {
  return {
    ownerId: 'user-1',
    title: `Document ${overrides.id}`,
    updatedAt: at('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function state(overrides: Partial<FakeState> & { documentId: string; status: string }): FakeState {
  return {
    ownerId: 'user-1',
    documentType: SEARCH_DOC_TRANSCRIPT,
    reason: null,
    lastError: null,
    model: MODEL,
    indexedAt: at('2026-01-02T00:00:00.000Z'),
    updatedAt: at('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function buildPrisma(data: { transcripts?: FakeDocument[]; notes?: FakeDocument[]; states?: FakeState[] }) {
  const transcripts = data.transcripts ?? [];
  const notes = data.notes ?? [];
  const states = data.states ?? [];

  // The library listing is raw SQL (the transcripts and notes tables belong to
  // other slices). Answered by the OWNER ID the statement binds; soft-deleted rows
  // are what a `deleted_at IS NULL` statement would not return, so the double
  // refuses a statement that forgot the predicate.
  const queryRaw = jest.fn(async (sql: { sql: string; values: unknown[] }) => {
    if (!sql.sql.includes('deleted_at IS NULL')) throw new Error('library statement forgot deleted_at IS NULL');
    if (!sql.sql.includes('owner_id = ?::uuid')) throw new Error('library statement is not owner-scoped');

    const owner = sql.values[0];
    const rows = sql.sql.includes('FROM transcripts') ? transcripts : notes;

    return rows
      .filter((row) => row.ownerId === owner && row.deletedAt === null)
      .map((row) => ({ id: row.id, title: row.title, updated_at: row.updatedAt }));
  });

  return {
    $queryRaw: queryRaw,
    searchIndexState: {
      findMany: jest.fn(
        async ({ where }: { where: { ownerId: string; documentType: string } }) =>
          states.filter(
            (row) => row.ownerId === where.ownerId && row.documentType === where.documentType,
          ),
      ),
    },
  };
}

/** What the scripted AI port answers. */
type Scenario = 'ready' | 'ai_key_missing' | 'ai_not_configured' | 'no_embeddings';

function capabilitiesFor(scenario: Scenario): KvoxAiCapabilities {
  const base: KvoxAiCapabilities = {
    available: true,
    structuredOutput: true,
    toolCalling: true,
    embeddings: { model: MODEL, dimensions: 1536 },
    graphEnabled: true,
  };

  switch (scenario) {
    case 'ai_key_missing':
      return { ...base, available: false, reason: 'ai_key_missing' };
    case 'ai_not_configured':
      return { ...base, available: false, reason: 'ai_not_configured' };
    case 'no_embeddings':
      return { ...base, embeddings: null };
    default:
      return base;
  }
}

function buildService(options: {
  prisma: ReturnType<typeof buildPrisma>;
  /** What `KVOX_AI.capabilities` answers; omit for a ready caller. */
  scenario?: Scenario;
}) {
  const { prisma, scenario = 'ready' } = options;

  const capabilities = jest.fn(async () => capabilitiesFor(scenario));
  const ai = { capabilities };

  // Typed with its real positional signature so `mock.calls[n][1]` is a string
  // rather than `never` — the assertions below read the queued document ids.
  const index = {
    enqueue: jest.fn(async (_type: string, _id: string, _reason: string) => undefined),
  };

  const service = new SearchIndexStatusService(prisma as never, ai as never, index as never);

  return { service, index, capabilities };
}

describe('SearchIndexStatusService', () => {
  describe('status()', () => {
    it('counts only the CALLER\'S OWN documents — a share is not a bill', async () => {
      const prisma = buildPrisma({
        transcripts: [
          doc({ id: 't-1' }),
          doc({ id: 't-2' }),
          // Somebody else's recording, which this caller may well be able to
          // read through a share. It is indexed on THEIR account, not here.
          doc({ id: 't-other', ownerId: 'user-2' }),
        ],
        states: [
          state({ documentId: 't-1', status: 'indexed' }),
          state({ documentId: 't-other', status: 'indexed', ownerId: 'user-2' }),
        ],
      });

      const { service } = buildService({ prisma });

      const result = await service.status('user-1');
      const transcripts = result.types.find((entry) => entry.type === SEARCH_DOC_TRANSCRIPT);

      expect(transcripts).toMatchObject({ total: 2, indexed: 1, unindexed: 1 });
      // The listing statement bound the CALLER's id and nobody else's.
      expect(prisma.$queryRaw.mock.calls.every(([sql]) => sql.values[0] === 'user-1')).toBe(true);
      expect(prisma.searchIndexState.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerId: 'user-1', documentType: SEARCH_DOC_TRANSCRIPT },
        }),
      );
    });

    it('counts a document with NO index row as `unindexed`, not as zero of everything', async () => {
      const prisma = buildPrisma({
        transcripts: [doc({ id: 't-1' }), doc({ id: 't-2' }), doc({ id: 't-3' })],
        states: [],
      });

      const { service } = buildService({ prisma });

      const result = await service.status('user-1');

      expect(result.types.find((entry) => entry.type === SEARCH_DOC_TRANSCRIPT)).toEqual({
        type: SEARCH_DOC_TRANSCRIPT,
        indexed: 0,
        pending: 0,
        failed: 0,
        skipped: 0,
        unindexed: 3,
        total: 3,
      });
    });

    it('reports `indexing` and `pending` as one number — both mean "not done yet"', async () => {
      const prisma = buildPrisma({
        transcripts: [doc({ id: 't-1' }), doc({ id: 't-2' })],
        states: [
          state({ documentId: 't-1', status: 'pending' }),
          state({ documentId: 't-2', status: 'indexing' }),
        ],
      });

      const { service } = buildService({ prisma });

      const result = await service.status('user-1');

      expect(result.types.find((entry) => entry.type === SEARCH_DOC_TRANSCRIPT)).toMatchObject({
        pending: 2,
        unindexed: 0,
      });
    });

    it('ignores an index row whose document is gone, rather than counting it', async () => {
      // The window between a soft delete and its purge — the case a
      // `groupBy`-based count could not express, because `search_index_state`
      // has no foreign key to filter through.
      const prisma = buildPrisma({
        transcripts: [doc({ id: 't-1' }), doc({ id: 't-gone', deletedAt: at('2026-02-01T00:00:00.000Z') })],
        states: [
          state({ documentId: 't-1', status: 'indexed' }),
          state({ documentId: 't-gone', status: 'indexed' }),
        ],
      });

      const { service } = buildService({ prisma });

      const result = await service.status('user-1');

      expect(result.types.find((entry) => entry.type === SEARCH_DOC_TRANSCRIPT)).toMatchObject({
        total: 1,
        indexed: 1,
        unindexed: 0,
      });
    });

    it('lists per-document failures newest first, and elides account-wide skips', async () => {
      const prisma = buildPrisma({
        transcripts: [
          doc({ id: 't-failed' }),
          doc({ id: 't-invalid-key' }),
          doc({ id: 't-no-key' }),
        ],
        notes: [doc({ id: 'n-failed' })],
        states: [
          state({
            documentId: 't-failed',
            status: 'failed',
            reason: 'dimension_mismatch',
            lastError: 'expected 1536',
            updatedAt: at('2026-03-01T00:00:00.000Z'),
          }),
          state({
            documentId: 't-invalid-key',
            status: 'skipped',
            reason: SEARCH_REASON_KEY_INVALID,
            updatedAt: at('2026-03-02T00:00:00.000Z'),
          }),
          // Account-wide: already said once by `reason`, never repeated per row.
          state({
            documentId: 't-no-key',
            status: 'skipped',
            reason: SEARCH_REASON_KEY_MISSING,
            updatedAt: at('2026-03-03T00:00:00.000Z'),
          }),
          state({
            documentId: 'n-failed',
            documentType: SEARCH_DOC_NOTE,
            status: 'failed',
            reason: null,
            lastError: 'provider exploded',
            updatedAt: at('2026-03-04T00:00:00.000Z'),
          }),
        ],
      });

      const { service } = buildService({ prisma });

      const result = await service.status('user-1');

      expect(result.failures.map((failure) => failure.id)).toEqual([
        'n-failed',
        't-invalid-key',
        't-failed',
      ]);
      expect(result.failures[0]).toEqual({
        type: SEARCH_DOC_NOTE,
        id: 'n-failed',
        title: 'Document n-failed',
        reason: null,
        lastError: 'provider exploded',
      });
    });

    it('reports the embedding model, the key and the availability separately', async () => {
      const prisma = buildPrisma({ transcripts: [doc({ id: 't-1' })] });
      const { service } = buildService({ prisma });

      await expect(service.status('user-1')).resolves.toMatchObject({
        model: MODEL,
        hasKey: true,
        available: true,
        reason: null,
      });
    });

    it('says `ai_key_missing` when the deployment is ready and the CALLER is not', async () => {
      const prisma = buildPrisma({ transcripts: [doc({ id: 't-1' })] });
      const { service } = buildService({ prisma, scenario: 'ai_key_missing' });

      await expect(service.status('user-1')).resolves.toMatchObject({
        available: true,
        hasKey: false,
        reason: SEARCH_REASON_KEY_MISSING,
      });
    });

    it('says `ai_not_configured` when AI is switched off', async () => {
      const prisma = buildPrisma({ transcripts: [doc({ id: 't-1' })] });
      const { service } = buildService({ prisma, scenario: 'ai_not_configured' });

      // `hasKey` is false here because the AI port does not say whether the
      // caller has a key once the deployment cannot embed at all (it used to
      // answer from the web edition's own readiness call). The reason is what the
      // page shows, and it names the administrator, not the caller.
      await expect(service.status('user-1')).resolves.toMatchObject({
        available: false,
        hasKey: false,
        model: null,
        reason: SEARCH_REASON_NOT_CONFIGURED,
      });
    });

    it('says `embedding_unsupported` when the host has no embeddings model', async () => {
      const prisma = buildPrisma({ transcripts: [doc({ id: 't-1' })] });
      const { service } = buildService({ prisma, scenario: 'no_embeddings' });

      await expect(service.status('user-1')).resolves.toMatchObject({
        available: false,
        reason: SEARCH_REASON_EMBEDDING_UNSUPPORTED,
      });
    });

    it('asks the AI port about the CALLER, under the search.embed feature', async () => {
      const prisma = buildPrisma({ transcripts: [doc({ id: 't-1' })] });
      const { service, capabilities } = buildService({ prisma });

      await service.status('user-7');

      expect(capabilities).toHaveBeenCalledWith({
        userId: 'user-7',
        orgId: null,
        feature: 'search.embed',
      });
    });

    it('never throws for a deployment that has chosen no provider at all', async () => {
      const prisma = buildPrisma({ transcripts: [doc({ id: 't-1' })] });
      const { service } = buildService({ prisma, scenario: 'ai_not_configured' });

      await expect(service.status('user-1')).resolves.toMatchObject({
        available: false,
        hasKey: false,
        reason: SEARCH_REASON_NOT_CONFIGURED,
      });
    });
  });

  describe('requestIndex()', () => {
    it('queues the documents that need it, and nothing that is already queued', async () => {
      const prisma = buildPrisma({
        transcripts: [
          doc({ id: 't-none' }),
          doc({ id: 't-failed' }),
          doc({ id: 't-skipped' }),
          doc({ id: 't-pending' }),
          doc({ id: 't-indexed' }),
          doc({ id: 't-stale-model' }),
          doc({ id: 't-edited', updatedAt: at('2026-05-01T00:00:00.000Z') }),
        ],
        states: [
          state({ documentId: 't-failed', status: 'failed' }),
          state({ documentId: 't-skipped', status: 'skipped', reason: SEARCH_REASON_KEY_MISSING }),
          state({ documentId: 't-pending', status: 'pending' }),
          state({ documentId: 't-indexed', status: 'indexed' }),
          state({ documentId: 't-stale-model', status: 'indexed', model: 'text-embedding-ada-002' }),
          state({
            documentId: 't-edited',
            status: 'indexed',
            indexedAt: at('2026-04-01T00:00:00.000Z'),
          }),
        ],
      });

      const { service, index } = buildService({ prisma });

      const result = await service.requestIndex('user-1');

      expect(result).toEqual({
        queued: 5,
        remaining: 0,
        cap: SEARCH_INDEX_REQUEST_CAP,
      });

      const queued = index.enqueue.mock.calls.map((call) => call[1]);
      expect(queued.sort()).toEqual(
        ['t-edited', 't-failed', 't-none', 't-skipped', 't-stale-model'].sort(),
      );
      expect(queued).not.toContain('t-pending');
      expect(queued).not.toContain('t-indexed');
      expect(index.enqueue).toHaveBeenCalledWith(SEARCH_DOC_TRANSCRIPT, 't-none', 'backfill');
    });

    it('never queues another user\'s documents', async () => {
      const prisma = buildPrisma({
        transcripts: [doc({ id: 't-mine' }), doc({ id: 't-theirs', ownerId: 'user-2' })],
      });

      const { service, index } = buildService({ prisma });

      await expect(service.requestIndex('user-1')).resolves.toMatchObject({ queued: 1 });
      expect(index.enqueue).toHaveBeenCalledTimes(1);
      expect(index.enqueue).toHaveBeenCalledWith(SEARCH_DOC_TRANSCRIPT, 't-mine', 'backfill');
    });

    it(`queues at most ${SEARCH_INDEX_REQUEST_CAP} per call and reports the shortfall`, async () => {
      const overflow = SEARCH_INDEX_REQUEST_CAP + 50;
      const prisma = buildPrisma({
        transcripts: Array.from({ length: overflow }, (_value, position) =>
          doc({
            id: `t-${position}`,
            // Ascending, so "newest first" has something to actually order by.
            updatedAt: new Date(Date.UTC(2026, 0, 1) + position * 1000),
          }),
        ),
      });

      const { service, index } = buildService({ prisma });

      const result = await service.requestIndex('user-1');

      expect(result).toEqual({
        queued: SEARCH_INDEX_REQUEST_CAP,
        remaining: 50,
        cap: SEARCH_INDEX_REQUEST_CAP,
      });
      expect(index.enqueue).toHaveBeenCalledTimes(SEARCH_INDEX_REQUEST_CAP);
      // Newest first: the most recently touched document is queued, the oldest
      // is what got left for the next press.
      expect(index.enqueue).toHaveBeenCalledWith(
        SEARCH_DOC_TRANSCRIPT,
        `t-${overflow - 1}`,
        'backfill',
      );
      expect(index.enqueue).not.toHaveBeenCalledWith(SEARCH_DOC_TRANSCRIPT, 't-0', 'backfill');
    });

    it('refuses with `ai_key_missing` — and queues NOTHING — when the caller has no key', async () => {
      const prisma = buildPrisma({ transcripts: [doc({ id: 't-1' })] });
      const { service, index } = buildService({ prisma, scenario: 'ai_key_missing' });

      await expect(service.requestIndex('user-1')).rejects.toBeInstanceOf(ConflictException);
      expect(index.enqueue).not.toHaveBeenCalled();

      await service.requestIndex('user-1').catch((error: ConflictException) => {
        expect(error.getResponse()).toMatchObject({
          details: { reason: SEARCH_REASON_KEY_MISSING },
        });
      });
    });

    it('refuses with `ai_not_configured` when the deployment cannot embed at all', async () => {
      const prisma = buildPrisma({ transcripts: [doc({ id: 't-1' })] });
      const { service, index } = buildService({ prisma, scenario: 'ai_not_configured' });

      await service.requestIndex('user-1').catch((error: ConflictException) => {
        expect(error.getResponse()).toMatchObject({
          details: { reason: SEARCH_REASON_NOT_CONFIGURED },
        });
      });
      expect(index.enqueue).not.toHaveBeenCalled();
    });

    it('refuses with `embedding_unsupported` when the host has no embeddings model', async () => {
      const prisma = buildPrisma({ transcripts: [doc({ id: 't-1' })] });
      const { service, index } = buildService({ prisma, scenario: 'no_embeddings' });

      await service.requestIndex('user-1').catch((error: ConflictException) => {
        expect(error.getResponse()).toMatchObject({
          details: { reason: SEARCH_REASON_EMBEDDING_UNSUPPORTED },
        });
      });
      expect(index.enqueue).not.toHaveBeenCalled();
    });
  });
});
