// =============================================================================
// transcript.speakers_identified (#356, epic #344; docs/specs/ontology.md §8)
// =============================================================================
//
// Emitted by `TranscriptEditingService` AFTER any save that changes which name
// a speaker shows has committed, outside its transaction: an identification
// (#323's unversioned path), and — since #405 — a versioned batch (a rename of
// an already-named speaker, a clear back to the placeholder, a created or
// merged-away speaker) and a restore. The graph's `SpeakerIdentifiedListener`
// turns it into a `kg.speaker_link` job — the speaker-naming write into the
// owner's graph, §8's first named exception.
//
// The event carries ids only, never a name: the job re-reads the transcript's
// CURRENT effective speaker names rather than trusting a value frozen at emit
// time, which is what makes two queued runs converge on one end state.
//
// Lives in the transcripts module so it can be emitted without importing
// `GraphModule` — the dependency runs one way (graph → transcripts), so there
// is no cycle.
// =============================================================================

/**
 * The name of the event the slice emits (through the events port) after a speaker is named or
 * renamed. Persisted: never renamed.
 *
 * @stability experimental
 */
export const TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT = 'transcript.speakers_identified';

/**
 * The payload of {@link TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT}. The graph's listener re-reads the
 * current names itself, so the ids are informational.
 *
 * @stability experimental
 */
export class TranscriptSpeakersIdentifiedEvent {
  /**
   * @param transcriptId - the transcript.
   * @param actorUserId - who named the speakers.
   * @param speakerIds - the speakers whose names changed.
   */
  constructor(
    /** The transcript. */
    readonly transcriptId: string,
    /** Who named the speakers. */
    readonly actorUserId: string,
    /** The speakers whose names changed. */
    readonly speakerIds: string[],
  ) {}
}
