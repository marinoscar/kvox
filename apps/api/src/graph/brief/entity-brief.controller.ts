import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  EntityBriefResponseDto,
  entityBriefQuerySchema,
  type EntityBriefQuery,
  type EntityBriefResponse,
} from './dto/entity-brief.dto';
import { EntityBriefService } from './entity-brief.service';

// =============================================================================
// EntityBriefController (#372, epic #347; docs/specs/ontology.md §9.1, §9.2)
// =============================================================================
//
// `GET /api/graph/entities/:id/brief` — `graph:read`, the caller's own graph
// only, 404 never 403 for an entity that is not theirs.
//
// NEVER A 409 AND NEVER A PROVIDER CALL: the response is assembled from stored
// rows. Whether the AI digest can be refreshed is reported in
// `digestUnavailable`, so the deterministic sections always render.
// =============================================================================

@ApiTags('Graph')
@Controller('graph')
export class EntityBriefController {
  constructor(private readonly briefs: EntityBriefService) {}

  @Get('entities/:id/brief')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: "An entity's brief",
    description:
      '"What\'s the latest on …?" in one call, assembled from stored rows only — **no AI model is ever ' +
      'called by this request**, and it never answers 409.\n\n' +
      '- **`sections`**: What changed · Decisions · Open commitments (theirs / yours) · Risks / claims · ' +
      'People changes. Deterministic, and every entry cites at least one evidence id. `sensitive` person ' +
      'facts are never included.\n' +
      '- **`digest`**: the latest AI summary the `kg.entity_digest` job stored, each statement cited. ' +
      'When it is stale and nothing is queued, this request enqueues a refresh (`digestPending: true`), ' +
      'or says why it cannot (`digestUnavailable`).\n' +
      '- **`related`**: transcripts and notes, full-text/semantic search fused with the documents your graph ' +
      'cites for this entity (`inGraph`).\n\n' +
      '`since` defaults to when you last opened this brief; the visit is recorded unless `markViewed=false` ' +
      'or `as_of` is set. With `as_of`, the brief describes that instant and `digest` is null.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'since', required: false, type: String })
  @ApiQuery({ name: 'as_of', required: false, type: String })
  @ApiQuery({ name: 'markViewed', required: false, enum: ['true', 'false'] })
  @ApiDataResponse(EntityBriefResponseDto, { description: 'The brief' })
  @ApiResponse({ status: 400, description: 'Invalid `since`, `as_of` or `markViewed`' })
  @ApiResponse({ status: 404, description: 'No such entity, not yours, not part of your reviewed graph, or merged' })
  async brief(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(entityBriefQuerySchema)) query: EntityBriefQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<EntityBriefResponse> {
    return this.briefs.getBrief(user, id, {
      since: query.since,
      asOf: query.as_of,
      markViewed: query.markViewed,
      enqueueStaleDigest: true,
    });
  }
}
