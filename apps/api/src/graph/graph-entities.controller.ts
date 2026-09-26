import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  GraphEntityDto,
  PatchEntityBodyDto,
  patchEntitySchema,
  type GraphEntityResponse,
  type PatchEntityDto,
} from './dto/graph-entity.dto';
import {
  ForgetEntityBodyDto,
  ForgetEntityResponseDto,
  type ForgetEntityResponse,
} from './dto/graph-forget.dto';
import { GraphEntitiesService } from './graph-entities.service';

// =============================================================================
// GraphEntitiesController (#355, epic #344; docs/specs/ontology.md §8, §12)
// =============================================================================
//
// `/api/graph/entities`. Today two routes: the manual entity edit and
// "Forget this person" (#357). #370 adds
// the read routes here. PER-ROUTE `@Auth`, like `GraphController`; every route
// authorises its row through `GraphAccessService` — no access is a 404, never
// a 403.
// =============================================================================

@ApiTags('Graph')
@Controller('graph/entities')
export class GraphEntitiesController {
  constructor(private readonly entities: GraphEntitiesService) {}

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @ApiOperation({
    summary: 'Edit an entity',
    description:
      'Rename an entity, change its attributes, and add or remove its aliases — a manual edit, ' +
      'one of the two ways anything changes in your graph outside a reviewed proposal.\n\n' +
      '- **`label`**: the new display name. The previous name is **kept as an alias**, so ' +
      'matching still finds the entity by what it used to be called.\n' +
      '- **`props`**: a merge — `key → value` sets that attribute, `key → null` clears it, and ' +
      'keys you do not send are unchanged. The merged result must validate against your ' +
      'effective ontology (`GET /api/graph/ontology`); an undeclared key is a 400 naming it in ' +
      '`details.issues`.\n' +
      '- **`addAliases`**: other names. One that normalizes to an alias the entity already has ' +
      'is ignored, not an error.\n' +
      '- **`removeAliasIds`**: aliases to drop. The alias that is the current label cannot be ' +
      'removed.\n\n' +
      'An `accepted` entity becomes `edited` once anything changes. Its citations are ' +
      'untouched: an edit is curation of a fact that already has evidence.\n\n' +
      '**`type` is refused** (400): change a type through a proposal.\n\n' +
      'Requires `graph:write`. No access, or a merged entity, is a **404**; your own entity ' +
      'without `graph:write` is a **403**.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: PatchEntityBodyDto })
  @ApiDataResponse(GraphEntityDto, { description: 'The updated entity, with its aliases' })
  @ApiResponse({
    status: 400,
    description:
      'Invalid props (`details.issues`), `type` sent, an empty body, or an alias that is empty once normalized',
  })
  @ApiResponse({ status: 403, description: 'Your own entity, without `graph:write`' })
  @ApiResponse({ status: 404, description: 'No such entity, not yours, or merged' })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(patchEntitySchema)) dto: PatchEntityDto,
    @CurrentUser() user: RequestUser,
  ): Promise<GraphEntityResponse> {
    return this.entities.patch(id, dto, user);
  }

  @Post(':id/forget')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Forget a person',
    description:
      'Queues a `kg.purge` job that removes this **Person** and everything your graph derived ' +
      'about them: the entity and every entity previously merged into it, its aliases, every ' +
      'relation naming them (including the link from a transcript speaker), every fact where ' +
      'they are the subject, owner or counterparty, their mentions, their citations, and ' +
      'draft proposal items that would re-create them.\n\n' +
      '**Your recordings and notes are not changed** — they are your own content, and the ' +
      "person's name stays in them.\n\n" +
      'The body must be exactly `{ "confirmation": "FORGET" }`. The person stays visible until ' +
      'the job completes (normally within seconds). Asking again while a deletion is pending ' +
      'or running returns that same job.\n\n' +
      'Requires `graph:write`. **400**: a missing or wrong confirmation, or an entity that is ' +
      'not a Person. **404**: no such entity, not yours, or merged. **403**: your own entity, ' +
      'without `graph:write`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: ForgetEntityBodyDto })
  @ApiDataResponse(ForgetEntityResponseDto, {
    status: 202,
    description: 'The queued (or already queued) deletion job',
  })
  @ApiResponse({
    status: 400,
    description: 'Confirmation missing or not `FORGET`, or the entity is not a Person',
  })
  @ApiResponse({ status: 403, description: 'Your own entity, without `graph:write`' })
  @ApiResponse({ status: 404, description: 'No such entity, not yours, or merged' })
  async forget(
    @Param('id', ParseUUIDPipe) id: string,
    // Validated in the service, so a wrong confirmation answers with its own
    // message ("Type FORGET to confirm.") rather than a generic validation 400.
    @Body() body: unknown,
    @CurrentUser() user: RequestUser,
  ): Promise<ForgetEntityResponse> {
    return this.entities.forget(id, body, user);
  }
}
