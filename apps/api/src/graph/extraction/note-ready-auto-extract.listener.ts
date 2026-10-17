import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NOTE_READY_EVENT, type NoteReadyEvent } from '@marinoscar/kvox-api/notes';
import { KVOX_EVENTS, type KvoxEventsPort } from '@marinoscar/kvox-api/ports';

import { GraphExtractionService } from './graph-extraction.service';

// =============================================================================
// TEMPORARY: the hand-off from the notes slice's ready event to the graph (issue #495,
// epic #491). Delete this file in #496.
// =============================================================================
//
// `@marinoscar/kvox-api/notes` no longer knows the graph exists: after a note commits `ready`
// it publishes its ready event (`NOTE_READY_EVENT`) on `KVOX_EVENTS`. The graph module is still the
// application's until #496 moves it into the package, so this listener (it lives with the
// graph, the domain half of the hand-off, so the base code never imports the graph) subscribes and calls
// the same method the notes service used to call directly, with the same arguments, which is
// what keeps behaviour unchanged between the two pull requests:
//
//     GraphExtractionService.enqueueForReadyNote(noteId, ownerId)
//
// The gate (the deployment's graph switch, the owner's `graph:write`, their `autoExtract`
// preference and a resolvable task model) is inside that method, as it always was.
//
// IT ONLY ENQUEUES: the method creates the proposal and queues `kg.extract`, so the queue rule
// holds. A failure is logged and swallowed: the event port never propagates a listener's throw,
// and the note is already committed and `ready`.
// =============================================================================

@Injectable()
export class NoteReadyAutoExtractListener implements OnModuleInit {
  private readonly logger = new Logger(NoteReadyAutoExtractListener.name);

  constructor(
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    private readonly graphExtraction: GraphExtractionService,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(NOTE_READY_EVENT, async (payload) => {
      const { noteId, ownerId } = payload as NoteReadyEvent;

      try {
        await this.graphExtraction.enqueueForReadyNote(noteId, ownerId);
      } catch (error) {
        this.logger.warn(
          `Could not queue a graph extraction of note ${noteId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
}
