import { z } from 'zod';

// =============================================================================
// Graph overview DTOs (#371, epic #347; docs/specs/ontology.md §12, §22.3)
// =============================================================================
//
// `GET /api/graph/overview` reads the latest stored `kg_graph_layouts`
// snapshot and joins labels LIVE; `POST /api/graph/overview/refresh` queues a
// re-layout. The contract #375 renders against (sigma.js over graphology).
// =============================================================================

/**
 * Most positioned nodes one overview response carries (top by degree).
 *
 * @stability experimental
 */
export const OVERVIEW_MAX_NODES = 5000;

/**
 * Most edges one overview response carries when `edges=true`.
 *
 * @stability experimental
 */
export const OVERVIEW_MAX_EDGES = 20000;

const overviewEdgeSchema = z.object({
  id: z.uuid().describe('The relation id.'),
  source: z.uuid().describe('A returned node id (the relation\'s from end).'),
  target: z.uuid().describe('A returned node id (the relation\'s to end).'),
  type: z.string().describe('The relation type key.'),
});

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

const overviewDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

/**
 * Zod schema for the optional `GET /api/graph/overview` filters.
 *
 * `types` is comma-separated entity types / item kinds (absent or blank = all; an unknown key is a 400).
 * `from` / `to` keep entities with evidence dated in the window (same date rule as `GET /api/graph/activity`).
 *
 * @stability experimental
 */
export const graphOverviewQuerySchema = z.object({
  types: z
    .string()
    .optional()
    .describe('Comma-separated entity types or item kinds to keep. Absent or blank = all. Unknown key = 400.'),
  from: overviewDateSchema
    .optional()
    .describe('Keep entities with evidence dated at or after this instant (`YYYY-MM-DD` is local midnight that day in the requester time zone).'),
  to: overviewDateSchema
    .optional()
    .describe('Keep entities with evidence dated before this instant (`YYYY-MM-DD` is local midnight that day in the requester time zone).'),
  edges: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .describe('`true` adds `edges` among the returned nodes. Absent or `false` omits them.'),
});

/**
 * The parsed shape of {@link graphOverviewQuerySchema}.
 *
 * @stability experimental
 */
export type GraphOverviewQuery = z.infer<typeof graphOverviewQuerySchema>;

/**
 * Zod schema for the graph overview response wire shape.
 *
 * @stability experimental
 */
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
      .describe(`More positioned nodes matched than returned (the top ${OVERVIEW_MAX_NODES} by degree are).`),
    edges: z
      .array(overviewEdgeSchema)
      .max(OVERVIEW_MAX_EDGES)
      .optional()
      .describe('Present only with `edges=true`: live relations valid now with both ends in `nodes`.'),
    edgesTruncated: z
      .boolean()
      .optional()
      .describe(`Present only with \`edges=true\`: more edges matched than the ${OVERVIEW_MAX_EDGES} returned.`),
    typeCounts: z
      .record(z.string(), z.number().int())
      .describe(
        'Live readable entities per type, time-filtered by `from`/`to` but NOT by `types`. Read live, so it can ' +
          'exceed the nodes in a stale snapshot. Feeds filter-chip counts.',
      ),
  })
  .describe('The latest whole-graph layout snapshot, with labels read live.');

/**
 * The parsed shape of {@link graphOverviewResponseSchema}.
 *
 * @stability experimental
 */
export type GraphOverviewResponse = z.infer<typeof graphOverviewResponseSchema>;

/**
 * Zod schema for the graph overview refresh response wire shape.
 *
 * @stability experimental
 */
export const graphOverviewRefreshResponseSchema = z
  .object({
    jobId: z.string().describe('The `kg.graph_layout` job.'),
    deduplicated: z
      .boolean()
      .describe('`true` when a layout job was already pending or running for you; that job is returned.'),
  })
  .describe('The queued (or already queued) re-layout.');

/**
 * The parsed shape of {@link graphOverviewRefreshResponseSchema}.
 *
 * @stability experimental
 */
export type GraphOverviewRefreshResponse = z.infer<typeof graphOverviewRefreshResponseSchema>;
