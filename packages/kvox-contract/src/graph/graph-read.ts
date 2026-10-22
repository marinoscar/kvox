import { z } from 'zod';
import { KG_ALIAS_SOURCES_FOR_DTO } from './graph-enums.js';

// =============================================================================
// Graph read DTOs (#370, epic #347; docs/specs/ontology.md §9, §12, §22)
// =============================================================================
//
// The contract every read consumer shares: the entity page and `/graph` index
// (#373), the explorer (#374), the brief (#372) and the Ask agent (#377). The
// web app mirrors these shapes in `apps/web/src/services/graph.ts`, so a field
// name here is stable once merged.
// =============================================================================

/**
 * The most nodes one neighbourhood/expand slice ever returns (§22).
 *
 * @stability experimental
 */
export const GRAPH_NODE_CAP = 300;
/**
 * The most seeds one explorer expand accepts.
 *
 * @stability experimental
 */
export const GRAPH_EXPAND_MAX_SEEDS = 50;
/**
 * The most ids `GET /api/graph/evidence?ids=` resolves at once.
 *
 * @stability experimental
 */
export const GRAPH_EVIDENCE_BATCH_MAX = 50;

const PRECISIONS = ['day', 'month', 'year', 'unknown'] as const;
const ITEM_KINDS = ['commitment', 'decision', 'claim', 'person_fact', 'risk'] as const;

const asOfParam = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .optional()
  .describe('Evaluate the graph as of this instant: `YYYY-MM-DD` (00:00:00Z that day) or an ISO 8601 datetime with an offset. Default: now.');

// Parsed and validated against the caller's effective schema keys in the
// service → 400 on an unknown key.
const csv = z.string().max(512).optional();

// ---------------------------------------------------------------------------
// GET /api/graph/entities
// ---------------------------------------------------------------------------

/**
 * Zod schema for the list entities query wire shape.
 *
 * @stability experimental
 */
