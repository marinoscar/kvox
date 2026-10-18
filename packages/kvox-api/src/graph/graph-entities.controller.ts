import { Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import {
  GraphEntityDto,
  PatchEntityBodyDto,
  patchEntitySchema,
  type GraphEntityResponse,
  type PatchEntityDto,
} from './dto/graph-entity.dto.js';
import {
  ForgetEntityBodyDto,
  ForgetEntityResponseDto,
  type ForgetEntityResponse,
} from './dto/graph-forget.dto.js';
import { GraphEntitiesService } from './graph-entities.service.js';
import { GraphRelationEditsService } from './graph-relation-edits.service.js';
import {
  CreateManualRelationBodyDto,
  CreateManualRelationResponseDto,
  RemoveManualRelationResponseDto,
  createManualRelationSchema,
  type CreateManualRelationDto,
  type CreateManualRelationResponse,
  type RemoveManualRelationResponse,
} from './dto/graph-relation-edit.dto.js';
import { KvoxAuth } from '../core/index.js';
import { GRAPH_WRITE_PERMISSION } from './graph.permissions.js';
import { CurrentGraphActor } from './graph-actor.js';
import type { GraphActor } from './graph-actor.js';
import { ApiDataResponse } from './api-data-response.js';

// =============================================================================
// GraphEntitiesController (#355, epic #344; docs/specs/ontology.md §8, §12)
// =============================================================================
//
// `/api/graph/entities`. The manual entity edit, "Forget this person" (#357)
// and the manual relation edit (#586: set / remove a manager, employer or
// role). #370 adds
// the read routes here. PER-ROUTE `@Auth`, like `GraphController`; every route
// authorises its row through `GraphAccessService` — no access is a 404, never
// a 403.
// =============================================================================

@ApiTags('Graph')
@Controller('graph/entities')
export class GraphEntitiesController {
  constructor(
    private readonly entities: GraphEntitiesService,
    private readonly relationEdits: GraphRelationEditsService,
  ) {}

  @Patch(':id')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
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
    @CurrentGraphActor() user: GraphActor,
  ): Promise<GraphEntityResponse> {
    return this.entities.patch(id, dto, user);
  }

  @Post(':id/forget')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
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
    @CurrentGraphActor() user: GraphActor,
  ): Promise<ForgetEntityResponse> {
    return this.entities.forget(id, body, user);
  }

  @Post(':id/relations')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Set a person's manager, employer or role",
    description:
      'A manual relation edit — part of the manual edit, one of the two ways anything changes in ' +
      'your graph outside a reviewed proposal. From the Person `:id`:\n\n' +
      '- **`REPORTS_TO`** → a Person (their manager);\n' +
      '- **`WORKS_FOR`** → an Organization (their employer);\n' +
      '- **`HAS_ROLE`** → an Organization, with `props.title` (required) and `props.businessUnit`.\n\n' +
      'The fact holds from `validFrom` (`YYYY-MM-DD`, default today) and stays open. All three are ' +
      'normally exclusive: a still-open edge of the same type to someone else (for `HAS_ROLE`, at the ' +
      'same organization) that started earlier is **closed** at that date and linked to the new one ' +
      '(`closedRelationIds`), exactly as committing a proposal closes it. The same fact already in ' +
      'your graph is not duplicated: the citation is added to it (`created: false`). An undated edge ' +
      'of a different fact cannot be ordered against a date, so it stays open and the response is ' +
      'flagged `unordered`.\n\n' +
      'The relation is cited by **you**: one evidence row whose source kind is `manual` ' +
      '("Set by hand: …"), so it has evidence like every other fact.\n\n' +
      'Requires `graph:write`. Either entity missing, not yours, or merged is a **404**; a wrong ' +
      'endpoint type is a **400** naming it in `details.issues`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'The Person.' })
  @ApiBody({ type: CreateManualRelationBodyDto })
  @ApiDataResponse(CreateManualRelationResponseDto, { description: 'What the edit wrote' })
  @ApiResponse({ status: 400, description: 'An invalid body, or an endpoint of the wrong type (`details.issues`)' })
  @ApiResponse({ status: 403, description: 'Your own entity, without `graph:write`' })
  @ApiResponse({ status: 404, description: 'Either entity: no such entity, not yours, or merged' })
  async setRelation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createManualRelationSchema)) dto: CreateManualRelationDto,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<CreateManualRelationResponse> {
    return this.relationEdits.set(id, dto, user);
  }

  @Delete(':id/relations/:relationId')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Remove a wrong manager, employer or role',
    description:
      'Removes a `REPORTS_TO`, `WORKS_FOR` or `HAS_ROLE` relation FROM the entity `:id` as **wrong** — ' +
      'a correction, not an end date: the relation is kept as `rejected` and never shown again, its ' +
      'range untouched. An edge it closed when it was set is reopened (`reopenedRelationIds`). To ' +
      'record that a true fact ended, set the next one instead.\n\n' +
      'Requires `graph:write`. **404**: either id missing, not yours, merged, or a relation that does ' +
      'not start at `:id`. **400**: another relation type.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'relationId', type: String, format: 'uuid' })
  @ApiDataResponse(RemoveManualRelationResponseDto, { description: 'The removed relation' })
  @ApiResponse({ status: 400, description: 'Not a REPORTS_TO, WORKS_FOR or HAS_ROLE relation' })
  @ApiResponse({ status: 403, description: 'Your own entity, without `graph:write`' })
  @ApiResponse({ status: 404, description: 'No such entity or relation, not yours, or not from this entity' })
  async removeRelation(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('relationId', ParseUUIDPipe) relationId: string,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<RemoveManualRelationResponse> {
    return this.relationEdits.remove(id, relationId, user);
  }
}
