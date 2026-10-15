/**
 * `services/userData.ts` — issue #80, Danger Zone.
 *
 * =============================================================================
 * `scopeIncludes` IS A SECOND, INDEPENDENTLY-WRITTEN COPY OF A SERVER RULE
 * =============================================================================
 *
 * The API OWNS what each scope deletes; this module's `scopeIncludes` exists
 * only so the confirmation dialog can state a count before the request is ever
 * sent. Nothing type-checks the two against each other, so this suite reads
 * the API's OWN declarations off disk (the technique `services/maintenance
 * .test.ts` already establishes) and derives the scope x category matrix from
 * them — not a hand-typed table that could itself be wrong in the same way a
 * second implementation could be.
 *
 * Since issue #460 the API's `scopeIncludes` is registry-driven: categories
 * (`id`, `content`, `order`) and scopes (`id`, `categories`) are literals in
 * `apps/api/src/user-data/user-data.base.ts` and the domain files
 * `apps/api/src/<domain>/<domain>.user-data.ts`. This suite PARSES those files
 * with the TypeScript compiler's parser (syntax only — nothing is imported, so
 * no API code reaches the web bundle) and applies the registry's own
 * resolution rule: `categories: 'all'` reaches everything, `'content'` reaches
 * the categories flagged `content: true`, and a list reaches exactly its
 * members. A category added/removed, or a scope's membership changed, on one
 * side only fails here; a genuine, deliberate rule change on the server (like
 * the note-templates reversal below) requires touching both sides, which is the
 * whole point.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
const API_SRC = resolve(repoRoot, 'apps/api/src');
const MANIFEST_PATH = 'apps/api/src/kvox.manifest.ts';
const BASE_DECLARATION = 'user-data/user-data.base.ts';

const ALL_SCOPES: UserDataScope[] = ['transcripts', 'notes', 'files', 'content', 'everything'];

interface ApiCategory {
  id: string;
  content: boolean;
  order: number;
}
interface ApiScope {
  id: string;
  categories: string[] | 'content' | 'all';
}

/** The value of a property whose initializer is a plain string literal, else undefined. */
function stringProp(props: Map<string, ts.Expression>, name: string): string | undefined {
  const init = props.get(name);
  return init && ts.isStringLiteralLike(init) ? init.text : undefined;
}

/**
 * Every API file that DECLARES user-data categories/scopes: the base file plus
 * each domain's `*.user-data.ts` (hooks/spec files do not match the suffix).
 * Discovered, not listed, so a new domain's declaration file is picked up
 * automatically rather than silently ignored.
 */
function findApiDeclarationFiles(): string[] {
  const found = readdirSync(API_SRC, { recursive: true, encoding: 'utf8' })
    .map((p) => p.split('\\').join('/'))
    .filter((p) => p.endsWith('.user-data.ts'));
  return [BASE_DECLARATION, ...found].sort();
}

/**
 * Parse the category and scope literals out of the API's declaration files.
 * A category literal is an object with a string `id` and a boolean `content`;
 * a scope literal is an object with a string `id` and a `categories` property.
 * Nested objects (`summary`, `purge`) carry neither shape and are ignored.
 */
