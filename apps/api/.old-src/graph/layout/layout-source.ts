// =============================================================================
// What the whole-graph layout reads (#371, epic #347; docs/specs/ontology.md §22)
// =============================================================================
//
// The handler, the overview GET and the material-change listener each ask a
// question of the owner's live graph; they ask it through THESE functions so
// the three can never disagree about what "the graph" or "changed" means:
//
//   readLayoutInput      — the handler's input: readable, non-merged entities;
//                          readable relations valid NOW with an entity on both
//                          ends (weight 1); item-derived entity–entity edges
//                          (weight 0.5), sensitive PersonFacts excluded.
//   readSourceUpdatedAt  — max(updated_at) over ALL the owner's kg_entities and
//                          kg_relations. Every status on purpose: a merge
//                          tombstones an entity (it leaves the readable set),
//                          and that is a change the snapshot must report as
//                          stale. The handler stamps it BEFORE reading the
//                          graph, so a write landing mid-run reads as stale.
//   countReadableEntities — the listener's one cheap count, and the GET's
//                          "is there anything to lay out" check.
//
// Owner-scoped in every statement; the status lists come from #370's
// `readable.ts`, the one definition every read surface imports.
// =============================================================================

import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { relationValidAtSql } from '../read/as-of';
import {
  READABLE_ENTITY_STATUSES,
  READABLE_ITEM_STATUSES,
  READABLE_RELATION_STATUSES,
} from '../read/readable';
import type { LayoutInput } from './compute-layout';

type Db = PrismaService | Prisma.TransactionClient;

/** Relation edges weigh 1; item-derived edges half that (issue #371). */
export const RELATION_EDGE_WEIGHT = 1;
export const ITEM_EDGE_WEIGHT = 0.5;

/** The item-derived pairs: subject–owner, subject–counterparty. */
export const ITEM_EDGE_PAIRS = [
  ['subject_id', 'owner_person_id'],
  ['subject_id', 'counterparty_id'],
] as const;

/** A PersonFact with this sensitivity never contributes an edge (spec §15). */
export const EXCLUDED_ITEM_SENSITIVITY = 'sensitive';

export async function readLayoutInput(db: Db, ownerId: string, now: Date): Promise<LayoutInput> {
  const nodes = await db.kgEntity.findMany({
    where: { ownerId, reviewStatus: { in: [...READABLE_ENTITY_STATUSES] }, mergedIntoId: null },
    select: { id: true, type: true },
    orderBy: { id: 'asc' },
  });

  const relationStatuses = [...READABLE_RELATION_STATUSES] as string[];
  const relations = await db.$queryRaw<Array<{ source: string; target: string }>>`
    SELECT r.from_id::text AS source, r.to_id::text AS target
      FROM kg_relations r
     WHERE r.owner_id = ${ownerId}::uuid
       AND r.from_id IS NOT NULL
       AND r.review_status::text = ANY(${relationStatuses}::text[])
       AND ${relationValidAtSql('r', now)}`;

  const itemStatuses = [...READABLE_ITEM_STATUSES] as string[];
  const items = await db.$queryRaw<Array<{ source: string; target: string }>>`
    SELECT i.subject_id::text AS source, i.owner_person_id::text AS target
      FROM kg_items i
     WHERE i.owner_id = ${ownerId}::uuid
       AND i.review_status::text = ANY(${itemStatuses}::text[])
       AND i.subject_id IS NOT NULL AND i.owner_person_id IS NOT NULL
       AND (i.sensitivity IS NULL OR i.sensitivity::text <> ${EXCLUDED_ITEM_SENSITIVITY})
    UNION ALL
    SELECT i.subject_id::text AS source, i.counterparty_id::text AS target
      FROM kg_items i
     WHERE i.owner_id = ${ownerId}::uuid
       AND i.review_status::text = ANY(${itemStatuses}::text[])
       AND i.subject_id IS NOT NULL AND i.counterparty_id IS NOT NULL
       AND (i.sensitivity IS NULL OR i.sensitivity::text <> ${EXCLUDED_ITEM_SENSITIVITY})`;

  return {
    nodes,
    edges: [
      ...relations.map((r) => ({ source: r.source, target: r.target, weight: RELATION_EDGE_WEIGHT })),
      ...items.map((r) => ({ source: r.source, target: r.target, weight: ITEM_EDGE_WEIGHT })),
    ],
  };
}

export async function readSourceUpdatedAt(db: Db, ownerId: string): Promise<Date | null> {
  const rows = await db.$queryRaw<Array<{ at: Date | null }>>`
    SELECT GREATEST(
             (SELECT max(e.updated_at) FROM kg_entities e WHERE e.owner_id = ${ownerId}::uuid),
             (SELECT max(r.updated_at) FROM kg_relations r WHERE r.owner_id = ${ownerId}::uuid)
           ) AS at`;
  return rows[0]?.at ?? null;
}

export async function countReadableEntities(db: Db, ownerId: string): Promise<number> {
  return db.kgEntity.count({
    where: { ownerId, reviewStatus: { in: [...READABLE_ENTITY_STATUSES] }, mergedIntoId: null },
  });
}
