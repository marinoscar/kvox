// =============================================================================
// GraphPreferencesListener (#364; docs/specs/ontology.md §7, §13)
// =============================================================================
//
// A changed auto-link or new threshold changes what every committed entity
// should be suggested as a duplicate of, so it queues ONE bulk re-scan —
// `kg.resolve` with `reason: 'threshold_change'`, `scope: 'all'`. It only
// ENQUEUES (CLAUDE.md "Every Long-Running Activity Is a Queue Job"): the event
// is dispatched synchronously inside the settings PATCH.
//
// Nothing else changes a threshold-driven outcome: a changed `mode` only
// changes the pre-check of future proposals, and a changed `adjudication`
// switch only changes future middle-band rows — neither enqueues.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { JobsService } from '../../../jobs/jobs.service';
import { KG_RESOLVE_JOB_TYPE, KG_SUBJECT_USER } from '../../job-types';
import {
  GRAPH_PREFERENCES_CHANGED_EVENT,
  type GraphPreferencesChangedEvent,
} from '../../preferences/graph-preferences.events';

@Injectable()
export class GraphPreferencesListener {
  private readonly logger = new Logger(GraphPreferencesListener.name);

  constructor(private readonly jobs: JobsService) {}

  @OnEvent(GRAPH_PREFERENCES_CHANGED_EVENT)
  async handlePreferencesChanged(event: GraphPreferencesChangedEvent): Promise<void> {
    if (!event.changed.includes('resolution')) return;
    const before = event.previous.resolution;
    const after = event.next.resolution;
    if (before.autoLinkThreshold === after.autoLinkThreshold && before.newThreshold === after.newThreshold) return;
    try {
      await this.jobs.enqueue({
        type: KG_RESOLVE_JOB_TYPE,
        reason: 'rerun',
        subjectType: KG_SUBJECT_USER,
        subjectId: event.userId,
        payload: { userId: event.userId, scope: 'all', reason: 'threshold_change' },
      });
    } catch (error) {
      this.logger.warn(
        `Could not enqueue ${KG_RESOLVE_JOB_TYPE} for user ${event.userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
