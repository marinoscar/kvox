/**
 * `services/userData.ts` — issue #80, Danger Zone.
 *
 * =============================================================================
 * `scopeIncludes` IS A SECOND, INDEPENDENTLY-WRITTEN COPY OF A SERVER RULE
 * =============================================================================
 *
 * `apps/api/src/user-data/job-types.ts` OWNS what each scope deletes; this
 * module's `scopeIncludes` exists only so the confirmation dialog can state a
 * count before the request is ever sent. Nothing type-checks the two against
 * each other, so this suite reads the API's OWN `scopeIncludes` source off
 * disk (the technique `services/maintenance.test.ts` already establishes for
 * the maintenance marker) and EXECUTES the extracted expression for every
 * scope, per category — not a hand-typed table that could itself be wrong in
 * the same way a second implementation could be. A rename or a reshuffled
 * `switch` in the API file fails this suite; a genuine, deliberate rule change
 * on the server (like the note-templates reversal below) requires touching
 * both files, which is the whole point.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import {
  createUserDataDeletion,
  getUserDataSummary,
  scopeIncludes,
  scopeIsCompound,
  USER_DATA_CATEGORIES,
  USER_DATA_CONFIRMATION,
} from '../../services/userData';
import type { UserDataCategory, UserDataScope, UserDataSummary } from '../../services/userData';

const API_BASE = 'http://localhost:3000/api';

// Same depth as `services/maintenance.test.ts`: this file also lives at
// apps/web/src/__tests__/services/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const JOB_TYPES_PATH = 'apps/api/src/user-data/job-types.ts';
const apiSource = readFileSync(resolve(repoRoot, JOB_TYPES_PATH), 'utf8');

const ALL_SCOPES: UserDataScope[] = ['transcripts', 'notes', 'files', 'content', 'everything'];

/**
 * Isolate the body of the API's own `scopeIncludes`, so the `case` regexes
 * below cannot accidentally match something in `confirmationFor` or a comment
 * elsewhere in the file.
 */
function extractApiScopeIncludesBody(): string {
  const start = apiSource.indexOf('export function scopeIncludes(');
  const end = apiSource.indexOf('export function confirmationFor(');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `Could not isolate scopeIncludes in ${JOB_TYPES_PATH} — has the function been renamed or reordered?`,
    );
  }
  return apiSource.slice(start, end);
}

const apiFnBody = extractApiScopeIncludesBody();

/** Every `case '<category>':` label the API's `scopeIncludes` actually switches on. */
const apiCategoryLabels = [...apiFnBody.matchAll(/case '([^']+)':/g)].map((m) => m[1]);

/**
 * The category UNION on the `category` parameter itself — this is what the
 * web file's own header means by "named exactly as ... and in the same
 * order" (the `switch`'s `case` order below is a separate, unordered thing:
 * the API happens to write `files` before `noteTemplates` there, while the
 * type union — and `USER_DATA_CATEGORIES` — put `noteTemplates` first).
 */
