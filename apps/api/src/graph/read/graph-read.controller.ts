import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  EvidenceBatchResponseDto,
  ExpandRequestDto,
  GRAPH_EXPAND_MAX_SEEDS,
  GRAPH_NODE_CAP,
  GraphSliceDto,
  expandRequestSchema,
  neighborhoodQuerySchema,
  type ExpandRequest,
  type GraphSlice,
  type NeighborhoodQuery,
  EvidenceLinkDto,
  GRAPH_EVIDENCE_BATCH_MAX,
  GraphEntityDetailDto,
  ListEntitiesResponseDto,
  MentionsResponseDto,
  evidenceBatchQuerySchema,
  listEntitiesQuerySchema,
  mentionsQuerySchema,
  type EvidenceBatchQuery,
  type EvidenceBatchResponse,
  type EvidenceLink,
  type GraphEntityDetail,
  type ListEntitiesQuery,
  type ListEntitiesResponse,
  type MentionsQuery,
  type MentionsResponse,
} from './dto/graph-read.dto';
import { GraphEvidenceService } from './graph-evidence.service';
import { GraphNeighborhoodService } from './graph-neighborhood.service';
import { GraphReadService } from './graph-read.service';

// =============================================================================
// GraphReadController (#370, epic #347; docs/specs/ontology.md §9, §12, §22)
// =============================================================================
//
// The read side of `/api/graph`: the entity index, an entity's page, its
// neighbourhood, timeline and mentions, the explorer's expand, and citation
// links. Every route is `graph:read`, tag `Graph`, and reads ONLY the caller's
// own graph — there is no `graph:read_any`, and no access is always a 404,
// never a 403 (a 403 would confirm the id exists).
//
// Only `accepted`/`edited` rows are ever returned (the timeline also shows
// `superseded` items, flagged), and never a merge tombstone.
// =============================================================================

const NOT_FOUND_ENTITY = 'No such entity, not yours, not part of your reviewed graph, or merged';

