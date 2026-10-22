import { z } from 'zod';

// =============================================================================
// Graph insights DTOs (GIC-16, #677, epic #661; docs/specs/ontology.md §22.3)
// =============================================================================
//
// `GET /api/graph/insights?window=30d|90d|365d` — what deserves a look in the
// caller's own graph: Themes (the overview clusters), Connectors (top betweenness
// entities from the `kg.graph_layout` snapshot), Rising (mentions up against the
// preceding window), Fading ties (relations that went quiet) and open Risks.
// Sensitive person facts never contribute.
// =============================================================================

/**
 * The windows `GET /api/graph/insights` accepts.
 *
 * @stability experimental
 */
export const GRAPH_INSIGHTS_WINDOWS = ['30d', '90d', '365d'] as const;

/**
 * One of {@link GRAPH_INSIGHTS_WINDOWS}.
 *
 * @stability experimental
 */
export type GraphInsightsWindow = (typeof GRAPH_INSIGHTS_WINDOWS)[number];

/**
 * Fewest mentions an entity needs in the window to count as rising.
 *
 * @stability experimental
 */
export const INSIGHTS_RISING_MIN_COUNT = 3;

/**
 * An entity is rising when its window count is at least this multiple of the preceding window's.
 *
 * @stability experimental
 */
export const INSIGHTS_RISING_FACTOR = 2;

/**
 * Evidence rows a tie needs before the window for its silence to count as fading.
 *
 * @stability experimental
 */
export const INSIGHTS_FADING_MIN_EVIDENCE = 3;

/**
 * Zod schema for the graph insights query string.
 *
 * @stability experimental
 */
export const graphInsightsQuerySchema = z.object({
  window: z.enum(GRAPH_INSIGHTS_WINDOWS).default('30d').describe('How far back "recent" reaches: 30d (default), 90d or 365d.'),
});

/**
 * The parsed shape of {@link graphInsightsQuerySchema}.
 *
 * @stability experimental
 */
export type GraphInsightsQuery = z.infer<typeof graphInsightsQuerySchema>;

const insightEntitySchema = z.object({
  id: z.uuid(),
  label: z.string(),
  type: z.string(),
});

/**
 * Zod schema for one entity reference inside an insight item.
 *
 * @stability experimental
 */
export const graphInsightEntitySchema = insightEntitySchema;

/**
 * The parsed shape of {@link graphInsightEntitySchema}.
 *
 * @stability experimental
 */
export type GraphInsightEntity = z.infer<typeof graphInsightEntitySchema>;

/**
 * Zod schema for a theme: one overview cluster.
 *
 * @stability experimental
 */
export const graphInsightThemeSchema = z.object({
  clusterId: z.number().int().describe('The overview cluster id.'),
  label: z.string().describe('The live label of the entity the cluster is named after; else `Cluster <n>`.'),
  labelEntityId: z.uuid().nullable(),
  size: z.number().int().describe('Members when the snapshot was computed.'),
  typeCounts: z.record(z.string(), z.number().int()),
  memberSample: z
    .array(insightEntitySchema.extend({ degree: z.number().int() }))
    .max(8)
    .describe('Up to 8 members by degree; what the canvas is seeded with.'),
});

/**
 * The parsed shape of {@link graphInsightThemeSchema}.
 *
 * @stability experimental
 */
export type GraphInsightTheme = z.infer<typeof graphInsightThemeSchema>;

/**
 * Zod schema for a connector: an entity that links otherwise separate groups.
 *
 * @stability experimental
 */
export const graphInsightConnectorSchema = z.object({
  entity: insightEntitySchema,
  score: z.number().min(0).max(1).describe('Share of shortest paths between your other entities that pass through it. For ordering only; never show it as a number.'),
  clusters: z
    .array(z.object({ id: z.number().int(), label: z.string() }))
    .max(4)
    .describe('The groups it connects: its own first, then those of its neighbours.'),
  reason: z.string().describe('Plain-language sentence, e.g. "Joe connects the Copilot group and the Finance group."'),
});

