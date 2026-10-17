import {
  KVOX_AI_ERROR_CLASSES,
  KvoxAiError,
  KvoxRateLimitError,
  type KvoxAiCapabilities,
  type KvoxAiPort,
  type KvoxJobHandler,
  type KvoxPrismaClientLike,
  type KvoxSql,
} from '../../ports/index.js';
import type { SearchCandidateRow } from '../data/search-db.js';
import { SEARCH_INDEX_JOB_TYPE } from '../indexing/job-types.js';
import {
  DEFAULT_SEARCH_TYPE_PERMISSIONS,
  SEARCH_EMBEDDING_DIMENSIONS,
  type SearchTypePermissions,
} from '../search.options.js';
import type { SearchService } from '../search.service.js';

// =============================================================================
// describeSearchConformance (issue #494, epic #491)
// =============================================================================
//
// The executable proof that a binding of the search slice is correct. The package
// runs it over the fake ports (`test/search-conformance.spec.ts`) and the web
// application runs it over its own binding (`apps/api/test/conformance.spec.ts`),
// so a host's visibility rule, permission strings and job registration are held
// to the same contract. Test-runner neutral: the caller hands over `describe`,
// `it` and `expect`, so it works under Jest and Vitest alike.
//
// WHAT IT ASSERTS
//
//   1. `search.index` is registered under its permanent type string and is
//      SERVER-ONLY: it declares `usesAi` and neither node member (the key it spends
//      is the document owner's own, and no vendor offers a job-scoped sub-key).
//   2. The query path NEVER THROWS because of the model. For every class of AI
//      error, for a rate limit, for anything else a model call can throw, and for
//      a capability probe that itself throws, the answer is a 200-shaped response
//      with `semantic: false`, a reason and the FULL-TEXT hits intact.
//   3. A host without usable embeddings (none at all, or vectors that are not
//      1536 wide) answers with full-text only and says `embeddings_unavailable`,
//      and never spends an embedding call.
//   4. A cursor presented by another caller is refused, not honoured: on a
//      relevance list a silently restarted page is indistinguishable from a real
//      one.
//   5. A caller holding ONE of the two read permissions gets a partial answer
//      naming what was searched, not a refusal; a caller holding neither is
//      refused.
//   6. Every statement the query path sends is a read.
//
// The kit runs the REAL `SearchService` over a database double that answers by
// the statement's text (candidate rows, the stopword probe, the presence probe,
// the unindexed count), so it needs no database; the real-database proof is the
// package's `search.db.spec.ts` and the application's own db specs.
// =============================================================================

/**
 * The test runner's functions, so the kit runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface SearchConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * What the kit needs from the binding under test.
 *
 * @stability experimental
 */
export interface SearchConformanceTarget {
  /** The `search.index` handler as the host registers it. */
  indexHandler: KvoxJobHandler;

  /**
   * The real query service wired the way the host wires it (its visibility rule,
   * its options, its permission strings), over the given AI port and database.
   * A host whose visibility needs more of the database than `$queryRaw` wraps the
   * double it is given.
   *
   * @param parts - the AI port and the database double to build the service over.
   */
  serviceFor(parts: { ai: KvoxAiPort; db: KvoxPrismaClientLike }): SearchService;
}

/**
 * Options of {@link describeSearchConformance}.
 *
 * @stability experimental
 */
export interface SearchConformanceOptions {
  /** The permission each document type needs in the host. Default: the web edition's strings. */
  permissions?: SearchTypePermissions;
}

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

/** The statement text, whichever shape the caller passed. */
function textOf(query: TemplateStringsArray | KvoxSql): string {
  return Array.isArray(query) ? (query as unknown as string[]).join('?') : (query as KvoxSql).strings.join('?');
}

/**
 * A database double that answers the query path's statements by their text:
 * candidates (filtered to the document types the statement names), the stopword
 * probe, the embeddings-present probe, snippets and the unindexed count.
 */
