import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KVOX_EVENTS, type KvoxEventsPort } from '@marinoscar/kvox-api/ports';
import { TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT } from '@marinoscar/kvox-api/transcripts';

// =============================================================================
// The hand-off from the transcripts slice's event port to the application's `@OnEvent`
// listeners (issue #493, epic #491)
// =============================================================================
//
// `@marinoscar/kvox-api/transcripts` publishes `transcript.speakers_identified` through
// `KVOX_EVENTS` (after the naming commits), which the web edition binds to the platform
// event bus. The graph module (still the application's until #496) listens with Nest's
// `@OnEvent`, on `EventEmitter2`. This bridge forwards the one event from the first to the
// second, so graph is unchanged by the move; when graph moves into the package it
// subscribes to `KVOX_EVENTS` itself and this file goes.
//
// IT FORWARDS AND DOES NOTHING ELSE: the listener (`graph/listeners/speaker-identified.
// listener.ts`) only enqueues, per the queue rule.
// =============================================================================

@Injectable()
export class TranscriptEventsBridge implements OnModuleInit {
  private readonly logger = new Logger(TranscriptEventsBridge.name);

  constructor(
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT, (payload) => {
      try {
        this.emitter.emit(TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT, payload);
      } catch (error) {
        this.logger.warn(
          `Could not forward ${TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
}
