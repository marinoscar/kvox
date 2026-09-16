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
//     error when it is - and since #189 that is TWO candidate queries, with the
//     vector one being where the rule is most tempting to break;
//   - the roll-up is `max`, and the ranking function is `ts_rank_cd`;
//   - the semantic arm DEGRADES rather than failing, in every way it can fail,
//     and says which way in `semanticReason`.
// =============================================================================

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { EMBEDDING_DIMENSIONS } from '../ai/providers/ai-provider.interface';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';
import type { PrismaService } from '../prisma/prisma.service';
import { MAX_CANDIDATE_DOCUMENTS, type SearchQueryDto } from './dto/search.dto';
import { encodeSearchCursor, RANKING_MODEL_VERSION } from './search-cursor';
import { RRF_K } from './search-fusion';
import type { SearchQueryEmbedder } from './search-query-embedder.service';
import type { SemanticQueryPlan, SemanticReason } from './search-semantic';
import { SNIPPET_START, SNIPPET_STOP } from './search-snippet';
import { SearchService } from './search.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

/** A plausible query vector: right width, every component finite. */
const QUERY_VECTOR = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i % 7) / 10);

const EMBEDDING_MODEL = 'text-embedding-3-small';

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

/**
 * A stub {@link SearchQueryEmbedder}.
 *
 * ⚠ THE REAL ONE NEVER THROWS - every failure is a reason string - so a stub
 * that could throw would be testing a contract the service does not have. Both
 * shapes below return, and `embedCalls` is what proves the service did not
 * spend a vendor call it had no business spending.
 */
function stubEmbedder(
  plan: SemanticQueryPlan | SemanticReason = 'ai_not_configured',
): SearchQueryEmbedder & { embedCalls: string[] } {
  const embedCalls: string[] = [];

  const resolve = async () => {
    if (typeof plan === 'string') return { ok: false as const, reason: plan };

    if (!plan.ok && plan.reason !== 'embedding_failed') return plan;

    return {
      ok: true as const,
      embed: async (text: string) => {
        embedCalls.push(text);

        return plan;
      },
    };
  };

  return { resolve, embedCalls } as unknown as SearchQueryEmbedder & { embedCalls: string[] };
}

/** A successful plan, with a vector the SQL builder will accept. */
const embedded: SemanticQueryPlan = {
  ok: true,
  provider: 'openai',
  model: EMBEDDING_MODEL,
  vector: QUERY_VECTOR,
};

function makeHarness(
  options: {
    nodes?: number;
    candidates?: RawCandidate[];
    /** The semantic arm's rows. Only reached when the plan succeeds. */
    vectorCandidates?: RawCandidate[];
    /** `false` makes the embeddings-present probe answer "nothing indexed". */
    anyEmbeddings?: boolean;
    unindexed?: number;
    embedder?: SearchQueryEmbedder & { embedCalls: string[] };
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
    if (sql.sql.includes('AS present')) return [{ present: options.anyEmbeddings ?? true }];
    if (sql.sql.includes('coalesce(sum(x.n)')) return [{ n: options.unindexed ?? 0 }];
    if (sql.sql.includes('y.rn')) return options.snippets ?? [];
    if (sql.sql.includes('<=>')) return options.vectorCandidates ?? [];

    return options.candidates ?? [];
  });

  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const embedder = options.embedder ?? stubEmbedder();

  return { service: new SearchService(prisma, embedder), queryRaw, rawCalls, embedder };
}

/** The candidate statement (there are two once the semantic arm runs). */
const lexicalSql = (calls: Prisma.Sql[]) =>
  calls.find(
    (sql) =>
      sql.sql.includes('LIMIT') && !sql.sql.includes('<=>') && !sql.sql.includes('AS present'),
  )!;
