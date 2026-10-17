// =============================================================================
// GraphLayoutListener (#371, epic #347; docs/specs/ontology.md §22.3)
// =============================================================================
//
// The third — and only automatic — re-layout trigger: a MATERIAL change.
// Spec §22.3 forbids re-laying the whole graph on every commit, so on
// `graph.changed` this runs ONE cheap count and enqueues a delayed
// `kg.graph_layout` only when the readable entity count moved by ≥ 20 % from
// the latest snapshot's `node_count`:
//
//     |now − snap| / max(snap, 50) ≥ 0.2
//
// (the `max(…, 50)` floor keeps a tiny graph from re-laying on every new
// person). No snapshot at all is left to the overview GET's bootstrap, EXCEPT
// that a change is still a reason to have one — so "no snapshot and a
// non-empty graph" enqueues too.
//
// CLAUDE.md rule 1: ENQUEUE ONLY, never compute. the event port delivers
// without waiting for the emitting request, so the handler returns at once
// and the count runs detached with its own `.catch()` — a failure here can
// never fail the write that emitted the event.
// =============================================================================

import { Injectable, Logger, Inject, Optional, type OnModuleInit } from '@nestjs/common';

import { GRAPH_CHANGED_EVENT, type GraphChangedEvent } from '../graph-events.js';
import { GraphLayoutEnqueuer } from './graph-layout.enqueuer.js';
import { countReadableEntities } from './layout-source.js';
import { KVOX_EVENTS, KVOX_PRISMA, type KvoxEventsPort } from '../../ports/index.js';
import { GRAPH_MODULE_OPTIONS, type ResolvedGraphOptions } from '../graph.options.js';
import type { KvoxGraphDb } from '../data/graph-db.js';

/** Relative change in readable entities that counts as material. */
export const MATERIAL_CHANGE_RATIO = 0.2;

/** The denominator's floor, so a small graph does not re-lay constantly. */
export const MATERIAL_CHANGE_FLOOR = 50;

/** Pure: whether `current` entities differ materially from a snapshot of `snapshot`. */
export function isMaterialChange(snapshot: number, current: number, ratio: number = MATERIAL_CHANGE_RATIO): boolean {
  return Math.abs(current - snapshot) / Math.max(snapshot, MATERIAL_CHANGE_FLOOR) >= ratio;
}

@Injectable()
export class GraphLayoutListener implements OnModuleInit {
  private readonly logger = new Logger(GraphLayoutListener.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly enqueuer: GraphLayoutEnqueuer,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    @Optional() @Inject(GRAPH_MODULE_OPTIONS) private readonly options?: ResolvedGraphOptions,
  ) {}

  /** Subscribes to `graph.changed` on the event port when the module starts. */
  onModuleInit(): void {
    this.events.subscribe(GRAPH_CHANGED_EVENT, (payload) => this.handleGraphChanged(payload as GraphChangedEvent));
  }

  /** Returns synchronously in every case — see the header. */
  handleGraphChanged(event: GraphChangedEvent): void {
    try {
      void this.reconcile(event).catch((error: unknown) => {
        this.logger.warn(
          `Could not check the graph layout of user ${event.ownerId} after a ${event.reason}: ${describe(error)}`,
        );
      });
    } catch (error) {
      this.logger.warn(`Could not handle graph.changed for user ${event?.ownerId}: ${describe(error)}`);
    }
  }

  /** Exposed for tests: the awaited body. Returns whether it enqueued. */
  async reconcile(event: GraphChangedEvent): Promise<boolean> {
    const { ownerId } = event;
    const [latest, current] = await Promise.all([
      this.prisma.kgGraphLayout.findFirst({
        where: { ownerId },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
        select: { nodeCount: true },
      }),
      countReadableEntities(this.prisma, ownerId),
    ]);

    const material = latest ? isMaterialChange(latest.nodeCount, current, this.options?.layoutMaterialChange) : current > 0;
    if (!material) return false;

    const job = await this.enqueuer.scheduleAutomatic(ownerId);
    this.logger.log(
      `Material graph change for user ${ownerId} (${event.reason}): ${latest?.nodeCount ?? 'none'} → ${current} ` +
        `entities; kg.graph_layout job ${job.id}`,
    );
    return true;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