function databaseDouble(rows: readonly SearchCandidateRow[]): { db: KvoxPrismaClientLike; statements: string[] } {
  const statements: string[] = [];

  const answer = (text: string): unknown => {
    if (text.includes('numnode(')) return [{ nodes: 3 }];
    if (text.includes('AS present')) return [{ present: true }];
    if (text.includes('coalesce(sum(x.n)')) return [{ n: 0 }];
    if (text.includes('y.rn')) return [];
    if (text.includes('<=>')) return [];

    const wantsTranscripts = /FROM transcripts (tt|t)\b/.test(text);
    const wantsNotes = text.includes('FROM notes n');

    return rows.filter((row) => (row.type === 'transcript' ? wantsTranscripts : wantsNotes));
  };

  const run = async (query: TemplateStringsArray | KvoxSql): Promise<unknown> => {
    const text = textOf(query);
    statements.push(text);

    return answer(text);
  };

  const db = {
    $queryRaw: run,
    $executeRaw: async () => {
      throw new Error('The search query path must not write.');
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  } as unknown as KvoxPrismaClientLike;

  return { db, statements };
}

/** Five candidate documents of both types, newest first. */
function candidates(): SearchCandidateRow[] {
  return Array.from({ length: 5 }, (_, position) => ({
    type: position % 2 === 0 ? ('transcript' as const) : ('note' as const),
    id: `doc-${position}`,
    title: `Document ${position}`,
    status: 'ready',
    updated_at: new Date(Date.UTC(2026, 8, 15, 12, 0, 0) - position * 1000),
    score: 1 / (position + 1),
  }));
}

/** An AI port whose capabilities and embed answers the caller scripts. */
function scriptedAi(script: {
  capabilities?: Partial<KvoxAiCapabilities> | (() => never);
  embed?: () => never;
}): KvoxAiPort & { embedCalls: number } {
  const unsupported = async (): Promise<never> => {
    throw new Error('The search query path calls only capabilities and embed.');
  };
  const state = { embedCalls: 0 };

  return {
    get embedCalls() {
      return state.embedCalls;
    },
    async capabilities() {
      if (typeof script.capabilities === 'function') return script.capabilities();

      return {
        available: true,
        structuredOutput: true,
        toolCalling: true,
        embeddings: { model: 'conformance-embed', dimensions: SEARCH_EMBEDDING_DIMENSIONS },
        graphEnabled: true,
        ...script.capabilities,
      };
    },
    async embed(_ctx, request) {
      state.embedCalls += 1;
      if (script.embed) return script.embed();

      return {
        model: 'conformance-embed',
        dimensions: SEARCH_EMBEDDING_DIMENSIONS,
        vectors: request.inputs.map(() => new Array(SEARCH_EMBEDDING_DIMENSIONS).fill(0.01) as number[]),
      };
    },
    resolveTask: unsupported,
    generateText: unsupported as never,
    generateStructured: unsupported,
    chat: unsupported as never,
    countTokens: () => 0,
  };
}

const principal = (userId: string, permissions: readonly string[]) => ({
  userId,
  permissions: new Set(permissions) as ReadonlySet<string>,
});

const QUERY = { q: 'pricing model', limit: 20 } as const;

/**
 * Runs the search conformance suite against a binding.
 *
 * @param name - what is under test, for the group title.
 * @param factory - builds the binding; called once per test.
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the host's permission strings.
 * @stability experimental
 */
export function describeSearchConformance(
  name: string,
  factory: () => SearchConformanceTarget,
  harness: SearchConformanceHarness,
  options: SearchConformanceOptions = {},
): void {
  const { describe, it, expect } = harness;
  const permissions = options.permissions ?? DEFAULT_SEARCH_TYPE_PERMISSIONS;
  const both = [permissions.transcript, permissions.note];

  describe(`search conformance: ${name}`, () => {
    describe('the search.index job', () => {
      it('is registered under its permanent type string', () => {
        expect(factory().indexHandler.type).toBe(SEARCH_INDEX_JOB_TYPE);
        expect(SEARCH_INDEX_JOB_TYPE).toBe('search.index');
      });

      it('is server-only: it spends the owner\'s own key, so it declares usesAi and no node member', () => {
        const handler = factory().indexHandler;

        expect(handler.usesAi).toBe(true);
        expect(handler.nodeResultSchema).toBeUndefined();
        expect(handler.persistNodeResult).toBeUndefined();
      });
    });

    describe('the query embedder never throws, whatever the model does', () => {
      const failures: Array<[string, () => never]> = [
        ...KVOX_AI_ERROR_CLASSES.map((errorClass): [string, () => never] => [
          `a KvoxAiError of class ${errorClass}`,
          () => {
            throw new KvoxAiError(errorClass, `scripted ${errorClass}`, errorClass === 'rate_limit' ? 1000 : undefined);
          },
        ]),
        [
          'a KvoxRateLimitError',
          () => {
            throw new KvoxRateLimitError(`ai-provider:${USER_A}`, 1000);
          },
        ],
        [
          'a plain Error',
          () => {
            throw new Error('socket hang up');
          },
        ],
        [
          'a thrown string',
          () => {
            throw 'boom';
          },
        ],
      ];

      for (const [label, fail] of failures) {
        it(`answers with the full-text hits and embedding_failed when embed throws ${label}`, async () => {
          const { db } = databaseDouble(candidates());
          const service = factory().serviceFor({ ai: scriptedAi({ embed: fail }), db });

          const result = await service.search({ ...QUERY }, principal(USER_A, both));

          expect(result.semantic).toBe(false);
          expect(result.semanticReason).toBe('embedding_failed');
          expect(result.results.length).toBeGreaterThan(0);
        });
      }

      it('answers ai_not_configured, not an error, when the capability probe itself throws', async () => {
        const { db } = databaseDouble(candidates());
        const ai = scriptedAi({
          capabilities: () => {
            throw new Error('probe failed');
          },
        });

        const result = await factory().serviceFor({ ai, db }).search({ ...QUERY }, principal(USER_A, both));

        expect(result).toMatchObject({ semantic: false, semanticReason: 'ai_not_configured' });
        expect(result.results.length).toBeGreaterThan(0);
      });
    });

    describe('a host without usable embeddings answers with full-text only and says why', () => {
      it('reports embeddings_unavailable, with the hits, when the host has no embeddings model', async () => {
        const { db } = databaseDouble(candidates());
        const ai = scriptedAi({ capabilities: { embeddings: null } });

        const result = await factory().serviceFor({ ai, db }).search({ ...QUERY }, principal(USER_A, both));

        expect(result).toMatchObject({ semantic: false, semanticReason: 'embeddings_unavailable' });
        expect(result.results.length).toBeGreaterThan(0);
        // ⚠ Not a single embedding call is spent on a host that cannot store the vector.
        expect(ai.embedCalls).toBe(0);
      });

      it('reports embeddings_unavailable for a model whose vectors are not 1536 wide', async () => {
        const { db } = databaseDouble(candidates());
        const ai = scriptedAi({ capabilities: { embeddings: { model: 'wide-model', dimensions: 3072 } } });

        const result = await factory().serviceFor({ ai, db }).search({ ...QUERY }, principal(USER_A, both));

        expect(result).toMatchObject({ semantic: false, semanticReason: 'embeddings_unavailable' });
        expect(ai.embedCalls).toBe(0);
      });

      it('reports ai_not_configured and ai_key_missing for the reasons that are not about embeddings', async () => {
        for (const reason of ['ai_not_configured', 'ai_key_missing'] as const) {
          const { db } = databaseDouble(candidates());
          const ai = scriptedAi({ capabilities: { available: false, reason } });

          const result = await factory().serviceFor({ ai, db }).search({ ...QUERY }, principal(USER_A, both));

          expect(result).toMatchObject({ semantic: false, semanticReason: reason });
          expect(ai.embedCalls).toBe(0);
        }
      });
    });

    describe('cursors', () => {
      it('refuses a cursor minted for another caller', async () => {
        const { db } = databaseDouble(candidates());
        const service = factory().serviceFor({ ai: scriptedAi({ capabilities: { embeddings: null } }), db });

        const first = await service.search({ ...QUERY, limit: 2 }, principal(USER_A, both));

        expect(first.nextCursor).not.toBeNull();

        // The same caller can follow it...
        const next = await service.search(
          { ...QUERY, limit: 2, cursor: first.nextCursor! },
          principal(USER_A, both),
        );

        expect(Array.isArray(next.results)).toBe(true);

        // ...another caller cannot, and learns nothing of the first one's window.
        const refusal = await service
          .search({ ...QUERY, limit: 2, cursor: first.nextCursor! }, principal(USER_B, both))
          .catch((error: unknown) => error);

        expect((refusal as { getStatus?: () => number }).getStatus?.()).toBe(400);
      });
    });

    describe('permissions', () => {
      it('answers a caller holding one permission with the type they may read, not a refusal', async () => {
        for (const [held, searched] of [
          [permissions.note, ['note']],
          [permissions.transcript, ['transcript']],
        ] as const) {
          const { db } = databaseDouble(candidates());
          const service = factory().serviceFor({ ai: scriptedAi({ capabilities: { embeddings: null } }), db });

          const result = await service.search({ ...QUERY }, principal(USER_A, [held]));

          expect(result.searchedTypes).toEqual(searched);
        }
      });

      it('refuses a caller holding neither', async () => {
        const { db } = databaseDouble(candidates());
        const service = factory().serviceFor({ ai: scriptedAi({}), db });

        const refusal = await service.search({ ...QUERY }, principal(USER_A, [])).catch((error: unknown) => error);

        expect((refusal as { getStatus?: () => number }).getStatus?.()).toBe(403);
      });
    });

    describe('reads only', () => {
      it('sends nothing but SELECT statements, and never reaches for $executeRaw', async () => {
        const { db, statements } = databaseDouble(candidates());
        const service = factory().serviceFor({ ai: scriptedAi({}), db });

        await service.search({ ...QUERY }, principal(USER_A, both));

        expect(statements.length).toBeGreaterThan(0);
        for (const text of statements) {
          expect(text.trim().toUpperCase().startsWith('SELECT')).toBe(true);
        }
      });
    });
  });
}
