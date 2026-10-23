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

/**
 * The graph changed event.
 *
 * @stability experimental
 */
export const GRAPH_CHANGED_EVENT = 'graph.changed';

/**
 * The graph changed reason type.
 *
 * @stability experimental
 */
export type GraphChangedReason =
  | 'commit'
  | 'revert'
  | 'merge'
  | 'merge_reversed'
  | 'manual_edit'
  | 'purge'
  | 'import';

/**
 * The graph changed event type.
 *
 * @stability experimental
 */
export interface GraphChangedEvent {
  /**
   * The owner id.
   */
  ownerId: string;
  /**
   * The reason.
   */
  reason: GraphChangedReason;
}

/**
 * Raised after an extraction proposal has committed to `draft` (#718, ADR-0007). The only
 * listener enqueues `kg.autocommit`; it never works inline.
 *
 * @stability experimental
 */
export const GRAPH_PROPOSAL_DRAFTED_EVENT = 'kvox.graph.proposal_drafted';

/**
 * The payload of {@link GRAPH_PROPOSAL_DRAFTED_EVENT}: identifiers only.
 *
 * @stability experimental
 */
export interface GraphProposalDraftedEvent {
  /** The proposal that became a draft. */
  proposalId: string;
  /** Its owner. */
  ownerId: string;
  /** The note it was extracted from. */
  noteId: string;
  /** The note version it covers. */
  noteVersion: number;
  /** The proposal kind; only `extraction` is emitted today. */
  kind: 'extraction';
}
