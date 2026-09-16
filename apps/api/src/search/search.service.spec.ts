// =============================================================================
// SearchService — the properties the endpoint's safety rests on
// (issue #175, epic #164)
// =============================================================================
//
// The behavioural end-to-end proof is `test/integration/search.db.spec.ts`,
// against a real Postgres: only a real database can say whether a term in a
// segment finds its transcript, whether `max` really outranks `sum`, or
// whether `ts_headline` escaped anything. What is asserted HERE is the set of
// properties visible in the SQL TEXT this service emits — the ones a real-
// database test would pass while the statement was quietly doing something
// dangerous:
//
//   - every raw statement is a `SELECT`, takes no lock and writes nothing
//     (the assertion `job-insights.service.spec.ts` carries, for the same
//     reason and in the same shape);
//   - `q` and the caller's id reach the database as BOUND PARAMETERS, never
//     as text spliced into the statement;
//   - the visibility predicate is INSIDE the candidate query's `LIMIT`, which
//     is the one thing here that is catastrophic to get wrong and produces no
//     error when it is;
//   - the roll-up is `max`, and the ranking function is `ts_rank_cd`.
// =============================================================================

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';
import type { PrismaService } from '../prisma/prisma.service';
import { MAX_CANDIDATE_DOCUMENTS, type SearchQueryDto } from './dto/search.dto';
import { encodeSearchCursor } from './search-cursor';
import { SNIPPET_START, SNIPPET_STOP } from './search-snippet';
import { SearchService } from './search.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function user(permissions: string[] = [PERMISSIONS.TRANSCRIPTS_READ, PERMISSIONS.NOTES_READ]) {
  return {
    id: USER_ID,
    email: 'searcher@example.test',
    roles: ['Viewer'],
    permissions,
    isActive: true,
  } satisfies RequestUser;
}

function query(overrides: Partial<SearchQueryDto> = {}): SearchQueryDto {
  return { q: 'pricing model', limit: 20, ...overrides };
}

interface RawCandidate {
  type: 'transcript' | 'note';
  id: string;
  title: string;
  status: string;
  updated_at: Date;
  score: number;
}

function candidate(index: number, overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    type: 'transcript',
    id: `doc-${index}`,
    title: `Document ${index}`,
    status: 'ready',
    updated_at: new Date('2026-09-15T12:00:00.000Z'),
    score: 1 / (index + 1),
    ...overrides,
  };
}

function makeHarness(
  options: {
    nodes?: number;
    candidates?: RawCandidate[];
    snippets?: Array<{
      type: 'transcript' | 'note';
      doc_id: string;
      field: 'title' | 'body' | 'segment';
      start_ms: number | null;
      raw: string;
    }>;
  } = {},
) {
  const rawCalls: Prisma.Sql[] = [];

  // Dispatched on the statement's TEXT rather than on a call counter, so a
  // test can drive the service twice (paging) and get the same answers both
  // times — a positional harness silently starves the second request.
  const queryRaw = jest.fn().mockImplementation(async (sql: Prisma.Sql) => {
    rawCalls.push(sql);

    if (sql.sql.includes('numnode(')) return [{ nodes: options.nodes ?? 3 }];
    if (sql.sql.includes('y.rn')) return options.snippets ?? [];

    return options.candidates ?? [];
  });

  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;

  return { service: new SearchService(prisma), queryRaw, rawCalls };
}