export const listEntitiesQuerySchema = z.object({
  type: csv.describe('Comma-separated entity type keys, e.g. `Person,Organization`. Default: every entity type.'),
  q: z.string().trim().min(1).max(200).optional().describe('Fuzzy match on labels and aliases. Top `limit` by similarity; no further pages.'),
  transcriptId: z.uuid().optional().describe('Only Persons identified as a speaker in this transcript. 404 without view access to it.'),
  sort: z
    .enum(['updated', 'viewed', 'mentions'])
    .default('updated')
    .describe(
      '`updated`: most recently changed first. `viewed`: the entities you viewed, most recent first. `mentions`: most-mentioned first (the notes and transcripts that mention the entity, counted since `since`); the top `limit`, no further pages. Ignored with `q`.',
    ),
  since: z
    .union([z.iso.date(), z.iso.datetime({ offset: true })])
    .optional()
    .describe(
      'With `sort=mentions` only: count the mentions recorded on or after this instant (`YYYY-MM-DD`, 00:00:00Z that day, or an ISO 8601 datetime with an offset) and leave out entities with none. Ignored for the other sorts.',
    ),
  cursor: z.string().max(500).optional().describe('`nextCursor` from the previous page.'),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
/**
 * The parsed shape of {@link listEntitiesQuerySchema}.
 *
 * @stability experimental
 */
export type ListEntitiesQuery = z.infer<typeof listEntitiesQuerySchema>;

/**
 * Zod schema for the graph entity summary wire shape.
 *
 * @stability experimental
 */
export const graphEntitySummarySchema = z
  .object({
    id: z.uuid(),
    type: z.string(),
    label: z.string(),
    aliases: z.array(z.string()).max(5).describe('Up to five other names, oldest first; the label itself is not repeated.'),
    mentionCount: z.number().int().describe('Notes and transcripts linked to this entity.'),
    lastSeenAt: z.string().nullable().describe('ISO 8601: the latest date of a Meeting this entity has evidence in.'),
    speakerIds: z.array(z.string()).optional().describe('Present only with `?transcriptId`: the speakers identified as this Person.'),
  })
  .describe('One row of the entity index.');

/**
 * Zod schema for the list entities response wire shape.
 *
 * @stability experimental
 */
export const listEntitiesResponseSchema = z.object({
  items: z.array(graphEntitySummarySchema),
  nextCursor: z.string().nullable().describe('Always `null` when `q` is set (top `limit` by similarity, like search).'),
});
/**
 * The parsed shape of {@link listEntitiesResponseSchema}.
 *
 * @stability experimental
 */
export type ListEntitiesResponse = z.infer<typeof listEntitiesResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/graph/entities/:id
// ---------------------------------------------------------------------------

/**
 * Zod schema for the graph entity detail wire shape.
 *
 * @stability experimental
 */
export const graphEntityDetailSchema = z
  .object({
    id: z.uuid(),
    type: z.string(),
    label: z.string(),
    props: z.record(z.string(), z.unknown()).describe('Keyed by attribute key; user-defined attributes by their `u_…` key (§17.3).'),
    aliases: z.array(z.object({ id: z.uuid(), alias: z.string(), source: z.enum(KG_ALIAS_SOURCES_FOR_DTO) })),
    occurredAt: z.string().nullable().describe('Meeting only.'),
    reviewStatus: z.enum(['accepted', 'edited']),
    ontologyVersion: z.string(),
    firstSeenAt: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
    counts: z.object({
      relations: z.number().int(),
      mentions: z.number().int(),
      evidence: z.number().int(),
      items: z.object({
        commitment: z.number().int(),
        decision: z.number().int(),
        claim: z.number().int(),
        person_fact: z.number().int(),
        risk: z.number().int(),
      }),
      openCommitments: z.number().int(),
      relationsByType: z
        .record(z.string(), z.number().int().min(0))
        .optional()
        .describe(
          'Readable relations of the entity per relation type (both directions); sums to `relations`. The Expand menu of the explorer inspector (GIC-11). Absent from an older API.',
        ),
      relationsByNeighborType: z
        .record(z.string(), z.number().int().min(0))
        .optional()
        .describe(
          'The same relations per entity type of the entity at the other end; sums to `relations`. Absent from an older API.',
        ),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .describe('One entity of your knowledge graph, with counts for its page.');
/**
 * The parsed shape of {@link graphEntityDetailSchema}.
 *
 * @stability experimental
 */
export type GraphEntityDetail = z.infer<typeof graphEntityDetailSchema>;

// ---------------------------------------------------------------------------
// Graph slice — shared by neighbourhood + expand (and #374, #377)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the graph node wire shape.
 *
 * @stability experimental
 */
export const graphNodeSchema = z.object({
  id: z.uuid(),
  nodeKind: z.enum(['entity', 'item']),
  type: z.string().describe("Entity type key, or item kind ('commitment' | 'decision' | 'claim' | 'person_fact' | 'risk')."),
  label: z.string().describe('Entity label, or item title ?? the first 80 characters of its statement.'),
  depth: z.number().int().min(0).max(2),
  degree: z.number().int().describe('Readable, as-of-valid edges in your whole graph (for node size).'),
  status: z.string().nullable().describe('Item status; null for entities.'),
  occurredAt: z.string().nullable(),
  mentionCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Entities: readable (linked or new) mentions of the entity. Absent for items and from an older API.'),
  lastSeenAt: z
    .string()
    .nullable()
    .optional()
    .describe(
      'ISO instant of the latest readable mention (entity) or latest evidence (item); null when there is none. Absent from an older API.',
    ),
});
/**
 * The parsed shape of {@link graphNodeSchema}.
 *
 * @stability experimental
 */
export type GraphNode = z.infer<typeof graphNodeSchema>;

const validSchema = z
  .object({ from: z.string().nullable(), to: z.string().nullable(), precision: z.enum(PRECISIONS) })
  .nullable()
  .describe('Half-open `[from, to)`; `null` bounds are unbounded. `null` for a non-temporal edge.');

/**
 * Zod schema for the graph edge wire shape.
 *
 * @stability experimental
 */
export const graphEdgeSchema = z.object({
  id: z.string().describe('`kg_relations.id`, or `virt:<itemId>:<TYPE>` for an edge derived from an item column.'),
  type: z.string(),
  source: z.uuid().describe('Stored direction, never inverted.'),
  target: z.uuid(),
  valid: validSchema,
  confidence: z.number().nullable(),
  virtual: z.boolean(),
  props: z
    .record(z.string(), z.unknown())
    .describe(
      "The relation's own attribute values, keyed by prop key — e.g. HAS_ROLE `{ title: 'Managing Director', businessUnit: 'Consulting' }` (#440). Only props the relation type declares in your effective schema, never a deprecated or `sensitive` one, never a null value. `{}` for a derived (`virtual`) edge or a relation with none. Read labels from `GET /api/graph/ontology`'s relation-type `props`.",
    ),
  evidenceCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Evidence rows behind the relation; for a virtual item edge, the item evidence count. Absent from an older API.',
    ),
  lastEvidenceAt: z
    .string()
    .nullable()
    .optional()
    .describe('ISO instant of the latest evidence behind the edge; null when none. Absent from an older API.'),
});
/**
 * The parsed shape of {@link graphEdgeSchema}.
 *
 * @stability experimental
 */
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/**
 * Zod schema for the graph slice wire shape.
 *
 * @stability experimental
 */
export const graphSliceSchema = z.object({
  seedIds: z.array(z.uuid()),
  asOf: z.string(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  truncated: z.boolean().describe('True when more nodes were reachable than `cap`.'),
  cap: z.number().int(),
});
/**
 * The parsed shape of {@link graphSliceSchema}.
 *
 * @stability experimental
 */
export type GraphSlice = z.infer<typeof graphSliceSchema>;

// GET /api/graph/entities/:id/neighborhood
/**
 * Zod schema for the neighborhood query wire shape.
 *
 * @stability experimental
 */
export const neighborhoodQuerySchema = z.object({
  hops: z.coerce.number().int().min(1).max(2).default(1),
  types: csv.describe('Comma-separated entity types / item kinds to keep (the seed is always kept).'),
  relationTypes: csv.describe('Comma-separated relation types to walk along.'),
  as_of: asOfParam,
  limit: z.coerce.number().int().min(1).max(GRAPH_NODE_CAP).default(150),
});
/**
 * The parsed shape of {@link neighborhoodQuerySchema}.
 *
 * @stability experimental
 */
export type NeighborhoodQuery = z.infer<typeof neighborhoodQuerySchema>;

// POST /api/graph/explore/expand
/**
 * Zod schema for the expand request wire shape.
 *
 * @stability experimental
 */
export const expandRequestSchema = z.object({
  nodeIds: z.array(z.uuid()).min(1).max(GRAPH_EXPAND_MAX_SEEDS),
  types: z.array(z.string().max(64)).max(32).optional(),
  // Additive: §22.2 filters narrow what expansion may ADD, so they are server-side.
  relationTypes: z.array(z.string().max(64)).max(32).optional(),
  as_of: asOfParam,
  cap: z.number().int().min(1).max(GRAPH_NODE_CAP).default(100),
});
/**
 * The parsed shape of {@link expandRequestSchema}.
 *
 * @stability experimental
 */
export type ExpandRequest = z.infer<typeof expandRequestSchema>;

// ---------------------------------------------------------------------------
// GET /api/graph/paths (GIC-12, #673)
// ---------------------------------------------------------------------------

/**
 * The most paths one `GET /api/graph/paths` call returns (`k`).
 *
 * @stability experimental
 */
export const GRAPH_PATHS_MAX_K = 5;
/**
 * The most hops one `GET /api/graph/paths` path may have (`maxHops`).
 *
 * @stability experimental
 */
export const GRAPH_PATHS_MAX_HOPS = 5;

/**
 * Zod schema for the graph paths query wire shape.
 *
 * @stability experimental
 */
export const graphPathsQuerySchema = z
  .object({
    from: z.uuid().describe('The entity (or item) the paths start at.'),
    to: z.uuid().describe('The entity (or item) the paths end at.'),
    k: z.coerce.number().int().min(1).max(GRAPH_PATHS_MAX_K).default(3).describe('How many distinct paths to return, 1-5.'),
    maxHops: z.coerce
      .number()
      .int()
      .min(1)
      .max(GRAPH_PATHS_MAX_HOPS)
      .default(4)
      .describe('The longest path to look for, in edges, 1-5.'),
    types: csv.describe('Comma-separated entity types / item kinds a path may pass through (the endpoints are always kept).'),
    relationTypes: csv.describe('Comma-separated relation types a path may follow.'),
    as_of: asOfParam,
  })
  .refine((q) => q.from !== q.to, { message: '`from` and `to` must be different', path: ['to'] });
/**
 * The parsed shape of {@link graphPathsQuerySchema}.
 *
 * @stability experimental
 */
export type GraphPathsQuery = z.infer<typeof graphPathsQuerySchema>;

/**
 * Zod schema for one path of a graph paths response.
 *
 * @stability experimental
 */
export const graphPathSchema = z.object({
  nodeIds: z.array(z.uuid()).min(2).describe('The nodes in walking order: `from` first, `to` last.'),
  edgeIds: z
    .array(z.string())
    .min(1)
    .describe('The edge between each consecutive pair of nodes, by id in the response `slice`. An edge keeps its stored direction.'),
  hops: z.number().int().min(1).max(GRAPH_PATHS_MAX_HOPS).describe('Number of edges; `edgeIds.length`.'),
  score: z
    .number()
    .min(0)
    .describe('Mean of `log(1 + evidenceCount)` over the path edges, discounted for passing through high-degree hubs. Higher is a stronger connection.'),
});
/**
 * The parsed shape of {@link graphPathSchema}.
 *
 * @stability experimental
 */
export type GraphPath = z.infer<typeof graphPathSchema>;

/**
 * Zod schema for the graph paths response wire shape.
 *
 * @stability experimental
 */
export const graphPathsResponseSchema = z.object({
  from: z.uuid(),
  to: z.uuid(),
  asOf: z.string().nullable().describe('The `as_of` instant that was applied; null when the request had none (now).'),
  paths: z.array(graphPathSchema).describe('Best first. Empty when nothing connects the two within `maxHops`.'),
  slice: graphSliceSchema.describe('The union of the nodes and edges of every returned path.'),
  truncated: z
    .boolean()
    .describe('True when a per-hop cap was hit, so a stronger path than those returned may exist.'),
});
/**
 * The parsed shape of {@link graphPathsResponseSchema}.
 *
 * @stability experimental
 */
export type GraphPathsResponse = z.infer<typeof graphPathsResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/graph/connect (GIC-14, #675)
// ---------------------------------------------------------------------------

/**
 * The most notes, and the most transcripts, one `POST /api/graph/connect` call accepts.
 *
 * @stability experimental
 */
export const GRAPH_CONNECT_MAX_DOCUMENTS = 10;
/**
 * The most entities one `POST /api/graph/connect` call accepts.
 *
 * @stability experimental
 */
export const GRAPH_CONNECT_MAX_ENTITIES = 20;
/**
 * The most hops a bridge path of `POST /api/graph/connect` may have.
 *
 * @stability experimental
 */
export const GRAPH_CONNECT_MAX_HOPS = 3;

/**
 * Zod schema for the graph connect request wire shape: at least two distinct inputs in total, or a single note or transcript ("what this note touches").
 *
 * @stability experimental
 */
export const graphConnectRequestSchema = z
  .object({
    noteIds: z.array(z.uuid()).max(GRAPH_CONNECT_MAX_DOCUMENTS).optional().describe('Notes to connect, at most 10.'),
    transcriptIds: z
      .array(z.uuid())
      .max(GRAPH_CONNECT_MAX_DOCUMENTS)
      .optional()
      .describe('Transcripts to connect, at most 10.'),
    entityIds: z.array(z.uuid()).max(GRAPH_CONNECT_MAX_ENTITIES).optional().describe('Entities to connect, at most 20.'),
    as_of: asOfParam,
    maxHops: z.number().int().min(1).max(GRAPH_CONNECT_MAX_HOPS).default(2).describe('The longest bridge path, in edges, 1-3.'),
  })
  .refine(
    (q) => {
      const all = [...(q.noteIds ?? []), ...(q.transcriptIds ?? []), ...(q.entityIds ?? [])];
      const documents = (q.noteIds?.length ?? 0) + (q.transcriptIds?.length ?? 0);
      // One note or transcript on its own is "what this note touches"; anything else needs two inputs.
      return new Set(all).size === all.length && (all.length >= 2 || (all.length === 1 && documents === 1));
    },
    { message: 'Give at least two distinct notes, transcripts or entities (or one note or transcript)', path: ['noteIds'] },
  );
/**
 * The parsed shape of {@link graphConnectRequestSchema}.
 *
 * @stability experimental
 */
export type GraphConnectRequest = z.infer<typeof graphConnectRequestSchema>;

/**
 * Zod schema for one input of a graph connect response.
 *
 * @stability experimental
 */
export const graphConnectInputSchema = z.object({
  kind: z.enum(['note', 'transcript', 'entity']),
  id: z.uuid(),
  title: z.string().describe('The note or transcript title, or the entity label.'),
  entityIds: z
    .array(z.uuid())
    .describe('The entities the input touches (a document: its readable mentions; an entity: itself and its neighbours), strongest first, capped.'),
});
/**
 * The parsed shape of {@link graphConnectInputSchema}.
 *
 * @stability experimental
 */
export type GraphConnectInput = z.infer<typeof graphConnectInputSchema>;

/**
 * Zod schema for one shared entity of a graph connect response.
 *
 * @stability experimental
 */
export const graphConnectSharedSchema = z.object({
  entityId: z.uuid(),
  inputIds: z.array(z.uuid()).min(2).describe('The inputs that touch the entity, at least two.'),
  mentionCount: z.number().int().min(0).describe('Mentions (or relations, for an entity input) across those inputs.'),
});
/**
 * The parsed shape of {@link graphConnectSharedSchema}.
 *
 * @stability experimental
 */
export type GraphConnectShared = z.infer<typeof graphConnectSharedSchema>;

/**
 * Zod schema for one bridge path of a graph connect response.
 *
 * @stability experimental
 */
export const graphConnectPathSchema = z.object({
  fromInput: z.uuid(),
  toInput: z.uuid(),
  nodeIds: z.array(z.uuid()).min(2),
  edgeIds: z.array(z.string()).min(1),
  score: z.number().min(0),
});
/**
 * The parsed shape of {@link graphConnectPathSchema}.
 *
 * @stability experimental
 */
export type GraphConnectPath = z.infer<typeof graphConnectPathSchema>;

/**
 * Zod schema for the graph connect response wire shape.
 *
 * @stability experimental
 */
export const graphConnectResponseSchema = z.object({
  inputs: z.array(graphConnectInputSchema),
  shared: z.array(graphConnectSharedSchema).describe('Entities touched by two or more inputs: widest coverage first, then mention count.'),
  paths: z.array(graphConnectPathSchema).describe('Bridges between inputs, best first. Empty when nothing links them.'),
  slice: graphSliceSchema.describe('The shared entities and bridge nodes with the edges between them.'),
  truncated: z.boolean().describe('True when a cap or the time budget cut the answer short.'),
});
/**
 * The parsed shape of {@link graphConnectResponseSchema}.
 *
 * @stability experimental
 */
export type GraphConnectResponse = z.infer<typeof graphConnectResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/graph/activity (GIC-15, #676)
// ---------------------------------------------------------------------------

/**
 * The most entity ids one `GET /api/graph/activity` call accepts.
 *
 * @stability experimental
 */
export const GRAPH_ACTIVITY_MAX_IDS = 300;

/**
 * The bucket widths of `GET /api/graph/activity`.
 *
 * @stability experimental
 */
export const GRAPH_ACTIVITY_BUCKETS = ['week', 'month'] as const;
/**
 * One bucket width of {@link GRAPH_ACTIVITY_BUCKETS}.
 *
 * @stability experimental
 */
export type GraphActivityBucket = (typeof GRAPH_ACTIVITY_BUCKETS)[number];

/**
 * Zod schema for the graph activity query wire shape.
 *
 * @stability experimental
 */
export const graphActivityQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .max(GRAPH_ACTIVITY_MAX_IDS * 37)
    .transform((raw) => [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))])
    .pipe(z.array(z.uuid()).min(1).max(GRAPH_ACTIVITY_MAX_IDS))
    .describe(`Comma-separated entity (or item) ids, at most ${GRAPH_ACTIVITY_MAX_IDS}.`),
  bucket: z.enum(GRAPH_ACTIVITY_BUCKETS).default('month').describe('The bucket width: `week` (starting Monday, UTC) or `month`.'),
  from: z
    .union([z.iso.date(), z.iso.datetime({ offset: true })])
    .optional()
    .describe('Only evidence dated at or after this instant (`YYYY-MM-DD` is 00:00:00Z that day).'),
  to: z
    .union([z.iso.date(), z.iso.datetime({ offset: true })])
    .optional()
    .describe('Only evidence dated before this instant (`YYYY-MM-DD` is 00:00:00Z that day).'),
});
/**
 * The parsed shape of {@link graphActivityQuerySchema}.
 *
 * @stability experimental
 */
export type GraphActivityQuery = z.infer<typeof graphActivityQuerySchema>;

/**
 * Zod schema for one stacked bucket of a graph activity response.
 *
 * @stability experimental
 */
export const graphActivityBucketSchema = z.object({
  start: z.string().describe('The first day of the bucket, `YYYY-MM-DD` (UTC).'),
  total: z.number().int().min(0).describe('The sum of `byType`.'),
  byType: z.record(z.string(), z.number().int().min(0)).describe('Evidence attributions per entity type (or item kind).'),
});
/**
 * The parsed shape of {@link graphActivityBucketSchema}.
 *
 * @stability experimental
 */
export type GraphActivityBucketRow = z.infer<typeof graphActivityBucketSchema>;

/**
 * Zod schema for one entity's count in one bucket.
 *
 * @stability experimental
 */
export const graphActivityPointSchema = z.object({
  start: z.string().describe('The first day of the bucket, `YYYY-MM-DD` (UTC).'),
  count: z.number().int().min(1).describe('Evidence attributions of this entity in the bucket.'),
});
/**
 * The parsed shape of {@link graphActivityPointSchema}.
 *
 * @stability experimental
 */
export type GraphActivityPoint = z.infer<typeof graphActivityPointSchema>;

/**
 * Zod schema for the graph activity response wire shape.
 *
 * @stability experimental
 */
export const graphActivityResponseSchema = z.object({
  bucket: z.enum(GRAPH_ACTIVITY_BUCKETS),
  series: z.array(graphActivityBucketSchema).describe('Only buckets with evidence, oldest first.'),
  byEntity: z
    .record(z.string(), z.array(graphActivityPointSchema))
    .describe('Per requested id, only buckets with evidence, oldest first. Ids without evidence are absent.'),
});
/**
 * The parsed shape of {@link graphActivityResponseSchema}.
 *
 * @stability experimental
 */
export type GraphActivityResponse = z.infer<typeof graphActivityResponseSchema>;


// ---------------------------------------------------------------------------
// GET /api/graph/entities/:id/timeline
// ---------------------------------------------------------------------------

/**
 * Wire constant: timeline kinds.
 *
 * @stability experimental
 */
export const TIMELINE_KINDS = ['commitment', 'decision', 'claim', 'person_fact', 'risk', 'relation', 'meeting'] as const;
/**
 * The `TimelineKind` type (timeline kind).
 *
 * @stability experimental
 */
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/**
 * Zod schema for the timeline query wire shape.
 *
 * @stability experimental
 */
export const timelineQuerySchema = z.object({
  as_of: asOfParam,
  kinds: csv.describe(`Comma-separated subset of ${TIMELINE_KINDS.join(', ')}.`),
  includeSensitive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
    .describe('Include `sensitive` person facts. Default false.'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
/**
 * The parsed shape of {@link timelineQuerySchema}.
 *
 * @stability experimental
 */
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/**
 * The `{ id, label, type }` reference to an entity that read responses embed.
 *
 * @stability experimental
 */
export const entityRef = z.object({ id: z.uuid(), label: z.string(), type: z.string() });
/**
 * The parsed shape of the entity reference object `entityRef` (id, label, type).
 *
 * @stability experimental
 */
export type GraphEntityRef = z.infer<typeof entityRef>;

/**
 * Zod schema for the timeline event wire shape.
 *
 * @stability experimental
 */
export const timelineEventSchema = z.object({
  id: z.string().describe('Item id, `rel:<id>:start|end`, or meeting id.'),
  eventKind: z.enum(['item', 'relation_started', 'relation_ended', 'meeting']),
  at: z.string().nullable(),
  precision: z.enum(PRECISIONS),
  item: z
    .object({
      id: z.uuid(),
      kind: z.enum(ITEM_KINDS),
      title: z.string().nullable(),
      statement: z.string(),
      status: z.string().nullable(),
      dueAt: z.string().nullable(),
      ownerPerson: entityRef.nullable(),
      counterparty: entityRef.nullable(),
      sensitivity: z.enum(['business', 'personal', 'sensitive']).nullable(),
      superseded: z.boolean(),
      supersededById: z.uuid().nullable(),
    })
    .optional(),
  relation: z
    .object({
      id: z.uuid(),
      type: z.string(),
      direction: z.enum(['out', 'in']),
      other: entityRef,
      valid: graphEdgeSchema.shape.valid,
    })
    .optional(),
  meeting: entityRef.optional(),
  evidenceIds: z.array(z.uuid()).max(5),
  evidenceCount: z.number().int(),
});
/**
 * The parsed shape of {@link timelineEventSchema}.
 *
 * @stability experimental
 */
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

/**
 * Zod schema for the timeline response wire shape.
 *
 * @stability experimental
 */
export const timelineResponseSchema = z.object({
  items: z.array(timelineEventSchema),
  nextCursor: z.string().nullable(),
  asOf: z.string(),
});
/**
 * The parsed shape of {@link timelineResponseSchema}.
 *
 * @stability experimental
 */
export type TimelineResponse = z.infer<typeof timelineResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/graph/entities/:id/mentions
// ---------------------------------------------------------------------------

/**
 * Zod schema for the mentions query wire shape.
 *
 * @stability experimental
 */
export const mentionsQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
/**
 * The parsed shape of {@link mentionsQuerySchema}.
 *
 * @stability experimental
 */
export type MentionsQuery = z.infer<typeof mentionsQuerySchema>;

/**
 * Zod schema for the mentions response wire shape.
 *
 * @stability experimental
 */
export const mentionsResponseSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(['note', 'transcript']),
      id: z.uuid(),
      title: z.string().nullable().describe('Null when the document is no longer available to you.'),
      occurredAt: z.string().nullable(),
      available: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
/**
 * The parsed shape of {@link mentionsResponseSchema}.
 *
 * @stability experimental
 */
export type MentionsResponse = z.infer<typeof mentionsResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/graph/evidence/:id   and   GET /api/graph/evidence?ids=a,b
// ---------------------------------------------------------------------------

/**
 * Zod schema for the evidence batch query wire shape.
 *
 * @stability experimental
 */
export const evidenceBatchQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .max(GRAPH_EVIDENCE_BATCH_MAX * 37)
    .transform((raw) => [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))])
    .pipe(z.array(z.uuid()).min(1).max(GRAPH_EVIDENCE_BATCH_MAX))
    .describe(`Comma-separated evidence ids, at most ${GRAPH_EVIDENCE_BATCH_MAX}. Unknown ids are silently omitted.`),
});
/**
 * The parsed shape of {@link evidenceBatchQuerySchema}.
 *
 * @stability experimental
 */
export type EvidenceBatchQuery = z.infer<typeof evidenceBatchQuerySchema>;

/**
 * Zod schema for the evidence-by-subject query wire shape.
 *
 * @stability experimental
 */
export const evidenceBySubjectQuerySchema = z.object({
  kind: z.enum(['entity', 'relation', 'item']).describe('What the citations support.'),
  id: z.uuid().describe('The entity, relation or item id.'),
});
/**
 * The parsed shape of {@link evidenceBySubjectQuerySchema}.
 *
 * @stability experimental
 */
export type EvidenceBySubjectQuery = z.infer<typeof evidenceBySubjectQuerySchema>;

/**
 * Zod schema for the evidence link wire shape.
 *
 * @stability experimental
 */
export const evidenceLinkSchema = z
  .object({
    id: z.uuid(),
    subjectKind: z.enum(['entity', 'relation', 'item', 'proposal_item', 'import']),
    subjectId: z.uuid(),
    quote: z.string().describe('The exact text at anchoring time — kept even when the source is gone.'),
    createdAt: z.string(),
    source: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('segment'),
        transcriptId: z.uuid().nullable(),
        transcriptTitle: z.string().nullable(),
        segmentId: z.uuid().nullable(),
        segmentRev: z.number().int().nullable(),
        currentSegmentRev: z.number().int().nullable(),
        startMs: z.number().int().nullable(),
        endMs: z.number().int().nullable(),
        textChanged: z.boolean(),
        available: z.boolean(),
        hasAudio: z
          .boolean()
          .describe(
            'Whether the cited transcript has a recording to play (#604). False for a transcript ' +
              'imported from a kvox.transcript/v1 file (its audio route answers 404), and whenever ' +
              '`available` is false.',
          ),
        href: z.string().nullable(),
      }),
      z.object({
        kind: z.literal('note'),
        noteId: z.uuid().nullable(),
        noteTitle: z.string().nullable(),
        noteVersion: z.number().int().nullable(),
        currentNoteVersion: z.number().int().nullable(),
        charStart: z.number().int().nullable(),
        charEnd: z.number().int().nullable(),
        versionChanged: z.boolean(),
        available: z.boolean(),
        href: z.string().nullable(),
      }),
      z.object({
        kind: z.literal('import'),
        importObjectId: z.uuid().nullable(),
        sourceIri: z.string().nullable(),
        available: z.boolean(),
        href: z.null(),
      }),
      z
        .object({
          kind: z.literal('manual'),
          available: z.literal(true).describe('Always true: the owner is the source, and nothing can be deleted from under it.'),
          href: z.null(),
        })
        .describe('Set by hand on an entity page (#586): the owner is the source; `quote` says what was set.'),
    ]),
  })
  .describe('One citation, resolved to a link you can open.');
/**
 * The parsed shape of {@link evidenceLinkSchema}.
 *
 * @stability experimental
 */
export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;

/**
 * Zod schema for the evidence batch response wire shape.
 *
 * @stability experimental
 */
export const evidenceBatchResponseSchema = z.object({ items: z.array(evidenceLinkSchema) });
/**
 * The parsed shape of {@link evidenceBatchResponseSchema}.
 *
 * @stability experimental
 */
export type EvidenceBatchResponse = z.infer<typeof evidenceBatchResponseSchema>;
