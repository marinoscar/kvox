import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags, getSchemaPath, ApiExtraModels } from '@nestjs/swagger';
import { ZodValidationPipe, createZodDto } from 'nestjs-zod';
import {
  deleteAllVoiceprintsResponseSchema,
  personVoiceprintSchema,
  speakerSuggestionDecisionSchema,
  speakerSuggestionSchema,
  speakerSuggestionsQuerySchema,
  voiceprintsSummarySchema,
  type DeleteAllVoiceprintsResponse,
  type PersonVoiceprint,
  type SpeakerSuggestion,
  type SpeakerSuggestionDecision,
  type SpeakerSuggestionsQuery,
  type VoiceprintsSummary,
} from '@marinoscar/kvox-contract/graph';

import { KvoxAuth } from '../../core/index.js';
import { TRANSCRIPTS_WRITE_PERMISSION } from '../../transcripts/index.js';
import { ApiDataResponse } from '../api-data-response.js';
import { CurrentGraphActor } from '../graph-actor.js';
import type { GraphActor } from '../graph-actor.js';
import { GRAPH_READ_PERMISSION, GRAPH_WRITE_PERMISSION } from '../graph.permissions.js';
import { VoiceprintsService } from './voiceprints.service.js';

export class SpeakerSuggestionDto extends createZodDto(speakerSuggestionSchema) {}
export class SpeakerSuggestionDecisionDto extends createZodDto(speakerSuggestionDecisionSchema) {}
export class PersonVoiceprintDto extends createZodDto(personVoiceprintSchema) {}
export class DeleteAllVoiceprintsResponseDto extends createZodDto(deleteAllVoiceprintsResponseSchema) {}
export class VoiceprintsSummaryDto extends createZodDto(voiceprintsSummarySchema) {}

// =============================================================================
// VoiceprintsController (#826, epic #820)
// =============================================================================
//
// Speaker-name suggestions (from `kg.voice_match`) and the controls over stored voiceprints.
// PER-ROUTE `@KvoxAuth`; no access is a 404, never a 403. BIOMETRIC: no response carries a
// vector or audio. Turning the feature on is the `graph.voiceprints.enabled` user setting;
// these routes only read and delete what it produced.
// =============================================================================

@ApiTags('Graph')
@Controller('graph')
@ApiExtraModels(SpeakerSuggestionDto)
export class VoiceprintsController {
  constructor(private readonly voiceprints: VoiceprintsService) {}

  @Get('speaker-suggestions')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'List voice-based name suggestions for a transcript',
    description:
      'Pending suggestions that a still-unnamed speaker of the transcript is a Person in your graph, ' +
      'from the voice-matching job. Only speakers that are still placeholders and Persons that are ' +
      'still live are listed. Never carries a voiceprint.\n\n' +
      'Requires `graph:read` and read access to the transcript (**404** otherwise).',
  })
  @ApiQuery({ name: 'transcriptId', type: String, format: 'uuid', required: true })
  @ApiResponse({
    status: 200,
    description: 'The pending suggestions, best first',
    schema: {
      type: 'object',
      properties: { data: { type: 'array', items: { $ref: getSchemaPath(SpeakerSuggestionDto) } } },
    },
  })
  async list(
    @Query(new ZodValidationPipe(speakerSuggestionsQuerySchema)) query: SpeakerSuggestionsQuery,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<SpeakerSuggestion[]> {
    return this.voiceprints.listForTranscript(query.transcriptId, user);
  }

  @Post('speaker-suggestions/:id/accept')
  @KvoxAuth(GRAPH_WRITE_PERMISSION, TRANSCRIPTS_WRITE_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a name suggestion',
    description:
      "Names the speaker with the Person's canonical name, the same way renaming it in the transcript does " +
      '(so the graph link follows), and marks the suggestion accepted. Accepting an accepted suggestion ' +
      'is a no-op.\n\n' +
      'Requires `graph:write`, `transcripts:write` and edit access to the transcript. **404**: no such ' +
      'pending suggestion of yours. **409** (`details.reason: SPEAKER_ALREADY_NAMED`): the speaker has been named since.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(SpeakerSuggestionDecisionDto, { description: 'The decided suggestion' })
  @ApiResponse({ status: 404, description: 'No such pending suggestion, or no access to the transcript' })
  @ApiResponse({ status: 409, description: 'The speaker is no longer a placeholder' })
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<SpeakerSuggestionDecision> {
    return this.voiceprints.accept(id, user);
  }

  @Post('speaker-suggestions/:id/dismiss')
  @KvoxAuth(GRAPH_WRITE_PERMISSION, TRANSCRIPTS_WRITE_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss a name suggestion',
    description:
      'Marks the suggestion dismissed; the same pair is never suggested again.\n\n' +
      'Requires `graph:write`, `transcripts:write` and edit access to the transcript. **404**: no such ' +
      'pending suggestion of yours.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(SpeakerSuggestionDecisionDto, { description: 'The decided suggestion' })
  @ApiResponse({ status: 404, description: 'No such pending suggestion, or no access to the transcript' })
  async dismiss(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<SpeakerSuggestionDecision> {
    return this.voiceprints.dismiss(id, user);
  }

  @Get('voiceprints/summary')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Voiceprint settings summary',
    description:
      'Whether voiceprints are on (`graph.voiceprints.enabled`), when you agreed, and how many people and ' +
      'samples are stored. Requires `graph:read`.',
  })
  @ApiDataResponse(VoiceprintsSummaryDto, { description: 'The summary' })
  async summary(@CurrentGraphActor() user: GraphActor): Promise<VoiceprintsSummary> {
    return this.voiceprints.summary(user);
  }

  @Delete('voiceprints')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete all voiceprints',
    description:
      'Deletes every voiceprint sample and pending name suggestion of yours. Turning the setting off does ' +
      'not do this. Requires `graph:write`.',
  })
  @ApiDataResponse(DeleteAllVoiceprintsResponseDto, { description: 'What was deleted' })
  async deleteAll(@CurrentGraphActor() user: GraphActor): Promise<DeleteAllVoiceprintsResponse> {
    return this.voiceprints.deleteAll(user);
  }

  @Get('entities/:id/voiceprint')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: "What is stored about a person's voice",
    description:
      'Sample count, total speech, last update and model of the Person\'s voiceprint. Never the voiceprint ' +
      'itself. Requires `graph:read`. **404**: no such entity, not yours, merged, or not a Person.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(PersonVoiceprintDto, { description: 'The voiceprint summary' })
  @ApiResponse({ status: 404, description: 'No such Person' })
  async person(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<PersonVoiceprint> {
    return this.voiceprints.personVoiceprint(id, user);
  }

  @Delete('entities/:id/voiceprint')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Forget a person's voice",
    description:
      "Deletes your voiceprint samples of this Person and the pending suggestions that point at them. The Person " +
      'and your recordings are unchanged. Requires `graph:write`. **404**: no such Person.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'No such Person' })
  async forget(@Param('id', ParseUUIDPipe) id: string, @CurrentGraphActor() user: GraphActor): Promise<void> {
    await this.voiceprints.forgetPerson(id, user);
  }
}
