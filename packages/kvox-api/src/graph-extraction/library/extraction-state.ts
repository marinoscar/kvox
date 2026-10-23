// =============================================================================
// Which library notes still need a graph extraction (#716, epic #708)
// =============================================================================
//
// Pure: the reconcile job and the "retry extractions" action read the rows and ask
// this module what to do, so the rule is one function and the tests need no database.
// =============================================================================

/**
 * The proposal columns the rule reads.
 *
 * @stability experimental
 */
export interface ExtractionProposalFact {
  /** `kg_proposals.note_version`. */
  noteVersion: number | null;
  /** `kg_proposals.status`. */
  status: string;
}

/**
 * Where a note stands against the graph.
 *
 * - `running`: an extraction is in flight.
 * - `handled`: a draft, committed, reverted or discarded proposal already covers the current version.
 * - `failed`: the latest attempt at the current version failed.
 * - `up_to_date`: `extracted_version` already covers the current version.
 * - `pending`: the current version was never extracted.
 *
 * @stability experimental
 */
export type ExtractionState = 'running' | 'handled' | 'failed' | 'up_to_date' | 'pending';

/**
 * @param note - the note's current version and the file's `extracted_version`.
 * @param proposals - the note's extraction proposals (any version, any status).
 * @returns the note's state.
 */
export function extractionStateOf(
  note: { currentVersion: number; extractedVersion: number | null },
  proposals: readonly ExtractionProposalFact[],
): ExtractionState {
  if (proposals.some((p) => p.status === 'extracting')) return 'running';
  const current = proposals.filter((p) => p.noteVersion === note.currentVersion);
  if (current.some((p) => p.status !== 'failed')) return 'handled';
  if (current.length > 0) return 'failed';
  if ((note.extractedVersion ?? 0) >= note.currentVersion) return 'up_to_date';
  return 'pending';
}

/**
 * A library file joined to its note, as the reconcile reads it.
 *
 * @stability experimental
 */
export interface ReconcileFile {
  /** The file's note. */
  noteId: string;
  /** `note_library_files.extracted_version`. */
  extractedVersion: number | null;
}

/**
 * The notes a reconcile run selected.
 *
 * @stability experimental
 */
export interface ReconcileSelection {
  /** The note ids to queue. */
  noteIds: string[];
  /** True when more remained beyond the cap. */
  truncated: boolean;
}

/**
 * The notes a reconcile run queues: those in the `pending` state, each once, in the order given,
 * at most `cap`. A `failed` note is left for the explicit retry (a persistent failure such as a
 * bad key would otherwise be re-bought on every settled batch).
 *
 * @param files - the library files of the scope.
 * @param currentVersions - `notes.current_version` by note id (a missing or deleted note is absent).
 * @param proposalsByNote - the extraction proposals by note id.
 * @param cap - the most notes to return.
 * @returns the note ids, and whether more remained beyond the cap.
 */
export function selectReconcileNotes(
  files: readonly ReconcileFile[],
  currentVersions: ReadonlyMap<string, number>,
  proposalsByNote: ReadonlyMap<string, readonly ExtractionProposalFact[]>,
  cap: number,
): ReconcileSelection {
  const seen = new Set<string>();
  const noteIds: string[] = [];
  let truncated = false;
  for (const file of files) {
    if (seen.has(file.noteId)) continue;
    seen.add(file.noteId);
    const currentVersion = currentVersions.get(file.noteId);
    if (currentVersion === undefined) continue;
    const state = extractionStateOf(
      { currentVersion, extractedVersion: file.extractedVersion },
      proposalsByNote.get(file.noteId) ?? [],
    );
    if (state !== 'pending') continue;
    if (noteIds.length >= cap) {
      truncated = true;
      break;
    }
    noteIds.push(file.noteId);
  }
  return { noteIds, truncated };
}
