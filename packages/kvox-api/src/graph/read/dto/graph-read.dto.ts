import { createZodDto } from 'nestjs-zod';
import {
  listEntitiesQuerySchema,
  graphEntitySummarySchema,
  listEntitiesResponseSchema,
  graphEntityDetailSchema,
  graphSliceSchema,
  neighborhoodQuerySchema,
  expandRequestSchema,
  timelineQuerySchema,
  timelineResponseSchema,
  mentionsQuerySchema,
  mentionsResponseSchema,
  evidenceBatchQuerySchema,
  evidenceBySubjectQuerySchema,
  evidenceLinkSchema,
  evidenceBatchResponseSchema,
  graphPathsQuerySchema,
  graphPathsResponseSchema,
  graphActivityQuerySchema,
  graphActivityResponseSchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/graph-read.ts`); they are re-exported below so no importer changes.
export {
  GRAPH_NODE_CAP,
  GRAPH_EXPAND_MAX_SEEDS,
  GRAPH_EVIDENCE_BATCH_MAX,
  listEntitiesQuerySchema,
  type ListEntitiesQuery,
  graphEntitySummarySchema,
  listEntitiesResponseSchema,
  type ListEntitiesResponse,
  graphEntityDetailSchema,
  type GraphEntityDetail,
  graphNodeSchema,
  type GraphNode,
  graphEdgeSchema,
  type GraphEdge,
  graphSliceSchema,
  type GraphSlice,
  neighborhoodQuerySchema,
  type NeighborhoodQuery,
  expandRequestSchema,
  type ExpandRequest,
  TIMELINE_KINDS,
  type TimelineKind,
  timelineQuerySchema,
  type TimelineQuery,
  type GraphEntityRef,
  timelineEventSchema,
  type TimelineEvent,
  timelineResponseSchema,
  type TimelineResponse,
  mentionsQuerySchema,
  type MentionsQuery,
  mentionsResponseSchema,
  type MentionsResponse,
  evidenceBatchQuerySchema,
  type EvidenceBatchQuery,
  evidenceBySubjectQuerySchema,
  type EvidenceBySubjectQuery,
  evidenceLinkSchema,
  type EvidenceLink,
  evidenceBatchResponseSchema,
  type EvidenceBatchResponse,
  GRAPH_PATHS_MAX_K,
  GRAPH_PATHS_MAX_HOPS,
  graphPathsQuerySchema,
  type GraphPathsQuery,
  graphPathSchema,
  type GraphPath,
  graphPathsResponseSchema,
  type GraphPathsResponse,
  GRAPH_ACTIVITY_MAX_IDS,
  graphActivityQuerySchema,
  type GraphActivityQuery,
  graphActivityResponseSchema,
  type GraphActivityResponse,
} from '@marinoscar/kvox-contract/graph';

export class ListEntitiesQueryDto extends createZodDto(listEntitiesQuerySchema) {}
export class GraphEntitySummaryDto extends createZodDto(graphEntitySummarySchema) {}
export class ListEntitiesResponseDto extends createZodDto(listEntitiesResponseSchema) {}
export class GraphEntityDetailDto extends createZodDto(graphEntityDetailSchema) {}
export class GraphSliceDto extends createZodDto(graphSliceSchema) {}
export class NeighborhoodQueryDto extends createZodDto(neighborhoodQuerySchema) {}
export class ExpandRequestDto extends createZodDto(expandRequestSchema) {}
export class TimelineQueryDto extends createZodDto(timelineQuerySchema) {}
export class TimelineResponseDto extends createZodDto(timelineResponseSchema) {}
export class MentionsQueryDto extends createZodDto(mentionsQuerySchema) {}
export class MentionsResponseDto extends createZodDto(mentionsResponseSchema) {}
export class EvidenceBatchQueryDto extends createZodDto(evidenceBatchQuerySchema) {}
export class EvidenceLinkDto extends createZodDto(evidenceLinkSchema) {}
export class EvidenceBatchResponseDto extends createZodDto(evidenceBatchResponseSchema) {}
export class GraphPathsQueryDto extends createZodDto(graphPathsQuerySchema) {}
export class GraphPathsResponseDto extends createZodDto(graphPathsResponseSchema) {}
export class GraphActivityQueryDto extends createZodDto(graphActivityQuerySchema) {}
export class GraphActivityResponseDto extends createZodDto(graphActivityResponseSchema) {}
