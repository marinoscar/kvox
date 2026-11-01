import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe, createZodDto } from 'nestjs-zod';
import {
  createSelfPersonSchema,
  graphSelfEntitySchema,
  graphSelfResponseSchema,
  type CreateSelfPersonDto,
  type GraphSelfEntity,
  type GraphSelfResponse,
} from '@marinoscar/kvox-contract/graph';

import { KvoxAuth } from '../../core/index.js';
import { ApiDataResponse } from '../api-data-response.js';
import { CurrentGraphActor } from '../graph-actor.js';
import type { GraphActor } from '../graph-actor.js';
import { GraphEntitiesService } from '../graph-entities.service.js';
import { GRAPH_READ_PERMISSION, GRAPH_WRITE_PERMISSION } from '../graph.permissions.js';
import { GraphSelfService } from './graph-self.service.js';

export class GraphSelfResponseDto extends createZodDto(graphSelfResponseSchema) {}
export class CreateSelfPersonBodyDto extends createZodDto(createSelfPersonSchema) {}
export class GraphSelfEntityDto extends createZodDto(graphSelfEntitySchema) {}

// =============================================================================
// GraphSelfController (#778; docs/specs/ontology.md §6.1)
// =============================================================================
//
// `GET /api/graph/self`: the Person the caller chose as themselves, and, while none is
// chosen, Persons matching their profile name. The choice itself is written through the
// `graph` user-settings namespace (`PATCH /api/user-settings`, `graph.self.entityId`).
// =============================================================================

@ApiTags('Graph')
@Controller('graph/self')
export class GraphSelfController {
  constructor(
    private readonly self: GraphSelfService,
    private readonly entities: GraphEntitiesService,
  ) {}

  @Get()
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Get who you are in your graph',
    description:
      'The Person you chose as yourself (`graph.self.entityId` in your user settings), resolved: a ' +
      'Person merged into another is followed to it, and one that is no longer a live Person of ' +
      'yours reads as `null`.\n\n' +
      'While nothing is chosen, `suggestions` lists up to 5 live Persons whose label or alias ' +
      'equals your profile name. A suggestion is never applied by itself: choose one with ' +
      '`PATCH /api/user-settings`.\n\n' +
      'Requires `graph:read`. Always 200 for your own graph.',
  })
  @ApiDataResponse(GraphSelfResponseDto, { description: 'The chosen Person, or suggestions' })
  async get(@CurrentGraphActor() user: GraphActor): Promise<GraphSelfResponse> {
    const answer = await this.self.describe(user.id);
    const wire = (p: { entityId: string; label: string; aliases: readonly string[] }) => ({
      id: p.entityId,
      label: p.label,
      aliases: [...p.aliases],
    });
    return {
      self: answer.self ? wire(answer.self) : null,
      suggestions: answer.suggestions.map(wire),
      displayName: answer.displayName,
    };
  }

  @Post('person')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a Person for yourself',
    description:
      'Creates a Person in your graph to stand for you, for when none exists yet, cited as ' +
      '"Set by hand". It does not choose it: set `graph.self.entityId` with `PATCH /api/user-settings` ' +
      'to the returned `id`. Requires `graph:write`.',
  })
  @ApiBody({ type: CreateSelfPersonBodyDto })
  @ApiDataResponse(GraphSelfEntityDto, { status: 201, description: 'The new Person' })
  @ApiResponse({ status: 400, description: 'An empty or too long name' })
  async createPerson(
    @Body(new ZodValidationPipe(createSelfPersonSchema)) body: CreateSelfPersonDto,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<GraphSelfEntity> {
    return this.entities.createSelfPerson(user, body.label);
  }
}
