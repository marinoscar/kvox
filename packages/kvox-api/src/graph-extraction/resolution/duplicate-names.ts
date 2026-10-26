// =============================================================================
// Duplicate name signals (issue #766)
// =============================================================================
//
// PURE: the name-only signals behind `GET /api/graph/duplicates`. No Prisma, no
// Nest, no clock; every function is deterministic. Inputs are NORMALIZED names
// (`normalizeAlias`), so the comparisons here never case-fold on their own.
//
//   name_contained  one name is a whole-word run inside the other
//                   ("oscar" in "oscar marin"; "al" is NOT in "alan")
//   initials        a short all-letter name is the initials of the other's words
//                   ("ey" / "ernst & young", "ibm" / "international business machines")
//   alias_match     two entities share one normalized name
//   similar_name    trigram similarity at or above `SIMILAR_NAME_THRESHOLD` (SQL)
//
// Design decisions, each pinned in `duplicate-names.spec.ts`:
//   - containment needs the shorter name to be at least `MIN_CONTAINED_CHARS`
//     long: "al" inside "al pacino" is noise, "oscar" inside "oscar marin" is not;
//   - a name made only of stopwords never matches;
//   - initials may drop the stopwords ("and", "&", "of", "the") or keep them
//     ("boa" / "bank of america").
// =============================================================================

export const DUPLICATE_STOPWORDS: ReadonlySet<string> = new Set(['and', '&', 'of', 'the']);
export const MIN_CONTAINED_CHARS = 3;
export const MIN_ACRONYM_CHARS = 2;
export const MAX_ACRONYM_CHARS = 6;
export const SIMILAR_NAME_THRESHOLD = 0.6;

export type NameReason = 'name_contained' | 'initials' | 'alias_match' | 'similar_name' | 'synonym';

/** Base score of each signal; extra signals add `EXTRA_REASON_BONUS` each, capped at 1. */
export const REASON_SCORES: Readonly<Record<NameReason | 'resolution_proposal', number>> = {
  alias_match: 0.95,
  name_contained: 0.8,
  initials: 0.75,
  similar_name: 0.6,
  synonym: 0.9,
  resolution_proposal: 0.7,
};
export const EXTRA_REASON_BONUS = 0.05;

/** Words of a normalized name: letters and digits only, `&` and punctuation are separators. */
export function nameTokens(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

/** Letters-only acronym candidate: `i.b.m` becomes `ibm`; anything else with a non-letter is not one. */
export function acronymOf(normalized: string): string | null {
  const compact = normalized.replace(/\./gu, '');
  if (!/^\p{L}+$/u.test(compact)) return null;
  const n = [...compact].length;
  return n >= MIN_ACRONYM_CHARS && n <= MAX_ACRONYM_CHARS ? compact : null;
}

/**
 * The initials a multi-word name can be abbreviated to: with the stopwords
 * dropped, and with them kept (only when they differ). Empty for a name of
 * fewer than two real words.
 */
export function initialsOf(normalized: string): string[] {
  const all = nameTokens(normalized);
  const words = all.filter((t) => !DUPLICATE_STOPWORDS.has(t));
  if (words.length < 2) return [];
  const first = (t: string) => [...t][0];
  const out = new Set<string>([words.map(first).join('')]);
  out.add(all.map(first).join(''));
  return [...out];
}

function isStopOnly(tokens: string[]): boolean {
  return tokens.every((t) => DUPLICATE_STOPWORDS.has(t));
}

/**
 * Whether the shorter name is a whole-word run of the longer one.
 * Returns `'prefix'` ("oscar" / "oscar marin"), `'inner'` ("marin" / "oscar marin"), or null.
 * Equal names are not containment (that is `alias_match`).
 */
export function containment(a: string, b: string): 'prefix' | 'inner' | null {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length === 0 || short.length === long.length || isStopOnly(short)) return null;
  if (short.join('').length < MIN_CONTAINED_CHARS) return null;
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((t, j) => long[i + j] === t)) return i === 0 ? 'prefix' : 'inner';
  }
  return null;
}

/** Whether one name is the initials of the other. */
export function initialsMatch(a: string, b: string): boolean {
  const accA = acronymOf(a);
  const accB = acronymOf(b);
  if (accA && initialsOf(b).includes(accA.replace(/\./gu, ''))) return true;
  if (accB && initialsOf(a).includes(accB.replace(/\./gu, ''))) return true;
  return false;
}

/**
 * Every name-only signal between two entities, each given as its normalized
 * names (label first, then aliases). `containment` and `initials` try every
 * name pairing; a pair of equal names is `alias_match`. Order is stable.
 */
export function nameReasons(namesA: readonly string[], namesB: readonly string[]): NameReason[] {
  const found = new Set<NameReason>();
  const setB = new Set(namesB);
  for (const a of namesA) {
    if (setB.has(a)) found.add('alias_match');
    for (const b of namesB) {
      if (a === b) continue;
      if (containment(a, b)) found.add('name_contained');
      if (initialsMatch(a, b)) found.add('initials');
    }
  }
  return ORDER.filter((r) => found.has(r));
}

