// =============================================================================
// transcript.ready (#825; docs/specs/ontology.md §8)
// =============================================================================
//
// Emitted through the events port AFTER a transcript becomes readable for the
// first time (an ingest committed, or an imported file was saved), outside any
// transaction. Ids only: a listener re-reads whatever it needs. It is named
// apart from the notification key `TRANSCRIPT_READY_EVENT`, which is an email /
// bell event and not a bus event.
//
// The graph's voiceprint listener turns it into a `kg.voice_match` job.
// =============================================================================

/**
 * The bus event name emitted when a transcript first becomes ready. Persisted: never renamed.
 *
 * @stability experimental
 */
export const TRANSCRIPT_READY_BUS_EVENT = 'transcript.ready';

/**
 * The payload of {@link TRANSCRIPT_READY_BUS_EVENT}: ids only.
 *
 * @stability experimental
 */
export class TranscriptReadyBusEvent {
  /**
   * @param transcriptId - the transcript that became ready.
   * @param ownerId - its owner.
   */
  constructor(
    /** The transcript that became ready. */
    readonly transcriptId: string,
    /** Its owner. */
    readonly ownerId: string,
  ) {}
}
