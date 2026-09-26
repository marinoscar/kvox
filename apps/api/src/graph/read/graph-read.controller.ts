import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  EvidenceBatchResponseDto,
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
