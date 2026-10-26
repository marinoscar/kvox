import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe, createZodDto } from 'nestjs-zod';
import {
  createSynonymGroupSchema,
  listSynonymGroupsResponseSchema,
  synonymGroupSchema,
  updateSynonymGroupSchema,
  SYNONYM_MAX_GROUPS,
  type CreateSynonymGroupDto,
  type ListSynonymGroupsResponse,
  type SynonymGroup,
  type UpdateSynonymGroupDto,
} from '@marinoscar/kvox-contract/graph';

import { KvoxAuth } from '../../core/index.js';
import { ApiDataResponse } from '../api-data-response.js';
import { CurrentGraphActor } from '../graph-actor.js';
import type { GraphActor } from '../graph-actor.js';
import { GRAPH_READ_PERMISSION, GRAPH_WRITE_PERMISSION } from '../graph.permissions.js';
import { SynonymsService } from './synonyms.service.js';

class CreateSynonymGroupBodyDto extends createZodDto(createSynonymGroupSchema) {}
class UpdateSynonymGroupBodyDto extends createZodDto(updateSynonymGroupSchema) {}
class SynonymGroupDto extends createZodDto(synonymGroupSchema) {}
class ListSynonymGroupsResponseDto extends createZodDto(listSynonymGroupsResponseSchema) {}

// =============================================================================
// GraphSynonymsController (issue #767)
// =============================================================================
//
// `/api/graph/synonyms`: your own groups of names that mean the same thing.
// Owner-only: another user's group is a 404, never a 403.
// =============================================================================

/**
 * GraphSynonymsController: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Graph')
@Controller('graph/synonyms')
export class GraphSynonymsController {
  constructor(private readonly synonyms: SynonymsService) {}

  @Get()
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'List your synonym groups',
    description: 'Your personal synonym dictionary, oldest first. Requires `graph:read`.',
  })
  @ApiDataResponse(ListSynonymGroupsResponseDto, { description: 'Your synonym groups' })
  async list(@CurrentGraphActor() user: GraphActor): Promise<ListSynonymGroupsResponse> {
    return this.synonyms.list(user);
  }

  @Post()
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Add a synonym group',
    description:
      'Names that mean the same thing, for example "EY" and "Ernst & Young". Resolution matches a mention to an entity ' +
      'known by any name of the group, the possible-duplicates list proposes entities whose names share a group, and ' +
      'entity search finds them under any name. Optional `entityType` limits the group to one type. Terms are compared ' +
      `case-, spacing- and edge-punctuation-insensitively. At most ${SYNONYM_MAX_GROUPS} groups. Requires \`graph:write\`.`,
  })
  @ApiBody({ type: CreateSynonymGroupBodyDto })
  @ApiDataResponse(SynonymGroupDto, { status: 201, description: 'The new group' })
  @ApiResponse({ status: 400, description: '`synonyms_too_few` (fewer than two distinct names), an invalid term or an unknown entity type' })
  @ApiResponse({ status: 409, description: '`synonyms_limit`' })
  async create(
    @Body(new ZodValidationPipe(createSynonymGroupSchema)) dto: CreateSynonymGroupDto,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<SynonymGroup> {
    return this.synonyms.create(dto, user);
  }

  @Patch(':id')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Replace a synonym group',
    description: 'Replaces the group\'s terms and entity type (omit `entityType` or send null for every type). Requires `graph:write`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: UpdateSynonymGroupBodyDto })
  @ApiDataResponse(SynonymGroupDto, { description: 'The updated group' })
  @ApiResponse({ status: 400, description: '`synonyms_too_few`, an invalid term or an unknown entity type' })
  @ApiResponse({ status: 404, description: 'No such group, or not yours' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateSynonymGroupSchema)) dto: UpdateSynonymGroupDto,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<SynonymGroup> {
    return this.synonyms.update(id, dto, user);
  }

  @Delete(':id')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a synonym group', description: 'Requires `graph:write`.' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'No such group, or not yours' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentGraphActor() user: GraphActor): Promise<void> {
    await this.synonyms.remove(id, user);
  }
}
