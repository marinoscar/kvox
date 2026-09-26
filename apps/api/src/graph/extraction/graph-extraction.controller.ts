import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  ExtractionEstimateDto,
  RequestExtractionBodyDto,
  RequestExtractionResponseDto,
  extractionEstimateQuerySchema,
  requestExtractionSchema,
  type ExtractionEstimate,
  type ExtractionEstimateQuery,
  type RequestExtractionDto,
  type RequestExtractionResponse,
} from './dto/extraction.dto';
import { GraphExtractionService } from './graph-extraction.service';

// =============================================================================
// GraphExtractionController (#363, epic #346; docs/specs/ontology.md §6, §12)
// =============================================================================
//
// Two routes: request an extraction of one of your notes (a draft proposal you
// review before anything reaches your graph), and estimate one. PER-ROUTE
// `@Auth`, like every graph controller. A note you cannot see is a 404, never a
// 403.
// =============================================================================

const CONFLICTS =
  '`details.reason`: `graph_disabled` (connected knowledge is off for this deployment), ' +
  '`ai_not_configured`, `ai_key_missing` (the run uses your own key), `model_lacks_capability` ' +
  '(the model cannot return structured output), `extraction_running` (this note already has an ' +
  'extraction in progress), `note_not_ready` (the note is not finished).';

const REQUEST_PIPE = new ZodValidationPipe(requestExtractionSchema);

@ApiTags('Graph')
@Controller('graph')
export class GraphExtractionController {
  constructor(private readonly extraction: GraphExtractionService) {}

  @Post('notes/:noteId/extract')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Extract a graph proposal from a note',
    description:
      'Queues a `kg.extract` job that reads this note (at its current version), its source ' +
      'transcript and your effective ontology, makes **one** structured-output call on **your own** ' +
      'AI key, and writes a **draft proposal**: people, organizations, projects, relations, ' +
      'decisions, commitments and claims, each citing the transcript line or note span it came ' +
      'from. Nothing is added to your graph until you review and commit the proposal.\n\n' +
      '`model` overrides the `graph.extract` task model with another model this deployment ' +
      'permits. `userGuidance` narrows the run: `pinnedEntityIds` to focus on, `entityTypes` / ' +
      '`relationTypes` to propose (absent = every type in your ontology), and free-text ' +
      '`instructions` that narrow or focus — never override — the extraction rules.\n\n' +
      'The proposal is created at once with `status: "extracting"`; poll it until it becomes ' +
      '`draft` (or `failed`). A newer draft for the same note discards the older one.\n\n' +
      'Requires `graph:write`. **400**: a model this deployment does not permit; an unknown type ' +
      'key (`details.unknownTypes`); a pinned id that is not a live entity of yours ' +
      '(`details.invalidPinnedIds`); a prompt over the token budget (`details: { promptTokens, ' +
      'availableInputTokens, model }`). **404**: no such note, deleted, or not yours. **409**: ' +
      CONFLICTS,
  })
  @ApiParam({ name: 'noteId', type: String, format: 'uuid' })
  @ApiBody({ type: RequestExtractionBodyDto })
  @ApiDataResponse(RequestExtractionResponseDto, {
    status: 202,
    description: 'The extracting proposal and what the run will cost',
  })
  @ApiResponse({ status: 400, description: 'Unpermitted model, unknown types, invalid pins, or over budget' })
  @ApiResponse({ status: 403, description: 'Missing `graph:write`' })
  @ApiResponse({ status: 404, description: 'No such note, deleted, or not yours' })
  @ApiResponse({ status: 409, description: CONFLICTS })
  async request(
    @Param('noteId', ParseUUIDPipe) noteId: string,
    // Validated here rather than by a parameter pipe so an EMPTY body (a plain
    // "extract this note" click) is the same as `{}`.
    @Body() body: unknown,
    @CurrentUser() user: RequestUser,
  ): Promise<RequestExtractionResponse> {
    const dto = (await REQUEST_PIPE.transform(body ?? {}, { type: 'body' })) as RequestExtractionDto;
    return this.extraction.request(user, noteId, dto);
  }

  @Get('extract/estimate')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'Estimate a graph extraction',
    description:
      'What extracting this note would cost, counted with the provider\'s tokenizer over the exact ' +
      'prompt a run would send (reviewer guidance excluded — at most 2,000 characters). Needs no ' +
      'API key: `keyConfigured` says whether you have one.\n\n' +
      'Requires `graph:read`. **400**: a model this deployment does not permit. **404**: no such ' +
      'note, deleted, or not yours. **409** `details.reason`: `graph_disabled`, ' +
      '`ai_not_configured`, `model_lacks_capability`.',
  })
  @ApiQuery({ name: 'noteId', type: String, format: 'uuid', required: true })
  @ApiQuery({ name: 'model', type: String, required: false })
  @ApiDataResponse(ExtractionEstimateDto, { description: 'The estimate' })
  @ApiResponse({ status: 400, description: 'Unpermitted model or invalid query' })
  @ApiResponse({ status: 404, description: 'No such note, deleted, or not yours' })
  @ApiResponse({ status: 409, description: '`graph_disabled`, `ai_not_configured` or `model_lacks_capability`' })
  async estimate(
    @Query(new ZodValidationPipe(extractionEstimateQuerySchema)) query: ExtractionEstimateQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<ExtractionEstimate> {
    return this.extraction.estimate(user, query.noteId, query.model);
  }
}
