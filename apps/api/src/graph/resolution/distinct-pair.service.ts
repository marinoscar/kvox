// =============================================================================
// DistinctPairService (#364; docs/specs/ontology.md §7)
// =============================================================================
//
// The two ways resolution LEARNS, so one ambiguity is never re-litigated:
//
//   - a reviewer's "not the same" → a `kg_distinct_pairs` row; candidate
//     generation drops that pair forever after (`CandidateService`);
//   - an accepted link → the mention's label becomes an alias of the linked
//     entity (provenance `extraction`), so the next exact-alias arm finds it.
//
// Both take the caller's transaction: #366's commit calls them inside its own.
// The pair is stored canonically (`a_id < b_id`, `kg_distinct_pairs_order_chk`)
// and recording it twice is a no-op, never an error.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** The canonical order of an unordered pair. */
export function orderPair(a: string, b: string): [string, string] {
  // Lowercase first: Postgres orders uuids bytewise, which is lexicographic
  // order of the lowercase hex form — the same order the CHECK enforces.
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? [x, y] : [y, x];
}

@Injectable()
export class DistinctPairService {
  /** Record `a ≠ b`. Returns the canonical pair and whether it is new. */
  async record(tx: Tx, ownerId: string, a: string, b: string): Promise<{ aId: string; bId: string; created: boolean }> {
    const [aId, bId] = orderPair(a, b);
    const rows = await tx.$queryRaw<Array<{ a_id: string }>>`
      INSERT INTO kg_distinct_pairs (owner_id, a_id, b_id, created_at)
      VALUES (${ownerId}::uuid, ${aId}::uuid, ${bId}::uuid, now())
      ON CONFLICT DO NOTHING
      RETURNING a_id::text`;
    return { aId, bId, created: rows.length > 0 };
  }
}
