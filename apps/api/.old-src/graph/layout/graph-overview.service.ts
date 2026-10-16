// =============================================================================
// GraphOverviewService (#371, epic #347; docs/specs/ontology.md §15, §22.3)
// =============================================================================
//
// `GET /api/graph/overview` — READ ONLY. It reads the owner's latest stored
// snapshot and joins labels LIVE; it never recomputes (spec §22.3). It
// enqueues in exactly one case: there is no snapshot, the graph is non-empty,
// and no layout job is pending (the bootstrap first snapshot). A stale
// snapshot is REPORTED (`stale: true`), never refreshed — the user decides.
//
// ⚠ THE LIVE JOIN IS THE PRIVACY GUARANTEE (spec §15). The snapshot stores ids
// and coordinates only; every id is re-read against `kg_entities` under the
// readable, non-merged filter, and an id that no longer answers — merged,
// forgotten, deleted — is DROPPED: from `nodes`, from `memberSample`, and as a
// cluster's label source. A snapshot can therefore never resurrect a forgotten
// person's name, and forgetting needs no step of its own here.
//
// `POST /api/graph/overview/refresh` — queue a re-layout (`graph:write`).
// =============================================================================

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { READABLE_ENTITY_STATUSES } from '../read/readable';
import { UNCONNECTED_CLUSTER_ID } from './compute-layout';
import {
  OVERVIEW_MAX_NODES,
  type GraphOverviewRefreshResponse,
  type GraphOverviewResponse,
} from './dto/graph-overview.dto';
import { GraphLayoutEnqueuer } from './graph-layout.enqueuer';
import { countReadableEntities, readSourceUpdatedAt } from './layout-source';
import { storedClustersSchema, storedPositionsSchema } from './layout-snapshot';

export const UNCONNECTED_CLUSTER_LABEL = 'Unconnected';

/** The fallback name of cluster `id`. */
export function fallbackClusterLabel(id: number): string {
  return id === UNCONNECTED_CLUSTER_ID ? UNCONNECTED_CLUSTER_LABEL : `Cluster ${id + 1}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LiveEntity {
  id: string;
  label: string;
  type: string;
}

@Injectable()
export class GraphOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enqueuer: GraphLayoutEnqueuer,
  ) {}

  async overview(ownerId: string): Promise<GraphOverviewResponse> {
    const [latest, active] = await Promise.all([
      this.prisma.kgGraphLayout.findFirst({
        where: { ownerId },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      }),
      this.enqueuer.findActive(ownerId),
    ]);

    const clusters = latest ? storedClustersSchema.safeParse(latest.clusters) : null;
    const positions = latest ? storedPositionsSchema.safeParse(latest.positions) : null;

    if (!latest || !clusters?.success || !positions?.success) {
      // The bootstrap: the one case this GET enqueues.
      let pending = active !== null;
      if (!pending && (await countReadableEntities(this.prisma, ownerId)) > 0) {
        await this.enqueuer.scheduleAutomatic(ownerId);
        pending = true;
      }
      return emptyOverview(pending);
    }

    const current = await readSourceUpdatedAt(this.prisma, ownerId);
    const stale =
      current !== null && (latest.sourceUpdatedAt === null || current.getTime() > latest.sourceUpdatedAt.getTime());

    const snapshotClusters = clusters.data;
    const snapshotNodes = positions.data.nodes;

    const wanted = new Set<string>();
    for (const [id] of snapshotNodes) wanted.add(id);
    for (const c of snapshotClusters.items) {
      if (c.labelEntityId) wanted.add(c.labelEntityId);
      c.sampleIds.forEach((id) => wanted.add(id));
    }
    const live = await this.readLive(ownerId, [...wanted]);

    const degreeOf = new Map<string, number>(snapshotNodes.map((n) => [n[0], n[5]]));

    const liveNodes = snapshotNodes.filter(([id]) => live.has(id));
    const nodes = liveNodes.slice(0, OVERVIEW_MAX_NODES).map(([id, x, y, clusterId, , degree]) => {
      const entity = live.get(id) as LiveEntity;
      return { id, label: entity.label, type: entity.type, x, y, clusterId, degree };
    });

    return {
      status: 'ready',
      pending: active !== null,
      computedAt: latest.computedAt.toISOString(),
      stale,
      tooLarge: snapshotClusters.tooLarge,
      nodeCount: latest.nodeCount,
      edgeCount: latest.edgeCount,
      clusters: snapshotClusters.items.map((c) => {
        const labelEntity = c.labelEntityId ? live.get(c.labelEntityId) : undefined;
        return {
          id: c.id,
          label: labelEntity?.label ?? fallbackClusterLabel(c.id),
          labelEntityId: labelEntity ? labelEntity.id : null,
          size: c.size,
          x: c.x,
          y: c.y,
          radius: c.radius,
          typeCounts: c.typeCounts,
          memberSample: c.sampleIds
            .filter((id) => live.has(id))
            .slice(0, 8)
            .map((id) => {
              const entity = live.get(id) as LiveEntity;
              return { id, label: entity.label, type: entity.type, degree: degreeOf.get(id) ?? 0 };
            }),
        };
      }),
      clusterEdges: snapshotClusters.clusterEdges.slice(0, 500),
      nodes,
      nodesTruncated: liveNodes.length > OVERVIEW_MAX_NODES,
    };
  }

  async refresh(ownerId: string): Promise<GraphOverviewRefreshResponse> {
    const { job, deduplicated } = await this.enqueuer.refresh(ownerId);
    return { jobId: job.id, deduplicated };
  }

  /** The still-readable, non-merged entities among `ids`, owner-scoped. One statement. */
  private async readLive(ownerId: string, ids: string[]): Promise<Map<string, LiveEntity>> {
    // Stored ids are this server's own, but never trust a JSON blob into a `::uuid[]` cast.
    const valid = ids.filter((id) => UUID.test(id));
    if (valid.length === 0) return new Map();
    const statuses = [...READABLE_ENTITY_STATUSES] as string[];
    const rows = await this.prisma.$queryRaw<LiveEntity[]>`
      SELECT e.id::text AS id, e.label, e.type
        FROM kg_entities e
       WHERE e.owner_id = ${ownerId}::uuid
         AND e.id = ANY(${valid}::uuid[])
         AND e.review_status::text = ANY(${statuses}::text[])
         AND e.merged_into_id IS NULL`;
    return new Map(rows.map((r) => [r.id, r]));
  }
}

function emptyOverview(pending: boolean): GraphOverviewResponse {
  return {
    status: 'none',
    pending,
    computedAt: null,
    stale: false,
    tooLarge: false,
    nodeCount: 0,
    edgeCount: 0,
    clusters: [],
    clusterEdges: [],
    nodes: [],
    nodesTruncated: false,
  };
}
