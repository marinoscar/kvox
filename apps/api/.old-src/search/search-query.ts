// =============================================================================
// Pure query-side helpers for `GET /api/search` (issue #175, epic #164)
// =============================================================================
//
// Everything in this file is a pure function over its arguments: no Prisma, no
// `@Injectable`, no clock, no randomness. That is what lets `search-query
// .spec.ts` pin the two decisions that are easiest to get subtly wrong — which
// types a caller asked for, and whether a query degrades — without a database.
//
// The stopword half deserves a word, because the naming is misleading if you
// only read the function signature. NOTHING HERE DECIDES WHAT A STOPWORD IS.
// Postgres's `english` text-search configuration owns that list, and asking
// TypeScript to keep a second copy of it would be a copy that drifts the first
// time an operator installs a different dictionary. So the service asks the
// database (`numnode(plainto_tsquery('english', $q))`) and this file only
// interprets the answer — see {@link isStopwordOnly}.
// =============================================================================

/** The two document kinds `GET /api/search` can return. */
export const SEARCH_TYPES = ['transcript', 'note'] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

/**
 * The `types` CSV, normalised — or `null` when it names something that is not
 * a searchable type.
 *
 * `null` rather than a throw so the caller (a Zod schema) decides the HTTP
 * shape of the refusal; a pure module that threw `BadRequestException` would
 * be a pure module that imported Nest.
 *
 * An ABSENT parameter means both types (the documented default). An EMPTY or
 * whitespace-only one is `null`, NOT "both": `?types=` is a client that built
 * a filter and got it wrong, and silently widening it to everything is the
 * opposite of what it asked for. Order is normalised to {@link SEARCH_TYPES}'
 * own order and duplicates collapse, so `note,transcript,note` and
 * `transcript,note` produce the same array — which matters because that array
 * is part of the cursor fingerprint.
 */
export function parseTypesParam(raw: string | undefined | null): SearchType[] | null {
  if (raw === undefined || raw === null) return [...SEARCH_TYPES];

  const tokens = raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return null;

  for (const token of tokens) {
    if (!(SEARCH_TYPES as readonly string[]).includes(token)) return null;
  }

  return SEARCH_TYPES.filter((type) => tokens.includes(type));
}

/**
 * Whether Postgres parsed the query into NOTHING, which is what an
 * all-stopword query ("the and of") does.
 *
 * `plainto_tsquery('english', 'the and of')` is the EMPTY tsquery, and the
 * empty tsquery matches no row anywhere — so the full-text path would answer a
 * perfectly reasonable-looking search with zero results and no explanation.
 * `numnode()` counts the nodes in the parsed query, so zero is exactly "there
 * was nothing left to search for", and the service degrades to the title
 * `ILIKE` behaviour the list endpoints already have (issue #175, epic #164's
 * success criterion).
 *
 * A `null`/`undefined`/non-finite count degrades TOO, deliberately: the safe
 * direction when we cannot tell what the parser produced is the path that
 * still returns the rows a user would recognise, not the path that silently
 * returns nothing.
 */
export function isStopwordOnly(numnode: number | null | undefined): boolean {
  if (numnode === null || numnode === undefined) return true;

  const parsed = typeof numnode === 'number' ? numnode : Number(numnode);

  if (!Number.isFinite(parsed)) return true;

  return parsed <= 0;
}

/**
 * The query text as the cursor fingerprint sees it.
 *
 * Leading/trailing space and runs of internal whitespace are not a different
 * search, so `"  pricing   model "` and `"pricing model"` must share a cursor
 * — otherwise a client that trims its input on page 2 but not page 1 gets a
 * 400 it cannot explain. Case is deliberately PRESERVED: it makes no
 * difference to `plainto_tsquery`, but it does to the degraded `ILIKE` path's
 * own `<mark>` placement, and a fingerprint that ignored it would let two
 * genuinely different degraded renderings share one cursor.
 */
export function normalizeQueryText(q: string): string {
  return q.trim().replace(/\s+/g, ' ');
}

/**
 * `q` as the middle of an `ILIKE` pattern, with the wildcards defused.
 *
 * ⚠ THIS IS NOT COSMETIC. `ILIKE` gives `%` and `_` their own meaning, so a
 * degraded search for the literal string `%` would match EVERY title the
 * caller can see, and `_` would match every one-character title — a user
 * typing punctuation into a search box would silently get the whole corpus
 * back. `\` is escaped first because it is the escape character itself; doing
 * it last would double-escape the two escapes this function just added.
 *
 * The value is still BOUND as a parameter by the caller. This function defuses
 * the pattern language, not SQL injection — the parameter binding does that,
 * and neither substitutes for the other.
 */
export function titleLikePattern(q: string): string {
  const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

  return `%${escaped}%`;
}
