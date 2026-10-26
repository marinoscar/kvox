// =============================================================================
// Synonym term normalization (issue #767)
// =============================================================================
//
// PURE: no Prisma, no Nest. A group's `normalized` column is `normalizeAlias` of
// each term, the SAME form `kg_entity_aliases.normalized` holds, so a lookup
// compares like with like. Terms that collapse to the same normalized form are
// kept once (the first spelling wins); a term with no letter or digit is refused.
// =============================================================================

import { GraphValidationError } from '../write/graph-write.errors.js';
import { normalizeAlias } from '../write/normalize.js';

/** The caller's terms, de-duplicated by normalized form, in input order. */
export interface NormalizedSynonymTerms {
  /** The display forms, trimmed, as the caller wrote them. */
  terms: string[];
  /** The `normalizeAlias` form of each term, index-aligned with `terms`. */
  normalized: string[];
}

/**
 * Normalizes and de-duplicates `terms`.
 *
 * Throws `GraphValidationError` for a term that is empty once normalized; the
 * caller decides what too few distinct terms means (it is a separate 400).
 *
 * @stability experimental
 */
export function normalizeSynonymTerms(terms: readonly string[]): NormalizedSynonymTerms {
  const seen = new Set<string>();
  const out: NormalizedSynonymTerms = { terms: [], normalized: [] };
  for (const raw of terms) {
    const term = raw.trim();
    const n = normalizeAlias(term);
    if (seen.has(n)) continue;
    seen.add(n);
    out.terms.push(term);
    out.normalized.push(n);
  }
  return out;
}

/** A group applies to a mention of `type` when it has no type or the same one. */
export function groupAppliesToType(groupType: string | null, type: string): boolean {
  return groupType === null || groupType === type;
}

/** The synonyms of `names`, from `groups` (each `{ normalized, entityType }`), excluding `names` themselves. */
export function expandNamesWith(
  names: readonly string[],
  type: string,
  groups: ReadonlyArray<{ normalized: readonly string[]; entityType: string | null }>,
): string[] {
  const have = new Set(names);
  const extra = new Set<string>();
  for (const g of groups) {
    if (!groupAppliesToType(g.entityType, type)) continue;
    if (!g.normalized.some((n) => have.has(n))) continue;
    for (const n of g.normalized) if (!have.has(n)) extra.add(n);
  }
  return [...extra];
}
