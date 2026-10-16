import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, type EventBus } from '@marinoscar/platform-api/host';
import type { KvoxEventsPort } from '@marinoscar/kvox-api/ports';

// =============================================================================
// PlatformKvoxEventsAdapter: the `KVOX_EVENTS` port over the platform event bus
// (issue #490, epic #486)
// =============================================================================
//
// `emit` publishes on the host core's bus and does not wait; a rejected publish is
// logged. `subscribe` listens on the bus; a listener that throws or rejects is logged.
//
// WHAT THE BUS ADDS TO "IN-PROCESS". With the `postgres` bus adapter an event reaches
// EVERY replica, the emitting one included, so a listener must be idempotent and only
// decide whether work is due and enqueue it (queue rule 1): the queue's dedup then
// collapses N replicas' enqueues into one job. Payloads are JSON and at most
// `EVENT_BUS_MAX_PAYLOAD_BYTES`; names are lower case and dotted
// (`EVENT_BUS_CHANNEL_PATTERN`), which `graph.changed` and
// `transcript.speakers_identified` already are.
// =============================================================================

@Injectable()
export class PlatformKvoxEventsAdapter implements KvoxEventsPort {
  private readonly logger = new Logger(PlatformKvoxEventsAdapter.name);

  constructor(@Inject(EVENT_BUS) private readonly bus: EventBus) {}

  emit(name: string, payload: unknown): void {
    try {
      void this.bus.publish(name, payload).catch((error: unknown) => {
        this.logger.warn(`Event ${name} was not published: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      this.logger.warn(`Event ${name} was not published: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  subscribe(name: string, handler: (payload: unknown) => Promise<void> | void): () => void {
    return this.bus.subscribe<unknown>(name, async (payload) => {
      try {
        await handler(payload);
      } catch (error) {
        this.logger.warn(`A listener of ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}