function extractApiCategoryUnionOrder(): string[] {
  const match = apiFnBody.match(/category:\s*([\s\S]*?)\n\):/);
  if (!match) {
    throw new Error(
      `Could not find the "category" parameter's type union in ${JOB_TYPES_PATH}.`,
    );
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Extract the boolean expression the API returns for one category, and turn
 * it into a callable predicate — the API's OWN rule, executed, not retyped.
 */
function apiScopeIncludesFor(category: string): (scope: UserDataScope) => boolean {
  const re = new RegExp(`case '${category}':\\s*return ([^;]+);`);
  const match = apiFnBody.match(re);
  if (!match) {
    throw new Error(
      `Could not find "case '${category}':" inside scopeIncludes in ${JOB_TYPES_PATH}.`,
    );
  }
  const expr = match[1].trim();
  // eslint-disable-next-line no-new-func -- deliberately executing the API's
  // own extracted expression rather than re-deriving it by hand.
  const fn = new Function('scope', `return (${expr});`) as (scope: UserDataScope) => boolean;
  return fn;
}

describe('scopeIncludes — mirrored from apps/api/src/user-data/job-types.ts, and pinned against it', () => {
  it('switches on exactly the same five categories the API file does (order-independent — see the "same order" check below for the type union)', () => {
    expect(new Set(apiCategoryLabels)).toEqual(new Set(USER_DATA_CATEGORIES));
    expect(apiCategoryLabels).toHaveLength(USER_DATA_CATEGORIES.length);
  });

  it('names the categories in the same order as the API’s own `category` type union', () => {
    expect(extractApiCategoryUnionOrder()).toEqual([...USER_DATA_CATEGORIES]);
  });

  it('agrees with the API’s own scopeIncludes for every scope × category pair', () => {
    for (const category of USER_DATA_CATEGORIES) {
      const apiFn = apiScopeIncludesFor(category);
      for (const scope of ALL_SCOPES) {
        expect(scopeIncludes(scope, category), `scope=${scope} category=${category}`).toBe(
          apiFn(scope),
        );
      }
    }
  });

  // ============================================================================
  // ⚠ NOTE TEMPLATES ARE NOT IN THE NARROW `notes` SCOPE — a deliberate,
  // argued reversal. A regression here silently empties the user's
  // /settings/note-templates page the moment they click "Delete notes".
  // ============================================================================
  it('the narrow "notes" scope does NOT cover note templates — a deliberate reversal from an earlier, wrong design; regressing this silently empties /settings/note-templates', () => {
    expect(scopeIncludes('notes', 'noteTemplates')).toBe(false);
    // The three narrow scopes each cover exactly their own one category.
    expect(scopeIncludes('notes', 'notes')).toBe(true);
    expect(scopeIncludes('notes', 'transcripts')).toBe(false);
    expect(scopeIncludes('notes', 'files')).toBe(false);
    expect(scopeIncludes('notes', 'credentials')).toBe(false);
  });

  it('note templates ARE covered by the two compound scopes — content means "everything you made", and a template is something you made', () => {
    expect(scopeIncludes('content', 'noteTemplates')).toBe(true);
    expect(scopeIncludes('everything', 'noteTemplates')).toBe(true);
  });

  it('credentials are covered by "everything" only — never by "content", never by a narrow scope', () => {
    for (const scope of ALL_SCOPES) {
      expect(scopeIncludes(scope, 'credentials')).toBe(scope === 'everything');
    }
  });

  it('the knowledge graph is covered by "content" and "everything" only — never by a narrow scope (#357)', () => {
    for (const scope of ALL_SCOPES) {
      expect(scopeIncludes(scope, 'graph')).toBe(scope === 'content' || scope === 'everything');
    }
  });

  it('each narrow scope covers exactly one category — no narrow scope silently fans out', () => {
    const narrow: Record<Extract<UserDataScope, 'transcripts' | 'notes' | 'files'>, UserDataCategory> = {
      transcripts: 'transcripts',
      notes: 'notes',
      files: 'files',
    };
    for (const [scope, ownCategory] of Object.entries(narrow) as [UserDataScope, UserDataCategory][]) {
      for (const category of USER_DATA_CATEGORIES) {
        expect(scopeIncludes(scope, category)).toBe(category === ownCategory);
      }
    }
  });
});

describe('scopeIsCompound', () => {
  it('is false for each of the three narrow, single-category scopes', () => {
    expect(scopeIsCompound('transcripts')).toBe(false);
    expect(scopeIsCompound('notes')).toBe(false);
    expect(scopeIsCompound('files')).toBe(false);
  });

  it('is true for both composite scopes', () => {
    expect(scopeIsCompound('content')).toBe(true);
    expect(scopeIsCompound('everything')).toBe(true);
  });
});

describe('USER_DATA_CONFIRMATION', () => {
  it('is the uppercased scope name, for every scope', () => {
    for (const scope of ALL_SCOPES) {
      expect(USER_DATA_CONFIRMATION[scope]).toBe(scope.toUpperCase());
    }
  });

  it('is five distinct words — a literal typed for one action can never be reused for another', () => {
    const words = ALL_SCOPES.map((scope) => USER_DATA_CONFIRMATION[scope]);
    expect(new Set(words).size).toBe(words.length);
  });
});

// =============================================================================
// The wire contract
// =============================================================================

describe('getUserDataSummary', () => {
  it('reads GET /user-data/summary and returns the body as-is', async () => {
    const body: UserDataSummary = {
      transcripts: { count: 1, bytes: '10' },
      notes: { count: 2, bytes: '20' },
      files: { count: 0, bytes: '0' },
      noteTemplates: { count: 0 },
      credentials: { aiKeys: 0, accessTokens: 0 },
      graph: { entities: 3, items: 5 },
      activeDeletion: null,
    };
    server.use(
      http.get(`${API_BASE}/user-data/summary`, () => HttpResponse.json({ data: body })),
    );

    await expect(getUserDataSummary()).resolves.toEqual(body);
  });
});

describe('createUserDataDeletion', () => {
  let sentBody: unknown;

  beforeEach(() => {
    sentBody = undefined;
    server.use(
      http.post(`${API_BASE}/user-data/deletions`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json(
          {
            data: {
              id: 'deletion-1',
              scope: (sentBody as { scope: UserDataScope }).scope,
              status: 'pending',
              requestedAt: '2026-01-01T00:00:00.000Z',
            },
          },
          { status: 202 },
        );
      }),
    );
  });

  it.each(ALL_SCOPES)(
    'fills the confirmation from the scope for %s, so the request body always matches USER_DATA_CONFIRMATION',
    async (scope) => {
      await createUserDataDeletion(scope);

      expect(sentBody).toEqual({ scope, confirmation: USER_DATA_CONFIRMATION[scope] });
    },
  );

  it('returns the 202 body, adoptable directly as summary.activeDeletion', async () => {
    const result = await createUserDataDeletion('files');

    expect(result).toEqual({
      id: 'deletion-1',
      scope: 'files',
      status: 'pending',
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});
