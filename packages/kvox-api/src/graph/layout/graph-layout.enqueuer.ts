// =============================================================================
// GraphLayoutEnqueuer (#371, epic #347; docs/specs/ontology.md §22.3)
// =============================================================================
//
// The ONE place a `kg.graph_layout` job is enqueued. Three triggers, and only
// three (spec §22.3 — a whole-graph re-layout is never per-commit work):
//
//   refresh()           — manual, `POST /api/graph/overview/refresh`:
//                         `reason: 'rerun'`, no delay.
//   scheduleAutomatic() — the bootstrap first snapshot (the overview GET finds
//                         none for a non-empty graph) and the ≥ 20 % material
//                         change (`GraphLayoutListener`): `reason: 'backfill'`,
//                         `scheduledFor: now + 120 s`, so a burst of commits
//                         coalesces into one run.
//
// Subject `user`/ownerId and ORDINARY dedup (never `skipDedup`): at most one
// active layout job per owner, whoever asked.
// =============================================================================

import { Injectable, Inject, Optional } from '@nestjs/common';

import { KG_GRAPH_LAYOUT_JOB_TYPE, KG_SUBJECT_USER } from '../job-types.js';
import { KVOX_JOBS, type KvoxJobSnapshot, type KvoxJobsPort } from '../../ports/index.js';
import { DEFAULT_LAYOUT_COALESCE_MS, GRAPH_MODULE_OPTIONS, type ResolvedGraphOptions } from '../graph.options.js';

/** How long an automatic layout waits, so bursts coalesce. */
export const GRAPH_LAYOUT_COALESCE_MS = DEFAULT_LAYOUT_COALESCE_MS;

/**
 * What a manual refresh answers.
 *
 * @stability experimental
 */
export interface GraphLayoutRefreshResult {
  /** The job the request queued, or joined. */
  job: { id: string };
  /** The request joined a job already pending or running for this owner. */
  deduplicated: boolean;
}

/**
 * GraphLayoutEnqueuer: wiring the slice registers itself; a host configures it through `GraphModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphLayoutEnqueuer {
  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Optional() @Inject(GRAPH_MODULE_OPTIONS) private readonly options?: ResolvedGraphOptions,
  ) {}

  /** The owner's pending or running layout job, if any. */
  async findActive(ownerId: string): Promise<KvoxJobSnapshot | null> {
    const latest = await this.jobs.findLatest({
      type: KG_GRAPH_LAYOUT_JOB_TYPE,
      subjectType: KG_SUBJECT_USER,
      subjectId: ownerId,
    });

    return latest && (latest.status === 'pending' || latest.status === 'running') ? latest : null;
  }

  /**
   * Manual refresh. If it joins an automatic job still waiting out its
   * coalescing delay, that job is pulled forward to "now" — a person pressed
   * Refresh, and "no delay" is the manual trigger's contract.
   */
  async refresh(ownerId: string): Promise<GraphLayoutRefreshResult> {
    const before = await this.findActive(ownerId);
    const job = await this.jobs.enqueue({
      type: KG_GRAPH_LAYOUT_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_USER,
      subjectId: ownerId,
      payload: { ownerId },
    });
    const deduplicated = before !== null && before.id === job.id;

    if (deduplicated && before.status === 'pending' && before.scheduledFor && before.scheduledFor > new Date()) {
      await this.jobs.runNow(job.id);
    }

    return { job, deduplicated };
  }

  /** Bootstrap / material change: delayed, deduplicated per owner. */
  async scheduleAutomatic(ownerId: string, now: Date = new Date()): Promise<{ id: string }> {
    return this.jobs.enqueue({
      type: KG_GRAPH_LAYOUT_JOB_TYPE,
      reason: 'backfill',
      subjectType: KG_SUBJECT_USER,
      subjectId: ownerId,
      payload: { ownerId },
      scheduledFor: new Date(now.getTime() + (this.options?.layoutCoalesceMs ?? GRAPH_LAYOUT_COALESCE_MS)),
    });
  }
}
