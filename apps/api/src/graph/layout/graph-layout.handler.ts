// =============================================================================
// `kg.graph_layout` (#371, epic #347; docs/specs/ontology.md §11, §22.3)
// =============================================================================
//
// Reads the owner's committed graph, runs `computeLayout` (Louvain clusters +
// ForceAtlas2 positions, seeded, deterministic) and stores the result as a
// `kg_graph_layouts` snapshot that `GET /api/graph/overview` reads — the GET
// never recomputes (spec §22.3).
//
// Enqueued only by `GraphLayoutEnqueuer` (manual refresh, bootstrap first
// snapshot, ≥ 20 % material change), subject `user`/ownerId, payload
// `{ ownerId }`.
//
// -----------------------------------------------------------------------------
// ⚠ SERVER-ONLY — NO `nodeResultSchema`, NO `persistNodeResult`
// -----------------------------------------------------------------------------
//
// CLAUDE.md rule 2 makes node-eligibility the default, so opting out owes an
// argument: the input is the owner's ENTIRE private graph, read across
// `kg_entities`, `kg_relations` and `kg_items` at run time — rule 2's "reads
// several tables mid-computation" exception. Making it node-eligible would
// mean exporting that graph off the server as a blob purely to run a CPU job
// that takes seconds. Revisit only if measured runs exceed minutes (the run
// log below records `ms` for exactly that decision).
//
// No AI call: no throttle key, no user key, no `ai.graphEnabled` gate — it
// only reads committed data.
//
// -----------------------------------------------------------------------------
// PROFILE: `{ maxRuntimeMs: 15 min, maxAttempts: 2 }`
// -----------------------------------------------------------------------------
//
// A retry has no side effect anybody pays for (no vendor call, a derived
// cache), so one automatic retry is honest; fifteen minutes is far above the
// < 60 s a 10k-node / 40k-edge graph measures.
//
// -----------------------------------------------------------------------------
// RETENTION AND PRIVACY
// -----------------------------------------------------------------------------
//
// The new row is inserted and every row but the newest two for the owner is
// deleted IN THE SAME TRANSACTION. Rows store ids and coordinates only —
// never a label (spec §15): the overview joins labels live, so a renamed,
// merged or forgotten entity never shows a stale name from this cache.
//
// An EMPTY graph writes nothing and drops the owner's old snapshots: they
// describe a graph that no longer exists, and "no snapshot" is how the
// overview says "nothing to draw" (`status: 'none'`).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';
import { ONTOLOGY_VERSION } from '@app/shared/ontology';
import { z } from 'zod';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { KG_GRAPH_LAYOUT_JOB_TYPE } from '../job-types';
import { computeLayout } from './compute-layout';
import { readLayoutInput, readSourceUpdatedAt } from './layout-source';
import { toStoredClusters, toStoredPositions } from './layout-snapshot';
import { layoutSeed } from './seeded-rng';

export const KG_GRAPH_LAYOUT_PROFILE: JobExecutionProfile = {
  maxRuntimeMs: 15 * 60_000,
  maxAttempts: 2,
};

/** Snapshots kept per owner: the new one and the one before it. */
export const GRAPH_LAYOUT_RETAINED = 2;

const payloadSchema = z.object({ ownerId: z.uuid() });

export function readGraphLayoutPayload(payload: unknown): { ownerId: string } | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

@Injectable()
export class KgGraphLayoutHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(KgGraphLayoutHandler.name);

  readonly type = KG_GRAPH_LAYOUT_JOB_TYPE;

  readonly profile: JobExecutionProfile = KG_GRAPH_LAYOUT_PROFILE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = readGraphLayoutPayload(job.payload);
    if (!payload) {
      // No retry can make an unreadable payload readable.
      this.logger.warn(`kg.graph_layout job ${job.id} carries no readable payload; nothing to do`);
      return;
    }
    const { ownerId } = payload;
    const started = Date.now();
    const now = new Date();

    // Stamped BEFORE the reads: a write landing mid-run then reads as stale.
    const sourceUpdatedAt = await readSourceUpdatedAt(this.prisma, ownerId);
    const input = await readLayoutInput(this.prisma, ownerId, now);

    if (input.nodes.length === 0) {
      const { count } = await this.prisma.kgGraphLayout.deleteMany({ where: { ownerId } });
      this.logger.log(
        `kg.graph_layout ${JSON.stringify({ ownerId, nodeCount: 0, edgeCount: 0, dropped: count, ms: Date.now() - started })}`,
      );
      return;
    }

    const out = computeLayout(input, { seed: layoutSeed(ownerId, input.nodes.length, input.edges.length) });

    await this.prisma.$transaction(async (tx) => {
      await tx.kgGraphLayout.create({
        data: {
          ownerId,
          computedAt: new Date(),
          nodeCount: out.nodeCount,
          edgeCount: out.edgeCount,
          clusters: toStoredClusters(out) as unknown as Prisma.InputJsonValue,
          positions: toStoredPositions(out) as unknown as Prisma.InputJsonValue,
          ontologyVersion: ONTOLOGY_VERSION,
          sourceUpdatedAt,
        },
      });
      await this.pruneWithin(tx, ownerId);
    });

    // Ids and numbers only — never a label.
    this.logger.log(
      `kg.graph_layout ${JSON.stringify({
        ownerId,
        nodeCount: out.nodeCount,
        edgeCount: out.edgeCount,
        clusters: out.clusters.length,
        modularity: out.modularity,
        tooLarge: out.tooLarge,
        ms: Date.now() - started,
      })}`,
    );
  }

  /** Keep the newest `GRAPH_LAYOUT_RETAINED` rows of this owner; delete the rest. */
  async pruneWithin(tx: Prisma.TransactionClient, ownerId: string): Promise<number> {
    const keep = await tx.kgGraphLayout.findMany({
      where: { ownerId },
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      take: GRAPH_LAYOUT_RETAINED,
      select: { id: true },
    });
    const { count } = await tx.kgGraphLayout.deleteMany({
      where: { ownerId, id: { notIn: keep.map((k) => k.id) } },
    });
    return count;
  }
}
