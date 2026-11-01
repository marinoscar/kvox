import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { NOTE_IMPORT_BATCH_SETTLED_EVENT, type NoteImportBatchSettledEvent } from '@marinoscar/kvox-contract/notes';

import { GRAPH_CHANGED_EVENT, GRAPH_PROPOSAL_DRAFTED_EVENT } from '../graph/index.js';
import type { GraphChangedEvent, GraphProposalDraftedEvent } from '../graph/index.js';
import { TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT, type TranscriptSpeakersIdentifiedEvent } from '../transcripts/index.js';
import { KVOX_EVENTS, KVOX_JOBS, type KvoxEventsPort, type KvoxJobsPort } from '../ports/index.js';
import { KVOX_WEBHOOK_EMIT_JOB_TYPE } from './job-types.js';
import {
  KVOX_WEBHOOK_GRAPH_COMMITTED,
  KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED,
  KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED,
  KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED,
} from './webhook-events.js';
import type { WebhookEmitPayload } from './webhook-emit.payload.js';

/**
 * Turns four in-process domain events into `kvox.webhook_emit` jobs. IT ONLY ENQUEUES: the job
 * reads any counts it needs and calls `KVOX_WEBHOOKS`; this body does no other I/O and never
 * throws into the emitter. Payloads carry ids and counts, never content.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class WebhookEventsListener implements OnModuleInit {
  private readonly logger = new Logger(WebhookEventsListener.name);

  constructor(
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(GRAPH_PROPOSAL_DRAFTED_EVENT, (payload) => {
      const e = payload as GraphProposalDraftedEvent;
      return this.enqueue(KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED, e.ownerId, {
        proposalId: e.proposalId,
        noteId: e.noteId,
        noteVersion: e.noteVersion,
      });
    });

    this.events.subscribe(GRAPH_CHANGED_EVENT, (payload) => {
      const e = payload as GraphChangedEvent;
      // Only a proposal commit; revert, merge, manual edit, purge and import are not webhooks.
      if (e.reason !== 'commit' || !e.proposalId || !e.counts) return;
      return this.enqueue(KVOX_WEBHOOK_GRAPH_COMMITTED, e.ownerId, {
        proposalId: e.proposalId,
        entitiesCreated: e.counts.entitiesCreated,
        relationsCreated: e.counts.relationsCreated,
        entitiesLinked: e.counts.entitiesLinked,
      });
    });

    this.events.subscribe(NOTE_IMPORT_BATCH_SETTLED_EVENT, (payload) => {
      const e = payload as NoteImportBatchSettledEvent;
      return this.enqueue(KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED, e.ownerId, {
        batchId: e.batchId,
        libraryId: e.libraryId,
      });
    });

    this.events.subscribe(TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT, (payload) => {
      const e = payload as TranscriptSpeakersIdentifiedEvent;
      return this.enqueue(KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED, e.actorUserId, {
        transcriptId: e.transcriptId,
        speakerCount: e.speakerIds.length,
      });
    });
  }

  private async enqueue(eventKey: string, userId: string, refs: WebhookEmitPayload['refs']): Promise<void> {
    try {
      await this.jobs.enqueue({
        type: KVOX_WEBHOOK_EMIT_JOB_TYPE,
        reason: 'upload',
        subjectType: 'user',
        subjectId: userId,
        // Two commits are two events: never collapse them.
        skipDedup: true,
        payload: { eventKey, userId, refs } satisfies WebhookEmitPayload,
      });
    } catch (error) {
      this.logger.warn(`Could not queue webhook ${eventKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