function parseApiDeclarations(): { categories: ApiCategory[]; scopes: ApiScope[] } {
  const categories: ApiCategory[] = [];
  const scopes: ApiScope[] = [];

  for (const file of findApiDeclarationFiles()) {
    const text = readFileSync(resolve(API_SRC, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = new Map<string, ts.Expression>();
        for (const prop of node.properties) {
          if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))) {
            props.set(prop.name.text, prop.initializer);
          }
        }
        const id = stringProp(props, 'id');
        const content = props.get('content');
        const cats = props.get('categories');

        if (id !== undefined && cats !== undefined) {
          if (ts.isStringLiteralLike(cats)) {
            if (cats.text !== 'content' && cats.text !== 'all') {
              throw new Error(`${file}: scope "${id}" has unrecognised categories "${cats.text}".`);
            }
            scopes.push({ id, categories: cats.text });
          } else if (ts.isArrayLiteralExpression(cats) && cats.elements.every(ts.isStringLiteralLike)) {
            scopes.push({ id, categories: cats.elements.map((e) => (e as ts.StringLiteral).text) });
          } else {
            throw new Error(`${file}: scope "${id}" has a \`categories\` value this suite cannot read statically.`);
          }
        } else if (
          id !== undefined &&
          content !== undefined &&
          (content.kind === ts.SyntaxKind.TrueKeyword || content.kind === ts.SyntaxKind.FalseKeyword)
        ) {
          const order = props.get('order');
          categories.push({
            id,
            content: content.kind === ts.SyntaxKind.TrueKeyword,
            // Mirrors the registry: a category with no `order` sorts last.
            order: order && ts.isNumericLiteral(order) ? Number(order.text) : Number.MAX_SAFE_INTEGER,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // Array#sort is stable, matching the registry's `list()` for equal orders.
  categories.sort((a, b) => a.order - b.order);
  return { categories, scopes };
}

const api = parseApiDeclarations();
const apiCategoryIds = api.categories.map((c) => c.id);

/** The registry's own resolution rule (`userDataScopeReaches`), applied to the parsed literals. */
function apiScopeReaches(scopeId: string, categoryId: string): boolean {
  const scope = api.scopes.find((s) => s.id === scopeId);
  const category = api.categories.find((c) => c.id === categoryId);
  if (!scope || !category) {
    throw new Error(`API declarations name no scope "${scopeId}" / category "${categoryId}".`);
  }
  if (scope.categories === 'all') return true;
  if (scope.categories === 'content') return category.content;
  return scope.categories.includes(categoryId);
}

describe('scopeIncludes — mirrored from the API’s user-data declarations, and pinned against them', () => {
  it('finds the declaration files, and every one is registered by the API manifest', () => {
    const files = findApiDeclarationFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        BASE_DECLARATION,
        'ask/ask.user-data.ts',
        'graph/graph.user-data.ts',
        'notes/notes.user-data.ts',
        'transcripts/transcripts.user-data.ts',
      ]),
    );
    const manifest = readFileSync(resolve(repoRoot, MANIFEST_PATH), 'utf8');
    for (const file of files) {
      const specifier = './' + relative(API_SRC, resolve(API_SRC, file)).replace(/\.ts$/, '');
      expect(manifest, `${file} must be imported by ${MANIFEST_PATH}`).toContain(`'${specifier}'`);
    }
  });

  it('declares exactly the same categories the web mirror lists (no duplicates on either side)', () => {
    expect(new Set(apiCategoryIds).size).toBe(apiCategoryIds.length);
    expect(new Set(apiCategoryIds)).toEqual(new Set(USER_DATA_CATEGORIES));
    expect(apiCategoryIds).toHaveLength(USER_DATA_CATEGORIES.length);
  });

  it('declares exactly the same five scopes the web mirror asks about', () => {
    const apiScopeIds = api.scopes.map((s) => s.id);
    expect(new Set(apiScopeIds).size).toBe(apiScopeIds.length);
    expect(new Set(apiScopeIds)).toEqual(new Set(ALL_SCOPES));
  });

  // The API's category order is now the registry `order` of each declaration
  // (it is the key order of GET /api/user-data/summary), not the union that
  // `scopeIncludes` used to take. The web list is NOT in that order: it is
  // the order the deletion dialog's itemised sentence is written in
  // (`utils/userDataDisplay.ts`, pinned by its own test), which has always
  // differed from the summary's key order for `noteTemplates`/`files` and for
  // `onboarding`/`graph`/`ask`. So each side's order is pinned on its own, and
  // reordering either one fails here and forces a look at the other.
  it('pins the API’s category order (summary order, by declared `order`) and the web mirror’s own order', () => {
    expect(apiCategoryIds).toEqual([
      'transcripts',
      'notes',
      'files',
      'noteTemplates',
      'credentials',
      'graph',
      'ask',
      'onboarding',
    ]);
    expect([...USER_DATA_CATEGORIES]).toEqual([
      'transcripts',
      'notes',
      'noteTemplates',
      'files',
      'credentials',
      'onboarding',
      'graph',
      'ask',
    ]);
  });

  it('agrees with the API’s declared scopes for every scope × category pair', () => {
    for (const category of USER_DATA_CATEGORIES) {
      for (const scope of ALL_SCOPES) {
        expect(scopeIncludes(scope, category), `scope=${scope} category=${category}`).toBe(
          apiScopeReaches(scope, category),
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

  it('Ask conversations are covered by "content" and "everything" only — never by a narrow scope (#376)', () => {
    for (const scope of ALL_SCOPES) {
      expect(scopeIncludes(scope, 'ask')).toBe(scope === 'content' || scope === 'everything');
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
      askConversations: { count: 4 },
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
