// =============================================================================
// The notes domain event as data (issue #495, epic #491)
// =============================================================================
//
// `kvox.notes.note_ready` is emitted on the host's event port AFTER the transaction that
// marks a note `ready` has committed. It is how the connected-knowledge graph learns that
// there is a note to extract from without the notes slice importing the graph. The name is
// permanent; the payload only grows.
// =============================================================================

/**
 * The event raised once a note has committed `ready`.
 *
 * @stability experimental
 */
export const NOTE_READY_EVENT = 'kvox.notes.note_ready';

/**
 * The payload of {@link NOTE_READY_EVENT}.
 *
 * @stability experimental
 */
export interface NoteReadyEvent {
  /** The note that became ready. */
  noteId: string;
  /** The note's owner. */
  ownerId: string;
  /** The version the generation committed. */
  version: number;
  /**
   * Where the note came from. Absent means `generation` (every event before epic #708).
   * `import` is one file imported by a person; `library` is one file of a note library
   * import batch.
   */
  origin?: 'generation' | 'import' | 'library';
  /**
   * True when the note is one of many created by a bulk import. A listener that spends
   * money per note (auto-extraction into the graph) should consult the library's
   * settings before acting on a bulk event.
   */
  bulk?: boolean;
}
