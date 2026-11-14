// =============================================================================
// VoiceprintBackfillListener (#826, epic #820)
// =============================================================================
//
// `graph.preferences_changed` with `voiceprints.enabled` going false -> true queues ONE
// `kg.voiceprint_backfill` for the user. It ONLY ENQUEUES (queue rule 1) and is contained: a
// failure is logged and swallowed. Turning the setting off enqueues nothing and deletes
// nothing (that is the explicit DELETE route); the enrol and match handlers stop on their own.
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { KVOX_EVENTS, KVOX_JOBS, type KvoxEventsPort, type KvoxJobsPort } from '../../ports/index.js';
import { KG_SUBJECT_USER, KG_VOICEPRINT_BACKFILL_JOB_TYPE } from '../job-types.js';
import { GRAPH_PREFERENCES_CHANGED_EVENT, type GraphPreferencesChangedEvent } from '../preferences/graph-preferences.events.js';

@Injectable()
export class VoiceprintBackfillListener implements OnModuleInit {
  private readonly logger = new Logger(VoiceprintBackfillListener.name);

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(GRAPH_PREFERENCES_CHANGED_EVENT, (payload) =>
      this.handlePreferencesChanged(payload as GraphPreferencesChangedEvent),
    );
  }

  async handlePreferencesChanged(event: GraphPreferencesChangedEvent): Promise<void> {
    if (!event.changed.includes('voiceprints')) return;
    if (event.previous.voiceprints.enabled || !event.next.voiceprints.enabled) return;
    try {
      if (!this.jobs.isRegistered(KG_VOICEPRINT_BACKFILL_JOB_TYPE)) return;
      await this.jobs.enqueue({
        type: KG_VOICEPRINT_BACKFILL_JOB_TYPE,
        reason: 'rerun',
        subjectType: KG_SUBJECT_USER,
        subjectId: event.userId,
        payload: { ownerId: event.userId },
      });
    } catch (error) {
      this.logger.warn(
        `Could not enqueue ${KG_VOICEPRINT_BACKFILL_JOB_TYPE} for user ${event.userId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
