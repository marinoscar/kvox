import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { KG_ALIAS_SOURCES_FOR_DTO } from '../../dto/graph-enums';

// =============================================================================
// Graph read DTOs (#370, epic #347; docs/specs/ontology.md §9, §12, §22)
// =============================================================================
//
// The contract every read consumer shares: the entity page and `/graph` index
// (#373), the explorer (#374), the brief (#372) and the Ask agent (#377). The
// web app mirrors these shapes in `apps/web/src/services/graph.ts`, so a field
// name here is stable once merged.
// =============================================================================

/** The most nodes one neighbourhood/expand slice ever returns (§22). */
export const GRAPH_NODE_CAP = 300;
/** The most seeds one explorer expand accepts. */
export const GRAPH_EXPAND_MAX_SEEDS = 50;
/** The most ids `GET /api/graph/evidence?ids=` resolves at once. */
export const GRAPH_EVIDENCE_BATCH_MAX = 50;

const PRECISIONS = ['day', 'month', 'year', 'unknown'] as const;
const ITEM_KINDS = ['commitment', 'decision', 'claim', 'person_fact'] as const;

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

export const listEntitiesQuerySchema = z.object({
  type: csv.describe('Comma-separated entity type keys, e.g. `Person,Organization`. Default: every entity type.'),
  q: z.string().trim().min(1).max(200).optional().describe('Fuzzy match on labels and aliases. Top `limit` by similarity; no further pages.'),
  transcriptId: z.uuid().optional().describe('Only Persons identified as a speaker in this transcript. 404 without view access to it.'),
  sort: z
    .enum(['updated', 'viewed'])
    .default('updated')
    .describe('`updated`: most recently changed first. `viewed`: the entities you viewed, most recent first. Ignored with `q`.'),
  cursor: z.string().max(500).optional().describe('`nextCursor` from the previous page.'),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type ListEntitiesQuery = z.infer<typeof listEntitiesQuerySchema>;
export class ListEntitiesQueryDto extends createZodDto(listEntitiesQuerySchema) {}

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
export class GraphEntitySummaryDto extends createZodDto(graphEntitySummarySchema) {}

export const listEntitiesResponseSchema = z.object({
  items: z.array(graphEntitySummarySchema),
  nextCursor: z.string().nullable().describe('Always `null` when `q` is set (top `limit` by similarity, like search).'),
});
export type ListEntitiesResponse = z.infer<typeof listEntitiesResponseSchema>;
export class ListEntitiesResponseDto extends createZodDto(listEntitiesResponseSchema) {}

// ---------------------------------------------------------------------------
// GET /api/graph/entities/:id
// ---------------------------------------------------------------------------

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
      }),
      openCommitments: z.number().int(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .describe('One entity of your knowledge graph, with counts for its page.');
export type GraphEntityDetail = z.infer<typeof graphEntityDetailSchema>;
export class GraphEntityDetailDto extends createZodDto(graphEntityDetailSchema) {}

// ---------------------------------------------------------------------------
// Graph slice — shared by neighbourhood + expand (and #374, #377)
// ---------------------------------------------------------------------------

export const graphNodeSchema = z.object({
  id: z.uuid(),
  nodeKind: z.enum(['entity', 'item']),
  type: z.string().describe("Entity type key, or item kind ('commitment' | 'decision' | 'claim' | 'person_fact')."),
  label: z.string().describe('Entity label, or item title ?? the first 80 characters of its statement.'),
  depth: z.number().int().min(0).max(2),
  degree: z.number().int().describe('Readable, as-of-valid edges in your whole graph (for node size).'),
  status: z.string().nullable().describe('Item status; null for entities.'),
  occurredAt: z.string().nullable(),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

const validSchema = z
  .object({ from: z.string().nullable(), to: z.string().nullable(), precision: z.enum(PRECISIONS) })
  .nullable()
  .describe('Half-open `[from, to)`; `null` bounds are unbounded. `null` for a non-temporal edge.');

export const graphEdgeSchema = z.object({
  id: z.string().describe('`kg_relations.id`, or `virt:<itemId>:<TYPE>` for an edge derived from an item column.'),
  type: z.string(),
  source: z.uuid().describe('Stored direction, never inverted.'),
  target: z.uuid(),
  valid: validSchema,
  confidence: z.number().nullable(),
  virtual: z.boolean(),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphSliceSchema = z.object({
  seedIds: z.array(z.uuid()),
  asOf: z.string(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  truncated: z.boolean().describe('True when more nodes were reachable than `cap`.'),
  cap: z.number().int(),
});
export type GraphSlice = z.infer<typeof graphSliceSchema>;
export class GraphSliceDto extends createZodDto(graphSliceSchema) {}

// GET /api/graph/entities/:id/neighborhood
export const neighborhoodQuerySchema = z.object({
  hops: z.coerce.number().int().min(1).max(2).default(1),
  types: csv.describe('Comma-separated entity types / item kinds to keep (the seed is always kept).'),
  relationTypes: csv.describe('Comma-separated relation types to walk along.'),
  as_of: asOfParam,
  limit: z.coerce.number().int().min(1).max(GRAPH_NODE_CAP).default(150),
});
export type NeighborhoodQuery = z.infer<typeof neighborhoodQuerySchema>;
export class NeighborhoodQueryDto extends createZodDto(neighborhoodQuerySchema) {}

// POST /api/graph/explore/expand
export const expandRequestSchema = z.object({
  nodeIds: z.array(z.uuid()).min(1).max(GRAPH_EXPAND_MAX_SEEDS),
  types: z.array(z.string().max(64)).max(32).optional(),
  // Additive: §22.2 filters narrow what expansion may ADD, so they are server-side.
  relationTypes: z.array(z.string().max(64)).max(32).optional(),
  as_of: asOfParam,
  cap: z.number().int().min(1).max(GRAPH_NODE_CAP).default(100),
});
export type ExpandRequest = z.infer<typeof expandRequestSchema>;
export class ExpandRequestDto extends createZodDto(expandRequestSchema) {}

// ---------------------------------------------------------------------------
// GET /api/graph/entities/:id/timeline
// ---------------------------------------------------------------------------

export const TIMELINE_KINDS = ['commitment', 'decision', 'claim', 'person_fact', 'relation', 'meeting'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

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
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
export class TimelineQueryDto extends createZodDto(timelineQuerySchema) {}

const entityRef = z.object({ id: z.uuid(), label: z.string(), type: z.string() });
export type GraphEntityRef = z.infer<typeof entityRef>;

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
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const timelineResponseSchema = z.object({
  items: z.array(timelineEventSchema),
  nextCursor: z.string().nullable(),
  asOf: z.string(),
});
export type TimelineResponse = z.infer<typeof timelineResponseSchema>;
export class TimelineResponseDto extends createZodDto(timelineResponseSchema) {}

// ---------------------------------------------------------------------------
// GET /api/graph/entities/:id/mentions
// ---------------------------------------------------------------------------

export const mentionsQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type MentionsQuery = z.infer<typeof mentionsQuerySchema>;
export class MentionsQueryDto extends createZodDto(mentionsQuerySchema) {}

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
export type MentionsResponse = z.infer<typeof mentionsResponseSchema>;
export class MentionsResponseDto extends createZodDto(mentionsResponseSchema) {}

// ---------------------------------------------------------------------------
// GET /api/graph/evidence/:id   and   GET /api/graph/evidence?ids=a,b
// ---------------------------------------------------------------------------

export const evidenceBatchQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .max(GRAPH_EVIDENCE_BATCH_MAX * 37)
    .transform((raw) => [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))])
    .pipe(z.array(z.uuid()).min(1).max(GRAPH_EVIDENCE_BATCH_MAX))
    .describe(`Comma-separated evidence ids, at most ${GRAPH_EVIDENCE_BATCH_MAX}. Unknown ids are silently omitted.`),
});
export type EvidenceBatchQuery = z.infer<typeof evidenceBatchQuerySchema>;
export class EvidenceBatchQueryDto extends createZodDto(evidenceBatchQuerySchema) {}

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
    ]),
  })
  .describe('One citation, resolved to a link you can open.');
export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;
export class EvidenceLinkDto extends createZodDto(evidenceLinkSchema) {}

export const evidenceBatchResponseSchema = z.object({ items: z.array(evidenceLinkSchema) });
export type EvidenceBatchResponse = z.infer<typeof evidenceBatchResponseSchema>;
export class EvidenceBatchResponseDto extends createZodDto(evidenceBatchResponseSchema) {}
