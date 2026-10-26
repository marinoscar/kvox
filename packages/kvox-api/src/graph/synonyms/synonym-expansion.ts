// =============================================================================
// Synonym expansion (issue #767)
// =============================================================================
//
// One indexed query (`kg_synonyms_normalized_gin_idx`, `normalized && names`)
// answers "which of this owner's synonym groups contain one of these names".
// Resolution, search and the duplicates pass all go through here so the rule
// (same owner; `entity_type` null or equal) is written once.
// =============================================================================

import type { KvoxGraphDb, KvoxGraphTx } from '../data/graph-db.js';
import { expandNamesWith } from './synonym-terms.js';

/** At most this many extra names are added to one lookup. */
export const MAX_SYNONYM_EXPANSION = 10;

/** A graph database handle or an open transaction; synonym lookups run on either. */
export type SynonymDb = KvoxGraphDb | KvoxGraphTx;

/**
 * The normalized synonyms of `names` for `ownerId`: every other term of every
 * group (entity type null, or `type` when given) that contains one of them.
 * Empty when `names` is empty or the owner has no matching group.
 *
 * @param limit - cap on the extra names (default none).
 * @stability experimental
 */
export async function expandWithSynonyms(
  db: SynonymDb,
  ownerId: string,
  names: readonly string[],
  type: string | null,
  limit?: number,
): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ normalized: string[]; entity_type: string | null }>>`
    SELECT normalized, entity_type
      FROM kg_synonyms
     WHERE owner_id = ${ownerId}::uuid
       AND normalized && ${[...names]}::text[]
       AND (${type}::text IS NULL OR entity_type IS NULL OR entity_type = ${type}::text)`;
  const extra = expandNamesWith(
    names,
    type ?? '',
    rows.map((r) => ({ normalized: r.normalized, entityType: type === null ? null : r.entity_type })),
  );
  return limit === undefined ? extra : extra.slice(0, limit);
}
