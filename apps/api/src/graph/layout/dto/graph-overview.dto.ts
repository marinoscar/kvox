import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Graph overview DTOs (#371, epic #347; docs/specs/ontology.md §12, §22.3)
// =============================================================================
//
// `GET /api/graph/overview` reads the latest stored `kg_graph_layouts`
// snapshot and joins labels LIVE; `POST /api/graph/overview/refresh` queues a
// re-layout. The contract #375 renders against (sigma.js over graphology).
// =============================================================================

/** Most positioned nodes one overview response carries (top by degree). */
export const OVERVIEW_MAX_NODES = 5000;

const memberSampleSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  type: z.string(),
  degree: z.number().int(),
});

const overviewClusterSchema = z.object({
  id: z.number().int().describe('Cluster id. `-1` is "Unconnected": every isolated entity, pooled.'),
  label: z
    .string()
    .describe('The live label of `labelEntityId`; else `Cluster <id + 1>`; `Unconnected` for `-1`.'),
  labelEntityId: z.uuid().nullable().describe('The entity the cluster is named after, when it is still readable.'),
  size: z.number().int().describe('Members at the time of the snapshot.'),
  x: z.number(),
  y: z.number(),
  radius: z.number(),
  typeCounts: z.record(z.string(), z.number().int()),
  memberSample: z
    .array(memberSampleSchema)
    .max(8)
    .describe('Up to 8 members by degree, dropping any since merged, forgotten or deleted.'),
});

const overviewNodeSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  type: z.string(),
  x: z.number(),
  y: z.number(),
  clusterId: z.number().int(),
  degree: z.number().int(),
});

export const graphOverviewResponseSchema = z
  .object({
    status: z.enum(['ready', 'none']).describe('`none`: no snapshot yet.'),
    pending: z.boolean().describe('A `kg.graph_layout` job is pending or running for you.'),
    computedAt: z.string().nullable().describe('When the snapshot was computed (ISO 8601).'),
    stale: z
      .boolean()
      .describe('Your graph changed after the snapshot read it. Reported, never auto-refreshed — use Refresh.'),
    tooLarge: z.boolean().describe('The graph exceeded the layout ceiling; no clusters or positions.'),
    nodeCount: z.number().int(),
    edgeCount: z.number().int(),
    clusters: z.array(overviewClusterSchema),
    clusterEdges: z
      .array(z.object({ a: z.number().int(), b: z.number().int(), weight: z.number() }))
      .max(500),
    nodes: z.array(overviewNodeSchema).max(OVERVIEW_MAX_NODES),
    nodesTruncated: z
      .boolean()
      .describe(`More positioned nodes exist than returned (the top ${OVERVIEW_MAX_NODES} by degree are).`),
  })
  .describe('The latest whole-graph layout snapshot, with labels read live.');

export type GraphOverviewResponse = z.infer<typeof graphOverviewResponseSchema>;
export class GraphOverviewResponseDto extends createZodDto(graphOverviewResponseSchema) {}

export const graphOverviewRefreshResponseSchema = z
  .object({
    jobId: z.string().describe('The `kg.graph_layout` job.'),
    deduplicated: z
      .boolean()
      .describe('`true` when a layout job was already pending or running for you; that job is returned.'),
  })
  .describe('The queued (or already queued) re-layout.');

export type GraphOverviewRefreshResponse = z.infer<typeof graphOverviewRefreshResponseSchema>;
export class GraphOverviewRefreshResponseDto extends createZodDto(graphOverviewRefreshResponseSchema) {}