@ApiTags('Graph')
@Controller('graph')
export class GraphReadController {
  constructor(
    private readonly reads: GraphReadService,
    private readonly evidence: GraphEvidenceService,
    private readonly neighborhoods: GraphNeighborhoodService,
  ) {}

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  @Get('entities')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'List or search your entities',
    description:
      'The entity index of your graph: people, organizations, projects and meetings you have ' +
      'reviewed. Keyset-paginated by `nextCursor`.\n\n' +
      '- **`sort=updated`** (default): most recently changed first.\n' +
      '- **`sort=viewed`**: only the entities you have opened, most recent first.\n' +
      '- **`q`**: fuzzy match on labels and aliases, the top `limit` by similarity; `nextCursor` ' +
      'is always `null` and `sort` is ignored.\n' +
      '- **`transcriptId`**: the Persons identified as a speaker in that transcript, each with ' +
      'the `speakerIds` identified as them. 404 when you cannot view the transcript.\n\n' +
      'An unknown `type` key is a **400** naming it. A cursor from another list is a **400**.',
  })
  @ApiQuery({ name: 'type', required: false, type: String, description: 'Comma-separated entity type keys' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'transcriptId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'sort', required: false, enum: ['updated', 'viewed'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1-50 (default 25)' })
  @ApiDataResponse(ListEntitiesResponseDto, { description: 'A page of entities' })
  @ApiResponse({ status: 400, description: 'Invalid parameter, unknown type key, or a cursor from another list' })
  @ApiResponse({ status: 404, description: 'With `transcriptId`: no such transcript, or you cannot view it' })
  async list(
    @Query(new ZodValidationPipe(listEntitiesQuerySchema)) query: ListEntitiesQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<ListEntitiesResponse> {
    return this.reads.listEntities(user, query);
  }

  @Get('entities/:id')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'Get an entity',
    description:
      'One entity with its attributes, every alias, when it was first and last seen in a ' +
      'meeting, and the counts its page shows (relations valid now, mentions, evidence, items ' +
      'by kind, open commitments). `sensitive` person facts are not counted.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(GraphEntityDetailDto, { description: 'The entity' })
  @ApiResponse({ status: 404, description: NOT_FOUND_ENTITY })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<GraphEntityDetail> {
    return this.reads.getEntity(user, id);
  }

  @Get('entities/:id/mentions')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: "An entity's mentions",
    description:
      'The notes and transcripts linked to this entity, one row per document, newest first. ' +
      'A document that was deleted, or a transcript whose share you lost, stays in the list ' +
      'with `available: false` and no title.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1-50 (default 25)' })
  @ApiDataResponse(MentionsResponseDto, { description: 'A page of documents' })
  @ApiResponse({ status: 400, description: 'Invalid parameter, or a cursor from another list' })
  @ApiResponse({ status: 404, description: NOT_FOUND_ENTITY })
  async mentions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(mentionsQuerySchema)) query: MentionsQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<MentionsResponse> {
    return this.reads.mentions(user, id, query);
  }

  @Get('entities/:id/neighborhood')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: "An entity's neighbourhood",
    description:
      'The entity and what is connected to it, one or two hops out, as a graph slice: nodes ' +
      '(entities, and the commitments, decisions, claims and person facts about them) and ' +
      'every edge between them.\n\n' +
      '- A walk never continues **through** an item: an item is always a leaf.\n' +
      '- Edges touching an item are derived from the item itself (`virtual: true`); a stored ' +
      'relation always has an id of its own.\n' +
      '- **`as_of`** evaluates every relation and item at that instant — "who did Joe report to ' +
      'in January 2024" — with ranges half-open `[from, to)`.\n' +
      '- **`types`** keeps only those entity types / item kinds (the seed is always kept); ' +
      '**`relationTypes`** walks only along those edge types. Unknown keys are a **400**.\n' +
      `- At most \`limit\` nodes (≤ ${GRAPH_NODE_CAP}); \`truncated\` says more were reachable. ` +
      'The closest and best-connected nodes are kept.\n\n' +
      '`sensitive` person facts are never part of a slice. A query that runs longer than 3 s is ' +
      'a **503** with `details.reason: "graph_query_timeout"`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'hops', required: false, type: Number, description: '1 or 2 (default 1)' })
  @ApiQuery({ name: 'types', required: false, type: String, description: 'Comma-separated entity types / item kinds' })
  @ApiQuery({ name: 'relationTypes', required: false, type: String, description: 'Comma-separated relation types' })
  @ApiQuery({ name: 'as_of', required: false, type: String, description: 'YYYY-MM-DD or ISO 8601 with offset' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: `1-${GRAPH_NODE_CAP} (default 150)` })
  @ApiDataResponse(GraphSliceDto, { description: 'The neighbourhood' })
  @ApiResponse({ status: 400, description: 'Invalid parameter or unknown type key' })
  @ApiResponse({ status: 404, description: NOT_FOUND_ENTITY })
  @ApiResponse({ status: 503, description: 'The walk exceeded its 3 s budget (`graph_query_timeout`)' })
  async neighborhood(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(neighborhoodQuerySchema)) query: NeighborhoodQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<GraphSlice> {
    return this.neighborhoods.neighborhood(user, id, query);
  }

  // ---------------------------------------------------------------------------
  // Explorer
  // ---------------------------------------------------------------------------

  @Post('explore/expand')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Expand explorer nodes',
    description:
      'One hop out from each of up to ' +
      `${GRAPH_EXPAND_MAX_SEEDS} nodes, as one graph slice (the seeds come back at depth 0). ` +
      'A read, even though it is a `POST`: the node list does not fit a query string.\n\n' +
      '`types` and `relationTypes` narrow what the expansion may **add**. At most `cap` nodes ' +
      `(≤ ${GRAPH_NODE_CAP}); \`truncated\` says more were reachable.\n\n` +
      'Every `nodeIds` entry must be one of your readable entities or items: if **any** is not, ' +
      'the whole request is a **404** that does not say which.',
  })
  @ApiBody({ type: ExpandRequestDto })
  @ApiDataResponse(GraphSliceDto, { description: 'The expanded slice' })
  @ApiResponse({ status: 400, description: 'Invalid body or unknown type key' })
  @ApiResponse({ status: 404, description: 'At least one node is not one of your readable nodes' })
  @ApiResponse({ status: 503, description: 'The walk exceeded its 3 s budget (`graph_query_timeout`)' })
  async expand(
    @Body(new ZodValidationPipe(expandRequestSchema)) body: ExpandRequest,
    @CurrentUser() user: RequestUser,
  ): Promise<GraphSlice> {
    return this.neighborhoods.expand(user, body);
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  @Get('evidence')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'Resolve several citations',
    description:
      `Up to ${GRAPH_EVIDENCE_BATCH_MAX} evidence ids, comma-separated, resolved to links in ` +
      'request order — for rendering a row of citation chips in one request. An id that is not ' +
      'yours or does not exist is silently omitted.',
  })
  @ApiQuery({ name: 'ids', required: true, type: String, description: 'Comma-separated evidence ids' })
  @ApiDataResponse(EvidenceBatchResponseDto, { description: 'The citations that resolved' })
  @ApiResponse({ status: 400, description: `Missing, malformed, or more than ${GRAPH_EVIDENCE_BATCH_MAX} ids` })
  async evidenceBatch(
    @Query(new ZodValidationPipe(evidenceBatchQuerySchema)) query: EvidenceBatchQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<EvidenceBatchResponse> {
    return { items: await this.evidence.getMany(user.id, query.ids) };
  }

  @Get('evidence/:id')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'Resolve one citation',
    description:
      'A citation with a link you can open: a transcript segment (`/transcripts/:id?segment=…&t=…`, ' +
      'playable at the quoted moment) or the exact note version it was drawn from ' +
      '(`/notes/:id?v=…`). `textChanged`/`versionChanged` say the source has been edited since. ' +
      'When the source was deleted, or you can no longer view it (a revoked share), ' +
      '`available` is false and there is no link — but the `quote` is always returned.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(EvidenceLinkDto, { description: 'The citation' })
  @ApiResponse({ status: 404, description: 'No such evidence, or not yours' })
  async evidenceOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<EvidenceLink> {
    return this.evidence.getOne(user.id, id);
  }
}