const vectorSql = (calls: Prisma.Sql[]) => calls.find((sql) => sql.sql.includes('<=>'));
const presenceSql = (calls: Prisma.Sql[]) => calls.find((sql) => sql.sql.includes('AS present'));

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
        { q: 'annual budget', types: ['transcript', 'note'], userId: USER_ID, semantic: null },
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
          semantic: null,
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

      // The titles are already in hand, so nothing headlines anything. Asserted
      // on the STATEMENTS rather than on a count: #189 added the unindexed
      // count to every request, and a bare `toHaveLength` would have failed for
      // a reason that has nothing to do with snippets.
      expect(rawCalls.some((sql) => sql.sql.includes('ts_headline'))).toBe(false);
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

      expect(rawCalls.some((sql) => sql.sql.includes('ts_headline'))).toBe(false);
    });
  });
  // ==========================================================================
  // The semantic arm (#189) — every way it can be unavailable
  // ==========================================================================

  describe('degrading to full text', () => {
    it('answers a caller with no API key exactly as the full-text arm does', async () => {
      // ⚠ THE CONTRACT THE WHOLE DEGRADATION RESTS ON, asserted on IDS AND
      // ORDER rather than on "not empty". A searcher who has never pasted an
      // API key must get the pre-#165 endpoint back, byte for byte in the
      // things they can see — not a shorter list, not a reordered one, and
      // certainly not an error.
      const candidates = [
        candidate(0),
        candidate(1, { type: 'note', id: 'note-1' }),
        candidate(2),
      ];

      const baseline = await makeHarness({
        candidates,
        embedder: stubEmbedder('ai_not_configured'),
      }).service.search(query(), user());

      const { service, rawCalls } = makeHarness({
        candidates,
        embedder: stubEmbedder('ai_key_missing'),
      });

      const result = await service.search(query(), user());

      expect(result.semantic).toBe(false);
      expect(result.semanticReason).toBe('ai_key_missing');
      expect(result.results.map((r) => r.id)).toEqual(['doc-0', 'note-1', 'doc-2']);
      expect(result.results.map((r) => r.id)).toEqual(baseline.results.map((r) => r.id));
      expect(result.matchedDocuments).toBe(3);
      // And it cost nothing: no vector query was issued at all.
      expect(vectorSql(rawCalls)).toBeUndefined();
    });

    it('never throws for any reason the semantic arm can have', async () => {
      // Every branch is a 200. A search box that 500s because a vendor is
      // having an afternoon is worse than one that ranks by keywords.
      const reasons: SemanticReason[] = [
        'ai_not_configured',
        'embedding_unsupported',
        'ai_key_missing',
      ];

      for (const reason of reasons) {
        const { service } = makeHarness({
          candidates: [candidate(0)],
          embedder: stubEmbedder(reason),
        });

        await expect(service.search(query(), user())).resolves.toMatchObject({
          semantic: false,
          semanticReason: reason,
          results: [expect.objectContaining({ id: 'doc-0' })],
        });
      }
    });

    it('scopes the "is anything indexed" probe to what this caller can see', async () => {
      // ⚠ CALLER-SCOPED, NOT DEPLOYMENT-WIDE. A deployment-wide probe would
      // tell a brand-new user on a busy installation that the semantic arm was
      // available, charge their own key for a query vector, and hand back an
      // empty vector list every time - because none of the corpus is theirs.
      const { service, rawCalls } = makeHarness({
        candidates: [],
        embedder: stubEmbedder(embedded),
      });

      await service.search(query(), user());

      const text = presenceSql(rawCalls)!.sql;

      expect(text).toContain('transcript_shares');
      expect(text).toContain('deleted_at IS NULL');
      expect(presenceSql(rawCalls)!.values).toContain(USER_ID);
    });

    it('reports no_indexed_content WITHOUT spending an embedding call', async () => {
      // The order the plan evaluates in is the point: embedding a query for a
      // deployment that has indexed nothing is a bill for a comparison against
      // an empty table.
      const { service, rawCalls, embedder } = makeHarness({
        candidates: [candidate(0)],
        anyEmbeddings: false,
        embedder: stubEmbedder(embedded),
      });

      const result = await service.search(query(), user());

      expect(result.semantic).toBe(false);
      expect(result.semanticReason).toBe('no_indexed_content');
      expect(embedder.embedCalls).toEqual([]);
      expect(vectorSql(rawCalls)).toBeUndefined();
      expect(result.results.map((r) => r.id)).toEqual(['doc-0']);
    });

    it('reports embedding_failed when the provider refuses, and still answers 200', async () => {
      const { service, rawCalls, embedder } = makeHarness({
        candidates: [candidate(0), candidate(1)],
        embedder: stubEmbedder({ ok: false, reason: 'embedding_failed' }),
      });

      const result = await service.search(query(), user());

      // The call WAS made — this is a vendor failure, not a skipped step.
      expect(embedder.embedCalls).toEqual(['pricing model']);
      expect(result.semantic).toBe(false);
      expect(result.semanticReason).toBe('embedding_failed');
      expect(result.results.map((r) => r.id)).toEqual(['doc-0', 'doc-1']);
      expect(vectorSql(rawCalls)).toBeUndefined();
    });

    it('carries a null reason when the arm did run', async () => {
      const { service } = makeHarness({
        candidates: [candidate(0)],
        vectorCandidates: [candidate(0)],
        embedder: stubEmbedder(embedded),
      });

      const result = await service.search(query(), user());

      expect(result.semantic).toBe(true);
      expect(result.semanticReason).toBeNull();
    });

    it('embeds the NORMALISED query text, not the raw parameter', async () => {
      const { service, embedder } = makeHarness({
        candidates: [],
        embedder: stubEmbedder(embedded),
      });

      await service.search(query({ q: '  pricing   model ' }), user());

      // The same text the fingerprint hashes, so a respaced repeat of a search
      // is one search on both axes.
      expect(embedder.embedCalls).toEqual(['pricing model']);
    });
  });

  // ==========================================================================
  // The vector arm's SQL — the security boundary, restated for the new arm
  // ==========================================================================

  describe('the vector arm', () => {
    const semanticHarness = (over: Parameters<typeof makeHarness>[0] = {}) =>
      makeHarness({
        candidates: [candidate(0)],
        vectorCandidates: [candidate(0)],
        embedder: stubEmbedder(embedded),
        ...over,
      });

    it('applies the visibility predicate INSIDE the vector query, before the LIMIT', async () => {
      // ⚠ THE MIRROR OF THE ASSERTION THIS FILE ALREADY CARRIES FOR THE
      // FULL-TEXT ARM, and the arm where breaking it is most tempting: the
      // shape every pgvector example shows is `ORDER BY embedding <=> $1 LIMIT
      // k`, which picks the k nearest chunks in the WHOLE CORPUS and only then
      // asks whose they were. A user who owns 1% of the corpus would get an
      // empty semantic arm, with no error anywhere.
      const { service, rawCalls } = semanticHarness();

      await service.search(query(), user());

      const text = vectorSql(rawCalls)!.sql;
      const limitAt = text.lastIndexOf('LIMIT');

      expect(limitAt).toBeGreaterThan(-1);
      expect(text.indexOf('transcript_shares')).toBeGreaterThan(-1);
      expect(text.indexOf('transcript_shares')).toBeLessThan(limitAt);
      expect(text.indexOf('deleted_at IS NULL')).toBeLessThan(limitAt);
      expect(text.indexOf('owner_id')).toBeLessThan(limitAt);
      // And the ANN-shaped mistake is absent: the only LIMIT is the outer one.
      expect(text.match(/LIMIT/g)).toHaveLength(1);
    });

    it('scopes notes to the owner and joins NO share table', async () => {
      const { service, rawCalls } = semanticHarness();

      await service.search(query({ types: 'note' }), user());

      const text = vectorSql(rawCalls)!.sql;

      expect(text).toContain('JOIN notes n');
      expect(text).not.toContain('share');
    });

    it('uses the cosine operator the HNSW index was built for', async () => {
      // `vector_cosine_ops` in the migration and `<=>` here are one decision in
      // two places. `<->` or `<#>` would still return plausible results — the
      // vectors are normalised — while silently orphaning the index, with only
      // `EXPLAIN` to say so.
      const { service, rawCalls } = semanticHarness();

      await service.search(query(), user());

      const text = vectorSql(rawCalls)!.sql;

      expect(text).toContain('<=>');
      expect(text).not.toContain('<->');
      expect(text).not.toContain('<#>');
    });

    it('rolls a document up by its BEST chunk, never by a sum over chunks', async () => {
      const { service, rawCalls } = semanticHarness();

      await service.search(query(), user());

      const text = vectorSql(rawCalls)!.sql;

      expect(text).toContain('max(1 - (e.embedding <=>');
      expect(text).not.toMatch(/\bsum\s*\(/i);
      expect(text).not.toMatch(/\bavg\s*\(/i);
    });

    it('binds the query vector rather than splicing 1536 numbers into the statement', async () => {
      const { service, rawCalls } = semanticHarness();

      await service.search(query(), user());

      const sql = vectorSql(rawCalls)!;
      const literal = `[${QUERY_VECTOR.join(',')}]`;

      expect(sql.sql).not.toContain(literal);
      expect(sql.sql).toContain('::vector');
      expect(sql.values).toContain(literal);
    });

    it('asks the vector arm for one more than the cap, like the full-text arm', async () => {
      const { service, rawCalls } = semanticHarness();

      await service.search(query(), user());

      expect(vectorSql(rawCalls)!.values).toContain(MAX_CANDIDATE_DOCUMENTS + 1);
    });

    it('runs on the degraded path too — `degraded` describes the LEXICAL arm only', async () => {
      const { service, rawCalls } = semanticHarness({ nodes: 0 });

      const result = await service.search(query({ q: 'the and of' }), user());

      expect(result.degraded).toBe('stopwords');
      expect(result.semantic).toBe(true);
      expect(vectorSql(rawCalls)).toBeDefined();
      expect(lexicalSql(rawCalls).sql).toContain('ILIKE');
    });
  });

  // ==========================================================================
  // Fusion, as the service wires it
  // ==========================================================================

  describe('fusing the two arms', () => {
    const older = new Date('2026-09-01T00:00:00.000Z');

    it('surfaces a document only the vector arm found', async () => {
      // THE HEADLINE CRITERION OF THE EPIC, in miniature: a paraphrase finds a
      // document that shares no stemmed term with the query, so the lexical arm
      // never saw it.
      const { service } = makeHarness({
        candidates: [candidate(0)],
        vectorCandidates: [candidate(9, { id: 'semantic-only' })],
        embedder: stubEmbedder(embedded),
      });

      const result = await service.search(query(), user());

      expect(result.results.map((r) => r.id).sort()).toEqual(['doc-0', 'semantic-only']);
      expect(result.matchedDocuments).toBe(2);
    });

    it('ranks a document both arms found above one either arm found alone', async () => {
      const { service } = makeHarness({
        candidates: [candidate(0, { id: 'lexical-only' }), candidate(1, { id: 'agreed' })],
        vectorCandidates: [
          candidate(2, { id: 'vector-only' }),
          candidate(3, { id: 'agreed' }),
        ],
        embedder: stubEmbedder(embedded),
      });

      const result = await service.search(query(), user());

      expect(result.results[0].id).toBe('agreed');
      expect(result.results[0].score).toBeCloseTo(2 / (RRF_K + 2), 12);
    });

    it('publishes the RRF score, not the arm score the row carried', async () => {
      const { service } = makeHarness({
        candidates: [candidate(0)],
        embedder: stubEmbedder('ai_key_missing'),
      });

      const result = await service.search(query(), user());

      // `candidate(0)` carries `score: 1`, a `ts_rank_cd` value. What ships is
      // its fused rank score.
      expect(result.results[0].score).toBeCloseTo(1 / (RRF_K + 1), 12);
    });

    it('keeps the full-text ORDER identical when only one arm ran', async () => {
      // Fusing one list is the identity on order, which is what makes the
      // no-key path a genuine no-op rather than a second ranking path.
      const candidates = Array.from({ length: 12 }, (_, i) => candidate(i));
      const { service } = makeHarness({ candidates, embedder: stubEmbedder('ai_key_missing') });

      const result = await service.search(query({ limit: 12 }), user());

      expect(result.results.map((r) => r.id)).toEqual(candidates.map((c) => c.id));
    });

    it('breaks a fused tie by updatedAt then id, as the SQL does', async () => {
      // Both documents are rank 1 in one arm and rank 2 in the other, so their
      // RRF scores are equal by construction.
      const { service } = makeHarness({
        candidates: [
          candidate(0, { id: 'aaa', updated_at: older }),
          candidate(1, { id: 'bbb' }),
        ],
        vectorCandidates: [
          candidate(2, { id: 'bbb' }),
          candidate(3, { id: 'aaa', updated_at: older }),
        ],
        embedder: stubEmbedder(embedded),
      });

      const result = await service.search(query(), user());

      expect(result.results[0].score).toBeCloseTo(result.results[1].score, 12);
      expect(result.results.map((r) => r.id)).toEqual(['bbb', 'aaa']);
    });

    it('reports truncated when EITHER arm filled its window', async () => {
      const { service } = makeHarness({
        candidates: [candidate(0)],
        vectorCandidates: Array.from({ length: MAX_CANDIDATE_DOCUMENTS + 1 }, (_, i) =>
          candidate(i, { id: `vec-${i}` }),
        ),
        embedder: stubEmbedder(embedded),
      });

      const result = await service.search(query(), user());

      expect(result.truncated).toBe(true);
      expect(result.matchedDocuments).toBe(MAX_CANDIDATE_DOCUMENTS);
    });

    it('never lets the union exceed the cap', async () => {
      const { service } = makeHarness({
        candidates: Array.from({ length: 150 }, (_, i) => candidate(i, { id: `l-${i}` })),
        vectorCandidates: Array.from({ length: 150 }, (_, i) => candidate(i, { id: `v-${i}` })),
        embedder: stubEmbedder(embedded),
      });

      const result = await service.search(query(), user());

      expect(result.matchedDocuments).toBe(MAX_CANDIDATE_DOCUMENTS);
      expect(result.truncated).toBe(true);
    });
  });

  // ==========================================================================
  // `unindexedCount`
  // ==========================================================================

  describe('unindexedCount', () => {
    it('counts the caller OWN documents that are not `indexed`', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [], unindexed: 9 });

      const result = await service.search(query(), user());

      expect(result.unindexedCount).toBe(9);

      const text = rawCalls.find((sql) => sql.sql.includes('coalesce(sum(x.n)'))!.sql;

      // Own, not visible-to-you: a shared transcript is indexed on its OWNER's
      // key, so counting it would report a number the reader cannot move.
      expect(text).toContain('owner_id = ?::uuid');
      expect(text).not.toContain('transcript_shares');
      // "No row at all" and "a row that is not indexed" are one predicate.
      expect(text).toContain('NOT EXISTS');
      expect(text).toContain("s.status = 'indexed'");
    });

    it('is 0 when everything the caller owns is indexed', async () => {
      const { service } = makeHarness({ candidates: [candidate(0)], unindexed: 0 });

      await expect(service.search(query(), user())).resolves.toMatchObject({
        unindexedCount: 0,
      });
    });

    it('is scoped to the types actually searched', async () => {
      const { service, rawCalls } = makeHarness({ candidates: [] });

      await service.search(query({ types: 'note' }), user());

      const text = rawCalls.find((sql) => sql.sql.includes('coalesce(sum(x.n)'))!.sql;

      expect(text).toContain('FROM notes n');
      expect(text).not.toContain('FROM transcripts t');
    });

    it('is computed even when the semantic arm ran perfectly', async () => {
      const { service, rawCalls } = makeHarness({
        candidates: [candidate(0)],
        vectorCandidates: [candidate(0)],
        unindexed: 2,
        embedder: stubEmbedder(embedded),
      });

      const result = await service.search(query(), user());

      expect(result.semantic).toBe(true);
      expect(result.unindexedCount).toBe(2);
      expect(rawCalls.some((sql) => sql.sql.includes('coalesce(sum(x.n)'))).toBe(true);
    });
  });

  // ==========================================================================
  // The cursor, across the fingerprint change
  // ==========================================================================

  describe('cursors and the semantic axis', () => {
    it('refuses a cursor minted before the fingerprint gained the semantic axis', async () => {
      // ⚠ WHY `RANKING_MODEL_VERSION` HAD TO BE BUMPED AS WELL AS THE AXIS
      // ADDED. For a keyless caller the axis is `null` both before and after
      // #189, so a pre-#189 cursor would reproduce today's fingerprint exactly
      // — and would then index into a window built by reciprocal rank fusion
      // instead of by raw `ts_rank_cd` ordering. The version constant is what
      // makes that impossible, and this forges a v1 cursor to prove it.
      const legacy = require('node:crypto')
        .createHash('sha256')
        .update(['1', 'pricing model', 'note,transcript', USER_ID].join('\n'), 'utf8')
        .digest('hex')
        .slice(0, 40);

      expect(RANKING_MODEL_VERSION).toBeGreaterThan(1);

      const stale = Buffer.from(JSON.stringify({ f: legacy, o: 20 }), 'utf8').toString(
        'base64url',
      );

      const { service } = makeHarness({ candidates: [] });

      await expect(service.search(query({ cursor: stale }), user())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a full-text cursor once the caller has a key', async () => {
      // Nothing about the REQUEST changed — same `q`, same types, same user.
      // Only the caller's own credential did.
      const keyless = makeHarness({
        candidates: Array.from({ length: 25 }, (_, i) => candidate(i)),
        embedder: stubEmbedder('ai_key_missing'),
      });

      const first = await keyless.service.search(query({ limit: 20 }), user());

      expect(first.nextCursor).not.toBeNull();

      const withKey = makeHarness({
        candidates: Array.from({ length: 25 }, (_, i) => candidate(i)),
        vectorCandidates: [candidate(0)],
        embedder: stubEmbedder(embedded),
      });

      await expect(
        withKey.service.search(query({ limit: 20, cursor: first.nextCursor! }), user()),
      ).rejects.toThrow(BadRequestException);
    });

    it('pages a fused window with its own cursor', async () => {
      const harness = () =>
        makeHarness({
          candidates: Array.from({ length: 5 }, (_, i) => candidate(i, { id: `l-${i}` })),
          vectorCandidates: Array.from({ length: 5 }, (_, i) => candidate(i, { id: `v-${i}` })),
          embedder: stubEmbedder(embedded),
        });

      const first = await harness().service.search(query({ limit: 4 }), user());

      expect(first.matchedDocuments).toBe(10);
      expect(first.nextCursor).not.toBeNull();

      const second = await harness().service.search(
        query({ limit: 4, cursor: first.nextCursor! }),
        user(),
      );

      expect(second.results).toHaveLength(4);
      expect(first.results.map((r) => r.id)).not.toEqual(
        expect.arrayContaining(second.results.map((r) => r.id)),
      );
    });
  });
});