describe('SearchService', () => {
  // ==========================================================================
  // The property the endpoint's existence depends on
  // ==========================================================================

  describe('every statement is a read', () => {
    it('issues only SELECTs as raw SQL, and takes no lock of any kind', async () => {
      const { service, rawCalls } = makeHarness({
        candidates: [candidate(0), candidate(1, { type: 'note', id: 'note-1' })],
      });

      await service.search(query(), user());

      expect(rawCalls.length).toBeGreaterThan(0);

      for (const sql of rawCalls) {
        expect(sql.sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
        expect(sql.sql.toUpperCase()).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|FOR UPDATE|FOR SHARE|LOCK TABLE|PG_ADVISORY)\b/,
        );
      }
    });

    it('never reaches for a Prisma write client', async () => {
      const { service, queryRaw } = makeHarness();

      // The mock carries ONLY `$queryRaw`; anything else — `$executeRaw`, a
      // model delegate, a `$transaction` — would be `undefined` and throw.
      await expect(service.search(query(), user())).resolves.toBeDefined();
      expect(queryRaw).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // `q` is a string a stranger typed
  // ==========================================================================

  describe('parameter binding', () => {
    it('binds the query text rather than interpolating it', async () => {
      const hostile = "pricing'; DROP TABLE transcripts; --";
      const { service, rawCalls } = makeHarness({ candidates: [candidate(0)] });

      await service.search(query({ q: hostile }), user());

      for (const sql of rawCalls) {
        expect(sql.sql).not.toContain('DROP TABLE');
        expect(sql.sql).not.toContain(hostile);
      }

      // And it did reach the database — as a value.
      expect(rawCalls.flatMap((sql) => sql.values)).toContain(hostile);
    });

    it('binds the caller id rather than interpolating it', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [candidate(0)] });

      await service.search(query(), user());

      const [, candidates] = rawCalls;

      expect(candidates.sql).not.toContain(USER_ID);
      expect(candidates.values).toContain(USER_ID);
    });

    it('binds the ILIKE pattern with its wildcards already defused', async () => {
      const { service, rawCalls } = makeHarness({ nodes: 0, candidates: [] });

      await service.search(query({ q: '%' }), user());

      const [, candidates] = rawCalls;

      expect(candidates.sql).toContain('ILIKE');
      expect(candidates.values).toContain('%\\%%');
    });
  });

  // ==========================================================================
  // The security boundary
  // ==========================================================================

  describe('visibility', () => {
    it('applies the visibility predicate INSIDE the candidate query, before the LIMIT', async () => {
      // ⚠ THE ASSERTION THIS FILE EXISTS FOR. Filtering AFTER the top-K gives
      // a user who owns 1% of the corpus zero results from a query that
      // matched 200 documents, none of them theirs — with no error anywhere.
      const { service, rawCalls } = makeHarness({ candidates: [candidate(0)] });

      await service.search(query(), user());

      const text = rawCalls[1].sql;
      const limitAt = text.lastIndexOf('LIMIT');

      expect(limitAt).toBeGreaterThan(-1);
      expect(text.indexOf('transcript_shares')).toBeGreaterThan(-1);
      expect(text.indexOf('transcript_shares')).toBeLessThan(limitAt);
      expect(text.indexOf('deleted_at IS NULL')).toBeLessThan(limitAt);
      expect(text.indexOf('owner_id')).toBeLessThan(limitAt);
    });

    it('scopes transcripts to the owner OR a share', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [candidate(0)] });

      await service.search(query({ types: 'transcript' }), user());

      const text = rawCalls[1].sql.replace(/\s+/g, ' ');

      // `?` is Prisma's placeholder in `Prisma.Sql`; the driver renumbers it.
      expect(text).toMatch(/owner_id = \?::uuid OR EXISTS/);
      expect(text).toContain('FROM transcript_shares sh');
    });

    it('scopes notes to the owner and joins NO share table', async () => {
      // Notes are not shareable, there is no `notes:read_any`, and a share
      // join added here "for symmetry" would be this application's first path
      // to reading somebody else's note.
      const { service, rawCalls } = makeHarness({
        candidates: [candidate(0, { type: 'note', id: 'note-1' })],
      });

      await service.search(query({ types: 'note' }), user());

      const text = rawCalls[1].sql;

      expect(text).toContain('FROM notes n');
      expect(text).not.toContain('share');
      expect(text).not.toMatch(/notes:read_any/);
    });

    it('excludes soft-deleted rows on both the ranked and degraded paths', async () => {
      for (const nodes of [3, 0]) {
        const { service, rawCalls } = makeHarness({ nodes, candidates: [] });

        await service.search(query(), user());

        expect(rawCalls[1].sql).toContain('deleted_at IS NULL');
      }
    });
  });

  // ==========================================================================
  // The ranking decisions
  // ==========================================================================

  describe('ranking', () => {
    it('rolls a transcript up by max, never by sum', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [candidate(0)] });

      await service.search(query({ types: 'transcript' }), user());

      const text = rawCalls[1].sql;

      expect(text).toContain('max(u.score)');
      expect(text).not.toMatch(/\bsum\s*\(/i);
    });

    it('scores with ts_rank_cd, not ts_rank', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [candidate(0)] });

      await service.search(query(), user());

      const text = rawCalls[1].sql;

      expect(text).toContain('ts_rank_cd(');
      // `ts_rank(` with no `_cd` — cover density is the whole point (see the
      // service header), and a silent downgrade to frequency ranking would
      // still return plausible-looking results.
      expect(text).not.toMatch(/ts_rank\(/);
    });

    it('uses the two-argument to_tsquery form with an explicit configuration', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [candidate(0)] });

      await service.search(query(), user());

      for (const sql of rawCalls) {
        if (!sql.sql.includes('plainto_tsquery')) continue;

        expect(sql.sql).toContain("plainto_tsquery('english'::regconfig, ?)");
      }
    });
  });

  // ==========================================================================
  // The window, and the numbers published about it
  // ==========================================================================

  describe('the candidate window', () => {
    it('asks for one more than the cap so a full window is detectable', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [] });

      await service.search(query(), user());

      expect(rawCalls[1].values).toContain(MAX_CANDIDATE_DOCUMENTS + 1);
    });

    it('reports an exact count and truncated: false for a partial window', async () => {
      const candidates = Array.from({ length: 5 }, (_, i) => candidate(i));
      const { service } = makeHarness({ candidates });

      const result = await service.search(query(), user());

      expect(result.matchedDocuments).toBe(5);
      expect(result.truncated).toBe(false);
    });

    it('caps matchedDocuments at the window and sets truncated when it fills', async () => {
      const candidates = Array.from({ length: MAX_CANDIDATE_DOCUMENTS + 1 }, (_, i) =>
        candidate(i),
      );
      const { service } = makeHarness({ candidates });

      const result = await service.search(query(), user());

      expect(result.matchedDocuments).toBe(MAX_CANDIDATE_DOCUMENTS);
      expect(result.truncated).toBe(true);
    });

    it('stops handing out cursors at the end of the window', async () => {
      const candidates = Array.from({ length: 25 }, (_, i) => candidate(i));
      const { service } = makeHarness({ candidates });

      const first = await service.search(query({ limit: 20 }), user());
      expect(first.nextCursor).not.toBeNull();

      const second = await service.search(query({ limit: 20, cursor: first.nextCursor! }), user());
      expect(second.results).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
    });

    it('pages disjointly', async () => {
      const candidates = Array.from({ length: 6 }, (_, i) => candidate(i));
      const { service } = makeHarness({ candidates });

      const first = await service.search(query({ limit: 3 }), user());
      const second = await service.search(query({ limit: 3, cursor: first.nextCursor! }), user());

      expect(first.results.map((r) => r.id)).toEqual(['doc-0', 'doc-1', 'doc-2']);
      expect(second.results.map((r) => r.id)).toEqual(['doc-3', 'doc-4', 'doc-5']);
    });
  });

  // ==========================================================================
  // The cursor refuses
  // ==========================================================================

  describe('cursors', () => {
    it('refuses a cursor minted for a different query with a 400', async () => {
      const { service } = makeHarness({ candidates: [] });

      const stale = encodeSearchCursor(
        { q: 'annual budget', types: ['transcript', 'note'], userId: USER_ID },
        20,
      );

      await expect(service.search(query({ cursor: stale }), user())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a cursor minted by a different user with a 400', async () => {
      const { service } = makeHarness({ candidates: [] });

      const stale = encodeSearchCursor(
        {
          q: 'pricing model',
          types: ['transcript', 'note'],
          userId: '22222222-2222-4222-8222-222222222222',
        },
        20,
      );

      await expect(service.search(query({ cursor: stale }), user())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses an unreadable cursor rather than restarting at page 1', async () => {
      const { service } = makeHarness({ candidates: [] });

      await expect(service.search(query({ cursor: 'not-a-cursor' }), user())).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ==========================================================================
  // Per-type permission narrowing
  // ==========================================================================

  describe('permissions', () => {
    it('answers a caller holding one permission with the half they may have', async () => {
      const { service, rawCalls } = makeHarness({
        candidates: [candidate(0, { type: 'note', id: 'note-1' })],
      });

      const result = await service.search(query(), user([PERMISSIONS.NOTES_READ]));

      expect(result.searchedTypes).toEqual(['note']);
      expect(rawCalls[1].sql).toContain('FROM notes n');
      expect(rawCalls[1].sql).not.toContain('FROM transcripts tt');
    });

    it('does not 403 that caller', async () => {
      const { service } = makeHarness({ candidates: [] });

      await expect(
        service.search(query(), user([PERMISSIONS.TRANSCRIPTS_READ])),
      ).resolves.toMatchObject({ searchedTypes: ['transcript'] });
    });

    it('403s a caller holding neither read permission', async () => {
      const { service } = makeHarness();

      await expect(service.search(query(), user([]))).rejects.toThrow(ForbiddenException);
    });

    it('reports both types for a caller holding both', async () => {
      const { service } = makeHarness({ candidates: [] });

      const result = await service.search(query(), user());

      expect(result.searchedTypes).toEqual(['transcript', 'note']);
    });

    it('400s an unrecognised `types` value rather than widening the filter', async () => {
      const { service } = makeHarness();

      await expect(service.search(query({ types: 'speaker' }), user())).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ==========================================================================
  // Degradation
  // ==========================================================================

  describe('all-stopword queries', () => {
    it('falls back to the title match and says so', async () => {
      const { service, rawCalls } = makeHarness({
        nodes: 0,
        candidates: [candidate(0, { title: 'The and of' })],
      });

      const result = await service.search(query({ q: 'the and of' }), user());

      expect(result.degraded).toBe('stopwords');
      expect(rawCalls[1].sql).toContain('ILIKE');
      expect(rawCalls[1].sql).not.toContain('search_vector');
      expect(result.results).toHaveLength(1);
    });

    it('marks the literal match in the title, escaped', async () => {
      const { service } = makeHarness({
        nodes: 0,
        candidates: [candidate(0, { title: 'The <b>and</b> of' })],
      });

      const result = await service.search(query({ q: 'and' }), user());

      expect(result.results[0].snippets).toEqual([
        { html: 'The &lt;b&gt;<mark>and</mark>&lt;/b&gt; of', startMs: null, field: 'title' },
      ]);
    });

    it('issues no snippet query at all on the degraded path', async () => {
      const { service, rawCalls } = makeHarness({ nodes: 0, candidates: [candidate(0)] });

      await service.search(query({ q: 'the' }), user());

      // Probe + candidates, and nothing else: the titles are already in hand.
      expect(rawCalls).toHaveLength(2);
    });

    it('does not degrade a query with lexemes in it', async () => {
      const { service, rawCalls } = makeHarness({ nodes: 3, candidates: [] });

      const result = await service.search(query(), user());

      expect(result.degraded).toBeNull();
      expect(rawCalls[1].sql).toContain('search_vector');
    });
  });

  // ==========================================================================
  // Snippets
  // ==========================================================================

  describe('snippets', () => {
    it('escapes the corpus and marks only the hits', async () => {
      // The sentinels are what `ts_headline` was asked to emit; the angle
      // brackets are what the corpus contained.
      const { service } = makeHarness({
        candidates: [candidate(0)],
        snippets: [
          {
            type: 'transcript',
            doc_id: 'doc-0',
            field: 'segment',
            start_ms: 61_000,
            raw: `<script>alert(1)</script> the ${SNIPPET_START}pricing${SNIPPET_STOP} model`,
          },
        ],
      });

      const result = await service.search(query(), user());
      const [snippet] = result.results[0].snippets;

      expect(snippet.html).toContain('&lt;script&gt;');
      expect(snippet.html).not.toContain('<script>');
      expect(snippet.html).toContain('<mark>pricing</mark>');
      expect(snippet.startMs).toBe(61_000);
      expect(snippet.field).toBe('segment');
    });

    it('asks for snippets only for the page, not the whole window', async () => {
      const candidates = Array.from({ length: 50 }, (_, i) => candidate(i));
      const { service, rawCalls } = makeHarness({ candidates });

      await service.search(query({ limit: 5 }), user());

      const pageIds = rawCalls[2].values.find(
        (value): value is string[] => Array.isArray(value) && typeof value[0] === 'string',
      );

      expect(pageIds).toEqual(['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4']);
    });

    it('re-applies the visibility predicate in the snippet query', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [candidate(0)] });

      await service.search(query(), user());

      expect(rawCalls[2].sql).toContain('transcript_shares');
      expect(rawCalls[2].sql).toContain('deleted_at IS NULL');
    });

    it('returns an empty snippet list rather than omitting a result', async () => {
      const { service } = makeHarness({ candidates: [candidate(0)], snippets: [] });

      const result = await service.search(query(), user());

      expect(result.results).toHaveLength(1);
      expect(result.results[0].snippets).toEqual([]);
    });

    it('skips the snippet query entirely when the page is empty', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [] });

      await service.search(query(), user());

      expect(rawCalls).toHaveLength(2);
    });
  });
});
