import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { NOTE_READY_EVENT, type NoteReadyEvent } from '../../notes/index.js';
import { KVOX_EVENTS, type KvoxEventsPort } from '../../ports/index.js';
import { GraphExtractionService } from './graph-extraction.service.js';

// =============================================================================
// The hand-off from a ready note to the graph (issue #496, epic #491)
// =============================================================================
//
// `@marinoscar/kvox-api/notes` does not know the graph exists: after a note commits `ready`
// it publishes `kvox.notes.note_ready` (`NOTE_READY_EVENT`) on the event port. This slice
// subscribes in `onModuleInit` and calls
//
//     GraphExtractionService.enqueueForReadyNote(noteId, ownerId)
//
// which holds the gate: the deployment's graph switch, the owner's `graph:write`, their
// `extraction.autoExtract` preference and a resolvable task model. It replaces the
// application's temporary listener of #495.
//
// IT ONLY ENQUEUES: the method creates the proposal and queues `kg.extract`, so the queue
// rule holds. A failure is logged and swallowed: the event port never propagates a
// listener's throw, and the note is already committed and `ready`. Provided only while
// `autoExtract` is not false.
// =============================================================================

/**
 * NoteReadyExtractionSubscriber: wiring the slice registers itself; a host configures it through `GraphExtractionModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteReadyExtractionSubscriber implements OnModuleInit {
  private readonly logger = new Logger(NoteReadyExtractionSubscriber.name);

  constructor(
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    private readonly extraction: GraphExtractionService,
  ) {}

  /** Subscribes to `kvox.notes.note_ready` on the event port when the module starts. */
  onModuleInit(): void {
    this.events.subscribe(NOTE_READY_EVENT, async (payload) => {
      const { noteId, ownerId, bulk, origin } = payload as NoteReadyEvent;

      try {
        await this.extraction.enqueueForReadyNote(noteId, ownerId, {
          ...(bulk !== undefined ? { bulk } : {}),
          ...(origin !== undefined ? { origin } : {}),
        });
      } catch (error) {
        this.logger.warn(
          `Could not queue a graph extraction of note ${noteId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
}
