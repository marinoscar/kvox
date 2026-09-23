// =============================================================================
// TranscriptNameChecksController (issues #328 and #330, epic #326)
// =============================================================================
//
// Five routes under `/api/transcripts/:id/name-checks`: start a check,
// estimate one, read the latest run and its pending suggestions, and accept or
// reject suggestions. A controller of its own rather than five more methods on
// `TranscriptsController` (already twenty-two routes), sharing its prefix,
// its permission pair and its access service — so the posture is identical:
// `transcripts:read` + view for reads, `transcripts:write` + edit for writes,
// and no access is a 404, never a 403.
// =============================================================================

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { OperationsConflictDto } from './dto/transcript-editing.dto';
import {
  ApplyNameSuggestionsResultDto,
  CreateNameCheckBodyDto,
  CreateNameCheckResponseDto,
  LatestNameCheckDto,
  NameCheckDecisionBodyDto,
  NameCheckEstimateDto,
  RejectNameSuggestionsResultDto,
  createNameCheckSchema,
  nameCheckDecisionSchema,
  nameCheckEstimateQuerySchema,
  type CreateNameCheckDto,
  type NameCheckDecisionDto,
  type NameCheckEstimateQueryDto,
} from './dto/transcript-name-check.dto';
import { TranscriptNameCheckService } from './transcript-name-check.service';

@ApiTags('Transcripts')
@Controller('transcripts')
export class TranscriptNameChecksController {
  constructor(private readonly nameChecks: TranscriptNameCheckService) {}

  @Post(':id/name-checks')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Check a transcript for mis-transcribed names',
    description:
      'Queues a `transcript.name_check` job that looks for places where speech recognition ' +
      'mis-heard a name — "Skar" or "Oh scar" for "Oscar" — and proposes corrections. Nothing ' +
      'in the transcript changes until suggestions are accepted through ' +
      '`POST /api/transcripts/{id}/name-checks/{checkId}/apply`.\n\n' +
      'The names checked for are the display names of the selected speakers (`speakerIds`, ' +
      'default all; generic labels like "Speaker A" are skipped), plus `terms`, plus the ' +
      'keyterms given at upload. **400** when that leaves nothing to check.\n\n' +
      '`standard` verifies phonetic candidates with the AI model. `thorough` also has the ' +
      'model read the whole transcript for mis-hearings a phonetic match misses — several ' +
      'times the tokens. `estimate` says what the run will cost before output tokens (a lower ' +
      'bound for `thorough`, whose own findings are verified too).\n\n' +
      '**409** with `details.reason`: `ai_not_configured` (the deployment), `ai_key_missing` ' +
      '(the caller — the check runs on **your** provider account), `name_check_running` (one ' +
      'is already pending or running for this transcript), or `transcript_not_ready`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: CreateNameCheckBodyDto })
  @ApiDataResponse(CreateNameCheckResponseDto, {
    status: 202,
    description: 'The queued run and its estimated cost',
  })
  @ApiResponse({ status: 400, description: 'No names to check, or an unknown speaker id' })
  @ApiResponse({ status: 403, description: 'The caller lacks `transcripts:write`' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no edit access to it' })
  @ApiResponse({ status: 409, description: 'AI not configured, no key, a check already running, or not ready' })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createNameCheckSchema)) dto: CreateNameCheckDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.nameChecks.create(id, dto, user);
  }

  // ⚠ DECLARED BEFORE `:checkId` ROUTES — literal segments first.
  @Get(':id/name-checks/estimate')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Estimate a name check',
    description:
      'What `POST /api/transcripts/{id}/name-checks` would cost, without creating anything: ' +
      'input tokens (counted by the active provider\'s tokenizer), provider requests and ' +
      'phonetic candidates, for every speaker\'s name plus upload keyterms. Needs no API key ' +
      '— counting is free — but **409** `ai_not_configured` when the deployment has no AI.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'mode', required: false, enum: ['standard', 'thorough'] })
  @ApiDataResponse(NameCheckEstimateDto, { description: 'The estimate' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no access to it' })
  @ApiResponse({ status: 409, description: 'AI not configured, or the transcript is not ready' })
  async estimate(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(nameCheckEstimateQuerySchema)) query: NameCheckEstimateQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.nameChecks.estimate(id, query, user);
  }

  @Get(':id/name-checks/latest')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'The latest name check and its pending suggestions',
    description:
      'The most recent run (or `run: null`), its **pending** suggestions in reading order, and ' +
      'counts by status. Poll this while `run.status` is `pending` or `running`.\n\n' +
      'Each suggestion\'s `start`/`end` and `preview` are computed against the segment\'s ' +
      '**current** text: when the line was edited since the check ran, the span is relocated ' +
      'if `original` still occurs exactly once as a whole word. `stale: true` means it could ' +
      'not be — applying it will skip it.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(LatestNameCheckDto, { description: 'The latest run and its pending suggestions' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no access to it' })
  async latest(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.nameChecks.latest(id, user);
  }

  @Post(':id/name-checks/:checkId/apply')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept name suggestions',
    description:
      'Writes the named pending suggestions into the transcript as ordinary corrections: one ' +
      '`segment.update_text` per affected line, applied through the same path as ' +
      '`POST /api/transcripts/{id}/operations` and recorded as a new version ("Applied N AI ' +
      'name corrections"), in batches of up to 200 lines.\n\n' +
      'A suggestion whose text is no longer where it was, and cannot be uniquely relocated, ' +
      'is marked `stale` and skipped; so is one overlapping another in the same call. ' +
      'Suggestions that are not pending, or belong to another check, are ignored.\n\n' +
      'The response carries every segment and speaker so a client can adopt the new state. ' +
      'A **409** from a concurrent edit is passed through unchanged (see the operations ' +
      'endpoint); suggestions not yet applied stay pending.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'checkId', type: String, format: 'uuid' })
  @ApiBody({ type: NameCheckDecisionBodyDto })
  @ApiDataResponse(ApplyNameSuggestionsResultDto, { description: 'What was applied, and the new state' })
  @ApiResponse({ status: 404, description: 'No such transcript or check, or no edit access' })
  @ApiResponse({
    status: 409,
    description: 'A line changed concurrently — `details` names every conflicting entity',
    type: OperationsConflictDto,
  })
  async apply(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body(new ZodValidationPipe(nameCheckDecisionSchema)) dto: NameCheckDecisionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.nameChecks.apply(id, checkId, dto, user);
  }

  @Post(':id/name-checks/:checkId/reject')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject name suggestions',
    description:
      'Marks the named pending suggestions `rejected`. The transcript is not touched. ' +
      'Suggestions that are not pending, or belong to another check, are ignored.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'checkId', type: String, format: 'uuid' })
  @ApiBody({ type: NameCheckDecisionBodyDto })
  @ApiDataResponse(RejectNameSuggestionsResultDto, { description: 'How many were rejected' })
  @ApiResponse({ status: 404, description: 'No such transcript or check, or no edit access' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body(new ZodValidationPipe(nameCheckDecisionSchema)) dto: NameCheckDecisionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.nameChecks.reject(id, checkId, dto, user);
  }
}
