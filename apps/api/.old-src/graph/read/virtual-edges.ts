// =============================================================================
// Item-column ("virtual") edges, derived from the ontology registry (#370, #350)
// =============================================================================
//
// Every edge that touches an item is stored as a COLUMN on the `kg_items` row
// (`subject_id` → ABOUT, `owner_person_id` → ASSIGNED_TO, …), never as a
// `kg_relations` row. The read layer projects those columns into edges, and the
// list of projections is GENERATED from `ONTOLOGY.relationTypes()` — a relation
// type whose `representation` is `{ kind: 'item_column', column }` — so a new
// item-column relation in a domain module appears in every slice with no edit
// here. `meeting_id` backs two types (CREATED_IN for a Commitment, DECIDED_IN
// for a Decision), which is why each projection also carries the item kinds its
// `from` side names.
// =============================================================================

import { ONTOLOGY, type KgItemKind, type OntologyRegistry } from '@app/shared/ontology';

export type ItemColumn = 'subject_id' | 'owner_person_id' | 'counterparty_id' | 'meeting_id';

export interface ItemColumnEdge {
  /** The relation type key, e.g. `ABOUT`. */
  type: string;
  column: ItemColumn;
  /** The item kinds this edge starts from (the relation type's `from`, mapped to `kg_items.kind`). */
  kinds: KgItemKind[];
}

export function itemColumnEdges(registry: OntologyRegistry = ONTOLOGY): ItemColumnEdge[] {
  const out: ItemColumnEdge[] = [];
  for (const relation of registry.relationTypes()) {
    const rep = relation.representation;
    if (rep.kind !== 'item_column') continue;
    const kinds = [
      ...new Set(
        relation.from
          .map((key) => registry.entityType(key)?.itemKind)
          .filter((k): k is KgItemKind => k !== undefined),
      ),
    ].sort();
    if (kinds.length === 0) continue;
    out.push({ type: relation.key, column: rep.column, kinds });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type));
}

/** The projections for the shipped ontology, computed once. */
export const ITEM_COLUMN_EDGES: readonly ItemColumnEdge[] = Object.freeze(itemColumnEdges());

/** `virt:<itemId>:<TYPE>` — the id a derived edge carries in a slice. */
export function virtualEdgeId(itemId: string, type: string): string {
  return `virt:${itemId}:${type}`;
}