/**
 * The parsed shape of {@link graphInsightConnectorSchema}.
 *
 * @stability experimental
 */
export type GraphInsightConnector = z.infer<typeof graphInsightConnectorSchema>;

/**
 * Zod schema for a rising entity.
 *
 * @stability experimental
 */
export const graphInsightRisingSchema = z.object({
  entity: insightEntitySchema,
  count: z.number().int().describe('Notes and recordings that mention it in the window.'),
  previous: z.number().int().describe('The same count in the window just before.'),
  reason: z.string(),
});

/**
 * The parsed shape of {@link graphInsightRisingSchema}.
 *
 * @stability experimental
 */
export type GraphInsightRising = z.infer<typeof graphInsightRisingSchema>;

/**
 * Zod schema for a fading tie between two people or organizations.
 *
 * @stability experimental
 */
export const graphInsightFadingTieSchema = z.object({
  from: insightEntitySchema,
  to: insightEntitySchema,
  relationTypes: z.array(z.string()).describe('The relation types joining the pair that carry evidence.'),
  lastEvidenceAt: z.string().describe('When the pair last came up together (ISO 8601).'),
  evidenceBefore: z.number().int().describe('Evidence rows before the window.'),
  reason: z.string().describe('"You haven\'t discussed X with Y since …"'),
});

/**
 * The parsed shape of {@link graphInsightFadingTieSchema}.
 *
 * @stability experimental
 */
export type GraphInsightFadingTie = z.infer<typeof graphInsightFadingTieSchema>;

/**
 * Zod schema for an open risk.
 *
 * @stability experimental
 */
export const graphInsightRiskSchema = z.object({
  id: z.uuid().describe('The Risk item.'),
  title: z.string().nullable(),
  statement: z.string(),
  severity: z.enum(['low', 'medium', 'high']).nullable(),
  subject: insightEntitySchema.nullable().describe('The project, product, organization or person it concerns, when still readable.'),
  occurredAt: z.string().nullable(),
});

/**
 * The parsed shape of {@link graphInsightRiskSchema}.
 *
 * @stability experimental
 */
export type GraphInsightRisk = z.infer<typeof graphInsightRiskSchema>;

/**
 * Zod schema for the graph insights response wire shape.
 *
 * @stability experimental
 */
export const graphInsightsResponseSchema = z
  .object({
    window: z.object({
      key: z.enum(GRAPH_INSIGHTS_WINDOWS),
      days: z.number().int(),
      from: z.string().describe('Start of the window (ISO 8601); it ends now.'),
      previousFrom: z.string().describe('Start of the preceding window rising entities are compared with.'),
    }),
    status: z.enum(['ready', 'none']).describe('`none`: no layout snapshot yet, so no themes or connectors.'),
    pending: z.boolean().describe('A `kg.graph_layout` job is pending or running for you.'),
    computedAt: z.string().nullable(),
    stale: z.boolean().describe('Your graph changed after the snapshot read it; themes and connectors may lag. Reported, never auto-refreshed.'),
    tooLarge: z.boolean(),
    connectorsReady: z.boolean().describe('`false` for a snapshot computed before connectors existed: refresh the overview.'),
    themes: z.array(graphInsightThemeSchema).max(8),
    connectors: z.array(graphInsightConnectorSchema).max(8),
    rising: z.array(graphInsightRisingSchema).max(10),
    fadingTies: z.array(graphInsightFadingTieSchema).max(10),
    openRisks: z.array(graphInsightRiskSchema).max(10),
  })
  .describe('What deserves a look in your graph: themes, connectors, rising entities, fading ties and open risks.');

/**
 * The parsed shape of {@link graphInsightsResponseSchema}.
 *
 * @stability experimental
 */
export type GraphInsightsResponse = z.infer<typeof graphInsightsResponseSchema>;
