import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { AskConversationsService } from './ask-conversations.service';
import {
  ASK_DETAIL_MESSAGE_LIMIT,
  ASK_TITLE_MAX_CHARS,
  AskConversationDetailDto,
  AskConversationSummaryDto,
  CreateAskConversationDto,
  ListAskConversationsResponseDto,
  RenameAskConversationDto,
  createAskConversationSchema,
  getAskConversationQuerySchema,
  listAskConversationsQuerySchema,
  renameAskConversationSchema,
  type AskConversationDetail,
  type AskConversationSummary,
  type CreateAskConversation,
  type GetAskConversationQuery,
  type ListAskConversationsQuery,
  type ListAskConversationsResponse,
  type RenameAskConversation,
} from './dto/ask.dto';

// =============================================================================
// AskConversationsController (issue #376, epic #348; docs/specs/ontology.md §21)
// =============================================================================
//
// Saved conversations with the read-only graph agent. Every route is
// `graph:read` — asking is a read of one's own graph, so there is deliberately
// no `ask:*` permission pair — and owner-only: a missing and a foreign id are
// the same 404, never a 403, and there is no admin read path.
// =============================================================================

const NOT_FOUND = 'No such conversation, or it is not yours';

@ApiTags('Ask')
@Controller('ask')
export class AskConversationsController {
  constructor(private readonly conversations: AskConversationsService) {}

  @Get('conversations')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'List your Ask conversations',
    description:
      'Your saved conversations, most recently updated first (`updatedAt` desc, then `id` desc), ' +
      'keyset-paginated by `nextCursor`. Each row carries a one-line `lastMessagePreview` ' +
      '(citation markers stripped) and whether a turn is `running`.\n\n' +
      '`scopeEntityId` keeps only the conversations scoped to that entity. A cursor from another ' +
      'caller or another filter is a **400**.',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1-50 (default 20)' })
  @ApiQuery({ name: 'scopeEntityId', required: false, type: String, format: 'uuid' })
  @ApiDataResponse(ListAskConversationsResponseDto, { description: 'A page of conversations' })
  @ApiResponse({ status: 400, description: 'Invalid parameter, or a cursor from another list' })
  async list(
    @Query(new ZodValidationPipe(listAskConversationsQuerySchema)) query: ListAskConversationsQuery,
    @CurrentUser('id') userId: string,
  ): Promise<ListAskConversationsResponse> {
    return this.conversations.list(userId, query);
  }

  @Get('conversations/:id')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'Get an Ask conversation',
    description:
      `The conversation and its newest ${ASK_DETAIL_MESSAGE_LIMIT} messages, oldest first. ` +
      '`hasEarlier` says older messages exist; fetch them with `?before=<messages[0].id>`. An ' +
      'assistant message that is `pending`/`streaming` is still being written — its `content` ' +
      'is the durable buffer the stream reads.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'before', required: false, type: String, format: 'uuid' })
  @ApiDataResponse(AskConversationDetailDto, { description: 'The conversation' })
  @ApiResponse({ status: 400, description: '`before` does not name a message in this conversation' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(getAskConversationQuerySchema)) query: GetAskConversationQuery,
    @CurrentUser('id') userId: string,
  ): Promise<AskConversationDetail> {
    return this.conversations.get(userId, id, query);
  }

  @Post('conversations')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'Start an Ask conversation',
    description:
      'Creates an empty conversation, optionally scoped to one of your entities (the "Ask about ' +
      'this person" panel) and optionally titled. Without a title it is named after its first ' +
      'question.\n\n' +
      '**404** when `scopeEntityId` is not one of your readable entities (missing, not yours, ' +
      'not reviewed, or merged).',
  })
  @ApiBody({ type: CreateAskConversationDto })
  @ApiDataResponse(AskConversationSummaryDto, { status: 201, description: 'The new conversation' })
  @ApiResponse({ status: 400, description: `Invalid body (a title is 1-${ASK_TITLE_MAX_CHARS} characters)` })
  @ApiResponse({ status: 404, description: 'No such entity, or it is not one of your readable entities' })
  async create(
    @Body(new ZodValidationPipe(createAskConversationSchema)) dto: CreateAskConversation,
    @CurrentUser('id') userId: string,
  ): Promise<AskConversationSummary> {
    return this.conversations.create(userId, dto);
  }

  @Patch('conversations/:id')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({ summary: 'Rename an Ask conversation' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: RenameAskConversationDto })
  @ApiDataResponse(AskConversationSummaryDto, { description: 'The renamed conversation' })
  @ApiResponse({ status: 400, description: `Invalid body (a title is 1-${ASK_TITLE_MAX_CHARS} characters)` })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  async rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(renameAskConversationSchema)) dto: RenameAskConversation,
    @CurrentUser('id') userId: string,
  ): Promise<AskConversationSummary> {
    return this.conversations.rename(userId, id, dto);
  }

  @Delete('conversations/:id')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an Ask conversation',
    description:
      'Deletes the conversation and every message in it. Allowed while a turn is running: the ' +
      'turn stops writing and its stream ends. Audited as `ask.conversation_deleted` (counts ' +
      'and ids only, never content). **There is no path back.**',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string): Promise<void> {
    await this.conversations.remove(userId, id);
  }
}
