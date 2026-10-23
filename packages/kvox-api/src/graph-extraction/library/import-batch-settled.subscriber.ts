import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { NOTE_IMPORT_BATCH_SETTLED_EVENT, type NoteImportBatchSettledEvent } from '@marinoscar/kvox-contract/notes';

import { KVOX_EVENTS, type KvoxEventsPort } from '../../ports/index.js';
import { GraphReconcileEnqueuer } from './graph-reconcile.enqueuer.js';

/**
 * Answers `kvox.notes.import_batch_settled` by queueing a reconcile of the owner's library
 * notes (#716). IT ONLY ENQUEUES.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class ImportBatchSettledSubscriber implements OnModuleInit {
  private readonly logger = new Logger(ImportBatchSettledSubscriber.name);

  constructor(
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    private readonly reconcile: GraphReconcileEnqueuer,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(NOTE_IMPORT_BATCH_SETTLED_EVENT, async (payload) => {
      const { batchId, ownerId, libraryId } = payload as NoteImportBatchSettledEvent;
      try {
        await this.reconcile.enqueue({ ownerId, batchId, ...(libraryId ? { libraryId } : {}) });
      } catch (error) {
        this.logger.warn(
          `Could not queue a library reconcile for batch ${batchId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
}