const ORDER: readonly NameReason[] = ['alias_match', 'name_contained', 'initials', 'similar_name', 'synonym'];

/** The best base score, plus a small bonus per additional signal, capped at 1 and rounded to 2 places. */
export function duplicateScore(reasons: readonly (NameReason | 'resolution_proposal')[], base?: number): number {
  const unique = [...new Set(reasons)];
  if (unique.length === 0) return 0;
  const scores = unique.map((r) => REASON_SCORES[r]);
  const best = Math.max(...scores, base ?? 0);
  const score = Math.min(1, best + EXTRA_REASON_BONUS * (unique.length - 1));
  return Math.round(score * 100) / 100;
}

/** The two-word sort key of an unordered pair of ids. */
export function pairKey(a: string, b: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

// -----------------------------------------------------------------------------
// The bounded all-pairs pass
// -----------------------------------------------------------------------------

/** Most entities the name pass looks at in one call (the same bound `kg.resolve` uses). */
export const NAME_PASS_MAX_ENTITIES = 2_000;
/** A token, acronym or name shared by more entities than this is too common to say anything and is skipped. */
export const MAX_POSTINGS = 50;

export interface NamedEntity {
  id: string;
  type: string;
  /** Normalized names: the label first, then the aliases. */
  names: readonly string[];
}

export interface NamePair {
  aId: string;
  bId: string;
  reasons: NameReason[];
}

/**
 * Name-only duplicate pairs among `entities`, same type only.
 *
 * Cost: never the quadratic all-pairs. Entities are indexed by whole name, by
 * word and by initials; only entities that share an index entry are compared, and
 * an entry shared by more than {@link MAX_POSTINGS} entities is skipped. That is
 * O(n · names · words · MAX_POSTINGS) at worst, so with the caller's
 * {@link NAME_PASS_MAX_ENTITIES} bound the pass stays in the millions of cheap
 * string comparisons.
 */
export function findNamePairs(entities: readonly NamedEntity[]): NamePair[] {
  const byType = new Map<string, NamedEntity[]>();
  for (const e of entities) {
    const list = byType.get(e.type);
    if (list) list.push(e);
    else byType.set(e.type, [e]);
  }
  const out: NamePair[] = [];
  for (const group of byType.values()) {
    const byName = new Map<string, number[]>();
    const byToken = new Map<string, number[]>();
    const byInitials = new Map<string, number[]>();
    const add = (map: Map<string, number[]>, key: string, i: number) => {
      const list = map.get(key);
      if (!list) map.set(key, [i]);
      else if (list[list.length - 1] !== i) list.push(i);
    };
    group.forEach((e, i) => {
      for (const name of e.names) {
        add(byName, name, i);
        for (const t of nameTokens(name)) if (!DUPLICATE_STOPWORDS.has(t)) add(byToken, t, i);
        for (const ini of initialsOf(name)) add(byInitials, ini, i);
      }
    });

    const seen = new Set<string>();
    const consider = (i: number, j: number) => {
      if (i === j) return;
      const [lo, hi] = i < j ? [i, j] : [j, i];
      const key = `${lo}:${hi}`;
      if (seen.has(key)) return;
      seen.add(key);
      const a = group[lo];
      const b = group[hi];
      const reasons = nameReasons(a.names, b.names);
      if (reasons.length > 0) out.push({ aId: a.id, bId: b.id, reasons });
    };
    const fan = (i: number, list: number[] | undefined) => {
      if (!list || list.length > MAX_POSTINGS) return;
      for (const j of list) consider(i, j);
    };

    group.forEach((e, i) => {
      for (const name of e.names) {
        fan(i, byName.get(name));
        for (const t of nameTokens(name)) fan(i, byToken.get(t));
        const acr = acronymOf(name);
        if (acr) fan(i, byInitials.get(acr));
      }
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Personal synonym dictionary (issue #767)
// -----------------------------------------------------------------------------

export interface SynonymGroupNames {
  /** Normalized terms of the group. */
  normalized: readonly string[];
  /** The entity type the group is limited to, or null for every type. */
  entityType: string | null;
}

/**
 * Pairs of same-type entities whose names fall in one synonym group (reason
 * `synonym`). Entities are indexed per group, so the cost is linear in the
 * entities; a group matched by more than {@link MAX_POSTINGS} entities is too
 * common to say anything and is skipped.
 */
export function findSynonymPairs(entities: readonly NamedEntity[], groups: readonly SynonymGroupNames[]): NamePair[] {
  const out: NamePair[] = [];
  for (const g of groups) {
    const terms = new Set(g.normalized);
    const byType = new Map<string, NamedEntity[]>();
    for (const e of entities) {
      if (g.entityType !== null && g.entityType !== e.type) continue;
      if (!e.names.some((n) => terms.has(n))) continue;
      const list = byType.get(e.type);
      if (list) list.push(e);
      else byType.set(e.type, [e]);
    }
    for (const list of byType.values()) {
      if (list.length < 2 || list.length > MAX_POSTINGS) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) out.push({ aId: list[i].id, bId: list[j].id, reasons: ['synonym'] });
      }
    }
  }
  return out;
}
