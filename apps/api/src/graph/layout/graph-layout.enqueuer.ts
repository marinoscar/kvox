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

import { Injectable } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { KG_GRAPH_LAYOUT_JOB_TYPE, KG_SUBJECT_USER } from '../job-types';

/** How long an automatic layout waits, so bursts coalesce. */
export const GRAPH_LAYOUT_COALESCE_MS = 120_000;

export interface GraphLayoutRefreshResult {
  job: Job;
  /** The request joined a job already pending or running for this owner. */
  deduplicated: boolean;
}

@Injectable()
export class GraphLayoutEnqueuer {
  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  /** The owner's pending or running layout job, if any. */
  async findActive(ownerId: string): Promise<Job | null> {
    return this.prisma.job.findFirst({
      where: {
        type: KG_GRAPH_LAYOUT_JOB_TYPE,
        subjectType: KG_SUBJECT_USER,
        subjectId: ownerId,
        status: { in: ['pending', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });
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

    if (deduplicated && job.status === 'pending' && job.scheduledFor && job.scheduledFor > new Date()) {
      await this.prisma.job.updateMany({
        where: { id: job.id, status: 'pending' },
        data: { scheduledFor: null },
      });
    }

    return { job, deduplicated };
  }

  /** Bootstrap / material change: delayed, deduplicated per owner. */
  async scheduleAutomatic(ownerId: string, now: Date = new Date()): Promise<Job> {
    return this.jobs.enqueue({
      type: KG_GRAPH_LAYOUT_JOB_TYPE,
      reason: 'backfill',
      subjectType: KG_SUBJECT_USER,
      subjectId: ownerId,
      payload: { ownerId },
      scheduledFor: new Date(now.getTime() + GRAPH_LAYOUT_COALESCE_MS),
    });
  }
}
