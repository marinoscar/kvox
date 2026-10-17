// =============================================================================
// SpeakerIdentifiedListener (#356, epic #344; docs/specs/ontology.md §8)
// =============================================================================
//
// The bridge between "a speaker was named" and "the owner's graph links it".
//
// ⚠ IT ONLY ENQUEUES (CLAUDE.md "Every Long-Running Activity Is a Queue Job",
// rule 1: "an event-listener body that ... does work inline" is a violation). The
// graph write is `kg.speaker_link`, with its own retry and a row in the admin
// job list.
//
// `skipDedup: true` IS DELIBERATE. The handler reconciles the transcript's
// CURRENT identities, so two queued runs are harmless — while dedup against a
// `running` job would drop a naming saved mid-read, leaving the graph one
// naming behind with no error anywhere (the same failure class as
// `transcription.poll`'s documented pitfall).
//
// CONTAINED: an enqueue failure is logged at `warn` and swallowed. Naming must
// never fail because the graph could not be queued.
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT,
  TranscriptSpeakersIdentifiedEvent,
} from '../../transcripts/index.js';
import { KG_SPEAKER_LINK_JOB_TYPE, KG_SUBJECT_TRANSCRIPT } from '../job-types.js';
import { KVOX_EVENTS, KVOX_JOBS, type KvoxEventsPort, type KvoxJobsPort } from '../../ports/index.js';

@Injectable()
export class SpeakerIdentifiedListener implements OnModuleInit {
  private readonly logger = new Logger(SpeakerIdentifiedListener.name);

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
  ) {}

  /** Subscribes to the transcripts slice's naming event on the event port when the module starts. */
  onModuleInit(): void {
    this.events.subscribe(TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT, (payload) =>
      this.handleSpeakersIdentified(payload as TranscriptSpeakersIdentifiedEvent),
    );
  }

  async handleSpeakersIdentified(event: TranscriptSpeakersIdentifiedEvent): Promise<void> {
    try {
      await this.jobs.enqueue({
        type: KG_SPEAKER_LINK_JOB_TYPE,
        reason: 'rerun',
        subjectType: KG_SUBJECT_TRANSCRIPT,
        subjectId: event.transcriptId,
        payload: { transcriptId: event.transcriptId, actorUserId: event.actorUserId },
        skipDedup: true,
      });
    } catch (error) {
      this.logger.warn(
        `Could not enqueue ${KG_SPEAKER_LINK_JOB_TYPE} for transcript ${event.transcriptId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
