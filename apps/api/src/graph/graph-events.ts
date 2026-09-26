// =============================================================================
// Graph domain events (#371, epic #347; docs/specs/ontology.md §22.3)
// =============================================================================
//
// `graph.changed` is emitted AFTER a graph write has committed — never inside
// the transaction, so a listener can never observe (or act on) a rolled-back
// write. Listeners are bystanders: today the only one is
// `GraphLayoutListener`, which runs one cheap count and at most ENQUEUES a
// delayed `kg.graph_layout` (CLAUDE.md rule 1 — no computation in an event
// body).
//
// Constants and types only, no Nest imports, so any write path can emit it.
// =============================================================================

export const GRAPH_CHANGED_EVENT = 'graph.changed';

export type GraphChangedReason =
  | 'commit'
  | 'revert'
  | 'merge'
  | 'merge_reversed'
  | 'manual_edit'
  | 'purge'
  | 'import';

export interface GraphChangedEvent {
  ownerId: string;
  reason: GraphChangedReason;
}
