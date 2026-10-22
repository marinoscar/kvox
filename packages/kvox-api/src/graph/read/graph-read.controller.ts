import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import {
  EvidenceBatchResponseDto,
  ExpandRequestDto,
  GRAPH_EXPAND_MAX_SEEDS,
  GRAPH_NODE_CAP,
  GraphSliceDto,
  expandRequestSchema,
  neighborhoodQuerySchema,
  TimelineResponseDto,
  timelineQuerySchema,
  type TimelineQuery,
  type TimelineResponse,
  type ExpandRequest,
  type GraphSlice,
  type NeighborhoodQuery,
  EvidenceLinkDto,
  GRAPH_EVIDENCE_BATCH_MAX,
  GraphEntityDetailDto,
  ListEntitiesResponseDto,
  MentionsResponseDto,
  evidenceBatchQuerySchema,
  evidenceBySubjectQuerySchema,
  listEntitiesQuerySchema,
  mentionsQuerySchema,
  GRAPH_PATHS_MAX_HOPS,
  GRAPH_PATHS_MAX_K,
  GraphPathsResponseDto,
  GraphActivityResponseDto,
  graphActivityQuerySchema,
  GRAPH_ACTIVITY_MAX_IDS,
  type GraphActivityQuery,
  type GraphActivityResponse,
  graphPathsQuerySchema,
  type GraphPathsQuery,
  type GraphPathsResponse,
  type EvidenceBatchQuery,
  type EvidenceBatchResponse,
  type EvidenceBySubjectQuery,
  type EvidenceLink,
  type GraphEntityDetail,
  type ListEntitiesQuery,
  type ListEntitiesResponse,
  type MentionsQuery,
  type MentionsResponse,
} from './dto/graph-read.dto.js';
import { GraphEvidenceService } from './graph-evidence.service.js';
import { GraphNeighborhoodService } from './graph-neighborhood.service.js';
import { GraphPathsService } from './graph-paths.service.js';
import { GraphActivityService } from './graph-activity.service.js';
import { GraphReadService } from './graph-read.service.js';
import { KvoxAuth } from '../../core/index.js';
import { GRAPH_READ_PERMISSION } from '../graph.permissions.js';
import { CurrentGraphActor } from '../graph-actor.js';
import type { GraphActor } from '../graph-actor.js';
import { ApiDataResponse } from '../api-data-response.js';

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
    private readonly pathFinder: GraphPathsService,
    private readonly activityReader: GraphActivityService,
  ) {}

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  @Get('entities')
  @KvoxAuth(GRAPH_READ_PERMISSION)
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
    @CurrentGraphActor() user: GraphActor,
  ): Promise<ListEntitiesResponse> {
    return this.reads.listEntities(user, query);
  }

  @Get('entities/:id')
  @KvoxAuth(GRAPH_READ_PERMISSION)
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
    @CurrentGraphActor() user: GraphActor,
  ): Promise<GraphEntityDetail> {
    return this.reads.getEntity(user, id);
  }

  @Get('entities/:id/mentions')
  @KvoxAuth(GRAPH_READ_PERMISSION)
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
    @CurrentGraphActor() user: GraphActor,
  ): Promise<MentionsResponse> {
    return this.reads.mentions(user, id, query);
  }

  @Get('entities/:id/neighborhood')
  @KvoxAuth(GRAPH_READ_PERMISSION)
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
    @CurrentGraphActor() user: GraphActor,
  ): Promise<GraphSlice> {
    return this.neighborhoods.neighborhood(user, id, query);
  }

  @Get('entities/:id/timeline')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: "An entity's timeline",
    description:
      'Everything dated about this entity, newest first: the commitments, decisions, claims ' +
      'and person facts that name it (a **superseded** one stays, flagged `superseded: true` — ' +
      'history is the point), when each of its relations started and ended, and the meetings ' +
      'it attended, discussed or is part of. Each event carries up to five evidence ids and ' +
      'the total.\n\n' +
      '- **`as_of`** drops events after that instant.\n' +
      '- **`kinds`** keeps a subset of `commitment, decision, claim, person_fact, relation, meeting`.\n' +
      '- `sensitive` person facts appear only with **`includeSensitive=true`**.\n\n' +
      'Keyset-paginated by `nextCursor`. A query that runs longer than 3 s is a **503** with ' +
      '`details.reason: "graph_query_timeout"`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'as_of', required: false, type: String, description: 'YYYY-MM-DD or ISO 8601 with offset' })
  @ApiQuery({ name: 'kinds', required: false, type: String, description: 'Comma-separated event kinds' })
  @ApiQuery({ name: 'includeSensitive', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1-50 (default 25)' })
  @ApiDataResponse(TimelineResponseDto, { description: 'A page of events' })
  @ApiResponse({ status: 400, description: 'Invalid parameter, unknown kind, or a cursor from another list' })
  @ApiResponse({ status: 404, description: NOT_FOUND_ENTITY })
  @ApiResponse({ status: 503, description: 'The query exceeded its 3 s budget (`graph_query_timeout`)' })
  async timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(timelineQuerySchema)) query: TimelineQuery,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<TimelineResponse> {
    return this.reads.timeline(user, id, query);
  }

  // ---------------------------------------------------------------------------
  // Paths
  // ---------------------------------------------------------------------------

  @Get('paths')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Paths between two entities',
    description:
      'The top `k` evidence-weighted paths from one node to another, with the graph slice they ' +
      'cover: "how is Joe connected to the Copilot rollout?".\n\n' +
      '- A path has at most **`maxHops`** edges and passes only through entities: an item ' +
      '(commitment, decision, claim, person fact) can be an endpoint, never a stop on the way.\n' +
      '- **Score** = the mean of `log(1 + evidenceCount)` over the path\'s edges, discounted for ' +
      'each very-high-degree node it passes through. Paths are distinct (no repeated node set), best first.\n' +
      '- Every relation is walked both ways to find a connection, but each returned edge keeps its ' +
      'stored direction (`source` to `target`).\n' +
      '- **`as_of`** evaluates relations and items at that instant. **`types`** limits the entity ' +
      'types / item kinds a path may pass through; **`relationTypes`** the edges it may follow. ' +
      'Unknown keys are a **400**.\n' +
      '- `paths: []` means nothing connects the two within `maxHops`. `truncated` says a per-hop ' +
      'cap was hit (a hub), so a stronger path than those returned may exist.\n\n' +
      '`sensitive` person facts are never on a path. If either node is not one of your readable ' +
      'nodes the answer is a **404** that does not say which. A query that runs longer than 3 s is ' +
      'a **503** with `details.reason: "graph_query_timeout"`.',
  })
  @ApiQuery({ name: 'from', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'to', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'k', required: false, type: Number, description: `1-${GRAPH_PATHS_MAX_K} (default 3)` })
  @ApiQuery({ name: 'maxHops', required: false, type: Number, description: `1-${GRAPH_PATHS_MAX_HOPS} (default 4)` })
  @ApiQuery({ name: 'types', required: false, type: String, description: 'Comma-separated entity types / item kinds a path may pass through' })
  @ApiQuery({ name: 'relationTypes', required: false, type: String, description: 'Comma-separated relation types a path may follow' })
  @ApiQuery({ name: 'as_of', required: false, type: String, description: 'YYYY-MM-DD or ISO 8601 with offset' })
  @ApiDataResponse(GraphPathsResponseDto, { description: 'The paths and their slice' })
  @ApiResponse({ status: 400, description: 'Invalid parameter, `from` equal to `to`, or unknown type key' })
  @ApiResponse({ status: 404, description: 'Either node is not one of your readable nodes' })
  @ApiResponse({ status: 503, description: 'The search exceeded its 3 s budget (`graph_query_timeout`)' })
  async paths(
    @Query(new ZodValidationPipe(graphPathsQuerySchema)) query: GraphPathsQuery,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<GraphPathsResponse> {
    return this.pathFinder.paths(user, query);
  }

  // ---------------------------------------------------------------------------
  // Activity (the TimeBar)
  // ---------------------------------------------------------------------------

  @Get('activity')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Evidence activity over time',
    description:
      'Evidence counts per **week** or **month** for the given entities and the relations among ' +
      'them, stacked by entity type: what the explorer TimeBar draws.\n\n' +
      '- A citation of an entity counts once for it; a citation of a relation whose two ends are both ' +
      'in `ids` counts once for each end. `total` is the sum of `byType`.\n' +
      '- The time of a citation is its transcript\'s `recorded_at` or its note\'s `created_at` ' +
      '(the meeting date), falling back to the citation\'s own creation time when the source is gone.\n' +
      '- `from` (inclusive) and `to` (exclusive) restrict the evidence time. Buckets are UTC; weeks start Monday. ' +
      'Only buckets with evidence are returned.\n' +
      `- At most **${GRAPH_ACTIVITY_MAX_IDS} ids**; more is a **400**.\n\n` +
      '`sensitive` person facts contribute nothing. If any id is not one of your readable nodes the ' +
      'answer is a **404** that does not say which. A query that runs longer than 3 s is a **503** ' +
      'with `details.reason: "graph_query_timeout"`.',
  })
  @ApiQuery({ name: 'ids', required: true, type: String, description: `Comma-separated entity ids, at most ${GRAPH_ACTIVITY_MAX_IDS}` })
  @ApiQuery({ name: 'bucket', required: false, enum: ['week', 'month'], description: 'Default month' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD or ISO 8601 with offset' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD or ISO 8601 with offset' })
  @ApiDataResponse(GraphActivityResponseDto, { description: 'The stacked buckets and the per-entity series' })
  @ApiResponse({ status: 400, description: 'Invalid parameter, or more than the id limit' })
  @ApiResponse({ status: 404, description: 'An id is not one of your readable nodes' })
  @ApiResponse({ status: 503, description: 'The query exceeded its 3 s budget (`graph_query_timeout`)' })
  async activity(
    @Query(new ZodValidationPipe(graphActivityQuerySchema)) query: GraphActivityQuery,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<GraphActivityResponse> {
    return this.activityReader.activity(user, query);
  }

  // ---------------------------------------------------------------------------
  // Explorer
  // ---------------------------------------------------------------------------

  @Post('explore/expand')
  @KvoxAuth(GRAPH_READ_PERMISSION)
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
    @CurrentGraphActor() user: GraphActor,
  ): Promise<GraphSlice> {
    return this.neighborhoods.expand(user, body);
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  @Get('evidence')
  @KvoxAuth(GRAPH_READ_PERMISSION)
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
    @CurrentGraphActor() user: GraphActor,
  ): Promise<EvidenceBatchResponse> {
    return { items: await this.evidence.getMany(user.id, query.ids) };
  }

  // Declared before `evidence/:id`, or `by-subject` would be read as an id.
  @Get('evidence/by-subject')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Citations of one entity, relation or item',
    description:
      'The newest-source-first citations (at most 50) that support one entity, relation or item, ' +
      'resolved to links like `GET /api/graph/evidence`: what the explorer inspector shows under a ' +
      'selected edge or node. A subject that is not yours or not in your reviewed graph answers 404, ' +
      'and so does an item holding a `sensitive` personal fact: its evidence is never returned.',
  })
  @ApiQuery({ name: 'kind', required: true, enum: ['entity', 'relation', 'item'] })
  @ApiQuery({ name: 'id', required: true, type: String, description: 'The subject id' })
  @ApiDataResponse(EvidenceBatchResponseDto, { description: 'The citations, newest source first' })
  @ApiResponse({ status: 400, description: 'Missing or malformed `kind` or `id`' })
  @ApiResponse({ status: 404, description: 'No such subject, or not yours' })
  async evidenceBySubject(
    @Query(new ZodValidationPipe(evidenceBySubjectQuerySchema)) query: EvidenceBySubjectQuery,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<EvidenceBatchResponse> {
    return { items: await this.evidence.forSubject(user.id, query.kind, query.id) };
  }

  @Get('evidence/:id')
  @KvoxAuth(GRAPH_READ_PERMISSION)
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
    @CurrentGraphActor() user: GraphActor,
  ): Promise<EvidenceLink> {
    return this.evidence.getOne(user.id, id);
  }
}
