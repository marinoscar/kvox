import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ASK_MAX_TOOL_STEPS } from './ask-limits';
import { AskMessagesService } from './ask-messages.service';
import { ASK_CONTENT_MAX_CHARS } from './dto/ask.dto';
import {
  PostAskMessageDto,
  PostAskMessageResponseDto,
  postAskMessageSchema,
  type PostAskMessage,
  type PostAskMessageResponse,
} from './dto/ask-messages.dto';

// =============================================================================
// AskMessagesController (issue #378, epic #348; docs/specs/ontology.md §21.3)
// =============================================================================
//
// Posting a question. `graph:read`, like every Ask route — asking is a read of
// one's own graph — and owner-only through the conversation (404, never 403).
// =============================================================================

const CONFLICTS =
  '`details.reason`: `graph_disabled` (connected knowledge is switched off), `ai_not_configured`, ' +
  '`ai_key_missing` (you have not saved an AI key — Ask runs on your own), `model_lacks_capability` ' +
  '(the model cannot call tools), or `ask_turn_running` (this conversation is still answering).';

@ApiTags('Ask')
@Controller('ask')
export class AskMessagesController {
  constructor(private readonly messages: AskMessagesService) {}

  @Post('conversations/:id/messages')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ask a question in a conversation',
    description:
      'Saves your question and queues one `ask.respond` turn, which answers it on **your own** AI ' +
      'key with the `graph.agent` task model (or `model`, when this deployment permits it and it ' +
      'can call tools). The agent reads your graph and your transcripts and notes through ' +
      `read-only tools — at most ${ASK_MAX_TOOL_STEPS} tool steps — and cites what they returned.\n\n` +
      'Returns at once with your `complete` question and a `pending` assistant message. Its ' +
      '`content` is the durable answer buffer, written as the answer is generated and only ever ' +
      'appended to: stream it, or poll the conversation. It ends `complete` (with `citations`, ' +
      'token counts and a `finishReason` — anything but `stop` means it was stopped early by a ' +
      'cap and still carries its best answer) or `failed` with an `errorClass`.\n\n' +
      'The first question names an untitled conversation (its first 80 characters).\n\n' +
      `**400**: an empty question, one over ${ASK_CONTENT_MAX_CHARS} characters, or a model this ` +
      'deployment does not permit. **404**: no such conversation, or it is not yours. **409** ' +
      CONFLICTS,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: PostAskMessageDto })
  @ApiDataResponse(PostAskMessageResponseDto, { status: 202, description: 'Your question and the queued answer' })
  @ApiResponse({ status: 400, description: 'Invalid question, or a model this deployment does not permit' })
  @ApiResponse({ status: 403, description: 'Missing `graph:read`' })
  @ApiResponse({ status: 404, description: 'No such conversation, or it is not yours' })
  @ApiResponse({ status: 409, description: CONFLICTS })
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(postAskMessageSchema)) dto: PostAskMessage,
    @CurrentUser('id') userId: string,
  ): Promise<PostAskMessageResponse> {
    return this.messages.post(userId, id, dto);
  }
}
