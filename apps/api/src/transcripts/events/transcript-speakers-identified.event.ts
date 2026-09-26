// =============================================================================
// transcript.speakers_identified (#356, epic #344; docs/specs/ontology.md §8)
// =============================================================================
//
// Emitted by `TranscriptEditingService.identify()` AFTER an identification-only
// save has committed (#323's unversioned path), outside its transaction. The
// graph's `SpeakerIdentifiedListener` turns it into a `kg.speaker_link` job —
// the speaker-naming write into the owner's graph, §8's first named exception.
//
// The event carries ids only, never a name: the job re-reads the transcript's
// CURRENT `speaker_identities` rather than trusting a value frozen at emit
// time, which is what makes two queued runs converge on one end state.
//
// Lives in the transcripts module so it can be emitted without importing
// `GraphModule` — the dependency runs one way (graph → transcripts), so there
// is no cycle.
// =============================================================================

export const TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT = 'transcript.speakers_identified';

export class TranscriptSpeakersIdentifiedEvent {
  constructor(
    readonly transcriptId: string,
    readonly actorUserId: string,
    readonly speakerIds: string[],
  ) {}
}
