import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  DistinctPairBodyDto,
  DistinctPairResponseDto,
  MergeEntityBodyDto,
  MergeEntityResponseDto,
  ReverseMergeBodyDto,
  ReverseMergeResponseDto,
  distinctPairBodySchema,
  mergeEntityBodySchema,
  reverseMergeBodySchema,
  type DistinctPairBody,
  type DistinctPairResponse,
  type MergeEntityBody,
  type MergeEntityResponse,
  type ReverseMergeResponse,
} from './dto/resolution.dto';
import { ResolutionActionsService } from './resolution-actions.service';

// =============================================================================
// GraphResolutionController (#364, epic #346; docs/specs/ontology.md §7, §12)
// =============================================================================
//
// The human side of entity resolution: merge two entities, undo a merge, and
// record "these two are not the same". All `graph:write`; every entity id is
// authorised through `GraphAccessService` — no access is a 404, never a 403,
// and a merged tombstone is a 404 too.
// =============================================================================

@ApiTags('Graph')
@Controller('graph')
export class GraphResolutionController {
  constructor(private readonly actions: ResolutionActionsService) {}

  @Post('entities/:id/merge')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge an entity into another',
    description:
      'Merges `:id` **into** `intoId`: `:id` becomes a tombstone (`reviewStatus: merged`, ' +
      '`mergedIntoId` set) and everything that named it — relations, facts, citations, mentions and ' +
      'aliases — now names the survivor. Its label becomes one of the survivor\'s aliases. Relations ' +
      'that became exact duplicates are folded into one (their citations kept), and a relation that ' +
      'would now point at itself is retired.\n\n' +
      'Every change is recorded, so `POST /api/graph/merges/{id}/reverse` can undo exactly this merge.\n\n' +
      'Both entities must be yours, live and of the same **type** (a different type is a **400** with ' +
      '`details.reason: "type_mismatch"`). Merging two entities you have both reviewed is allowed: ' +
      'it is your decision.\n\n' +
      'Requires `graph:write`. **404**: either entity missing, not yours, or already merged. **403**: ' +
      'your own entities, without `graph:write`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'The entity merged away.' })
  @ApiBody({ type: MergeEntityBodyDto })
  @ApiDataResponse(MergeEntityResponseDto, { description: 'The merge and the survivor' })
  @ApiResponse({ status: 400, description: 'Same id twice, a different type (`type_mismatch`), or an invalid body' })
  @ApiResponse({ status: 403, description: 'Your own entities, without `graph:write`' })
  @ApiResponse({ status: 404, description: 'Either entity missing, not yours, or merged' })
  async merge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(mergeEntityBodySchema)) body: MergeEntityBody,
    @CurrentUser() user: RequestUser,
  ): Promise<MergeEntityResponse> {
    return this.actions.merge(id, body.intoId, user);
  }

  @Post('merges/:id/reverse')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reverse a merge',
    description:
      'Restores the merged entity exactly as it was and gives back everything the merge moved: ' +
      'relations, facts, citations, mentions and aliases, folded duplicates and retired self-links. ' +
      'Anything deleted or moved elsewhere since the merge is listed in `skipped` instead.\n\n' +
      'Afterwards both entities are re-embedded and the restored one is re-checked for likely ' +
      'duplicates (a suggestion to review, never an automatic merge).\n\n' +
      'Requires `graph:write`. **404**: no such merge, not yours, or already reversed. **409** ' +
      '`revert_conflict`: the survivor has since been merged into another entity ' +
      '(`details.conflicts: [{ entity: "survivor", id, mergedInto }]`) — reverse that merge first.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'The merge (`merge.id` from the merge response).' })
  @ApiBody({ type: ReverseMergeBodyDto })
  @ApiDataResponse(ReverseMergeResponseDto, { description: 'The reversed merge' })
  @ApiResponse({ status: 400, description: 'A non-empty body' })
  @ApiResponse({ status: 403, description: 'Your own merge, without `graph:write`' })
  @ApiResponse({ status: 404, description: 'No such merge, not yours, or already reversed' })
  @ApiResponse({ status: 409, description: '`revert_conflict` — the survivor was merged again since' })
  async reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reverseMergeBodySchema)) _body: Record<string, never>,
    @CurrentUser() user: RequestUser,
  ): Promise<ReverseMergeResponse> {
    return this.actions.reverse(id, user);
  }

  @Post('distinct-pairs')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record that two entities are not the same',
    description:
      'Records a confirmed "not the same" pair. Resolution never proposes one as a match for the ' +
      'other again — not in a new extraction, not in a bulk re-check.\n\n' +
      'Order does not matter; the answer is normalized so `aId < bId`. Recording a pair twice is ' +
      'harmless (`created: false`).\n\n' +
      'Requires `graph:write`. **400**: the same id twice. **404**: either entity missing, not ' +
      'yours, or merged.',
  })
  @ApiBody({ type: DistinctPairBodyDto })
  @ApiDataResponse(DistinctPairResponseDto, { description: 'The recorded pair' })
  @ApiResponse({ status: 400, description: 'The same id twice, or an invalid body' })
  @ApiResponse({ status: 403, description: 'Your own entities, without `graph:write`' })
  @ApiResponse({ status: 404, description: 'Either entity missing, not yours, or merged' })
  async distinctPair(
    @Body(new ZodValidationPipe(distinctPairBodySchema)) body: DistinctPairBody,
    @CurrentUser() user: RequestUser,
  ): Promise<DistinctPairResponse> {
    return this.actions.recordDistinct(body.aId, body.bId, user);
  }
}
