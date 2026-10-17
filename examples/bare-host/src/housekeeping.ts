import type { INestApplicationContext, Type } from '@nestjs/common';

import { KgMigrateEnqueuer } from '@marinoscar/kvox-api/graph';
import { KgExportExpiryEnqueuer } from '@marinoscar/kvox-api/graph-rdf';
import { NotesHousekeepingEnqueuer } from '@marinoscar/kvox-api/notes';
import { TranscriptsHousekeepingEnqueuer } from '@marinoscar/kvox-api/transcripts';

// =============================================================================
// The host's housekeeping timer (what `@nestjs/schedule` would have done)
// =============================================================================
//
// Every slice is booted with `schedules: false`, so no cron is registered and
// `@nestjs/schedule` is not installed. Each slice still PROVIDES its enqueuer
// (and exports it from its module), and a cron only ever enqueues, so the host's
// whole duty is to call them on a timer:
//
//   TranscriptsHousekeepingEnqueuer   `transcripts.housekeeping` (retention sweeps)
//   NotesHousekeepingEnqueuer         `notes.housekeeping`
//   KgMigrateEnqueuer                 `kg.migrate`, one job per owner whose rows a
//                                     declared ontology migration touches; returns
//                                     at once while none is declared (#566)
//   KgExportExpiryEnqueuer            the `kg.export` expiry sweep
//
// The classes are resolved from the container with `strict: false` (they live
// in the slices' modules, not the root). `runOnce()` is what a test calls; the
// hourly timer is `start()`, which `startBareHost` runs only when
// `backgroundJobs` is on, so a test never races it.
// =============================================================================

/** What one tick queued, per enqueuer (`null` when it had nothing to queue or returns nothing). */
export interface HousekeepingTick {
  transcripts: string | null;
  notes: string | null;
  kgMigrate: 'called';
  kgExportExpiry: 'called';
}

/** The hourly housekeeping of the bare host. */
export class HostHousekeeping {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  /**
   * @param app - the initialised application the enqueuers are resolved from.
   * @param intervalMs - the tick, default one hour.
   * @param log - receives a line per failed tick.
   */
  constructor(
    private readonly app: INestApplicationContext,
    private readonly intervalMs = 60 * 60 * 1000,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Calls every enqueuer once, in order. Each only inserts job rows; the jobs port runs them. */
  async runOnce(): Promise<HousekeepingTick> {
    const get = <T>(type: Type<T>): T => this.app.get(type, { strict: false });
    const transcripts = await get(TranscriptsHousekeepingEnqueuer).enqueue();
    const notes = await get(NotesHousekeepingEnqueuer).enqueue();
    await get(KgMigrateEnqueuer).enqueue();
    await get(KgExportExpiryEnqueuer).enqueue();
    return { transcripts, notes, kgMigrate: 'called', kgExportExpiry: 'called' };
  }

  /** Starts the timer (no tick at start: the first one is an interval away). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.runOnce()
        .catch((error: unknown) => this.log(`housekeeping tick failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.running = null;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Stops the timer and waits for a tick in flight. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
