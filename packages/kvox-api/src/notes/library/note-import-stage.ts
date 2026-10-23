import type {
  NoteImportBatchStatus,
  NoteImportItemStage,
  NoteImportItemStatus,
} from '@marinoscar/kvox-contract/notes';

// =============================================================================
// Derived batch item stage and batch status (issue #714, epic #708)
// =============================================================================
//
// PURE. The stage is never stored; it is read off the item and the graph proposal made
// from the note's version. `indexed` is not derived: the search index is not read here.
// =============================================================================

/**
 * The `kg_proposals.status` values the stage reads.
 *
 * @stability experimental
 */
export type ProposalStatusValue =
  | 'draft'
  | 'extracting'
  | 'committed'
  | 'discarded'
  | 'failed'
  | 'reverted';

/**
 * Where an item stands in the pipeline.
 *
 * `failed` item: `failed`. `queued`/`importing`: `uploaded`. `imported` without a proposal
 * (or a discarded/failed/reverted one): `parsed`. A proposal `extracting`: `extracting`;
 * `draft`: `extracted`; `committed`: `in_graph`. Statuses `missing` and `skipped` carry no
 * pipeline, so they read `parsed` only when a note exists, else `uploaded`.
 *
 * @param itemStatus - the item's status.
 * @param proposalStatus - the status of the proposal for the item's note version, if any.
 * @returns the stage.
 * @stability experimental
 */
export function deriveItemStage(
  itemStatus: NoteImportItemStatus,
  proposalStatus: ProposalStatusValue | string | null
): NoteImportItemStage {
  if (itemStatus === 'failed') return 'failed';
  if (itemStatus === 'queued' || itemStatus === 'importing') return 'uploaded';
  if (itemStatus !== 'imported') return 'uploaded';

  switch (proposalStatus) {
    case 'extracting':
      return 'extracting';
    case 'draft':
      return 'extracted';
    case 'committed':
      return 'in_graph';
    default:
      return 'parsed';
  }
}

/**
 * The status a batch should have given its item counts: still `running` while any item is
 * `queued` or `importing`, else `completed`, or `completed_with_errors` when any failed.
 * A `cancelled` batch stays cancelled.
 *
 * @param current - the batch's status now.
 * @param counts - item counts by status (missing keys count as zero).
 * @returns the status to store.
 * @stability experimental
 */
export function recomputeBatchStatus(
  current: NoteImportBatchStatus,
  counts: Partial<Record<NoteImportItemStatus, number>>
): NoteImportBatchStatus {
  if (current === 'cancelled') return current;
  if ((counts.queued ?? 0) + (counts.importing ?? 0) > 0) return 'running';
  return (counts.failed ?? 0) > 0 ? 'completed_with_errors' : 'completed';
}

/**
 * What {@link pickProposal} reads of a proposal.
 *
 * @stability experimental
 */
export interface PickableProposal {
  /** The note version the proposal covers. */
  noteVersion: number | null;
  /** When the proposal was created. */
  createdAt: Date;
}

/**
 * The proposal that speaks for an item: the newest one made from the item's note version,
 * else the newest one for the note.
 *
 * @param proposals - the proposals for the item's note.
 * @param noteVersion - the version the item wrote, if known.
 * @returns the chosen proposal, or `null` when there is none.
 * @stability experimental
 */
export function pickProposal<T extends PickableProposal>(
  proposals: readonly T[],
  noteVersion: number | null
): T | null {
  const newest = (list: readonly T[]): T | null =>
    list.reduce<T | null>(
      (best, p) => (best === null || p.createdAt > best.createdAt ? p : best),
      null
    );

  const matching =
    noteVersion === null ? [] : proposals.filter((p) => p.noteVersion === noteVersion);

  return newest(matching) ?? newest(proposals);
}
