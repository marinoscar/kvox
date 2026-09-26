// =============================================================================
// AskMessageStreamController (issue #379, epic #348; docs/specs/ontology.md §21.4)
// =============================================================================
//
//   GET /api/ask/messages/:id/stream     graph:read + owner (via the conversation)
//
// A VIEW over one assistant `ask_messages` row, shaped like
// `notes/note-generation-stream.controller.ts` on purpose: same `@Sse`, same
// `Last-Event-ID`/`?lastEventId=` resume (`resolveStreamOffset`, shared), same
// fetch-based client constraint (the native `EventSource` cannot send the
// bearer header, and a `?token=` stays rejected — it would land in access logs).
//
// Access is decided BEFORE the stream opens, so a refusal is an ordinary JSON
// 404 and never a half-open event stream. A foreign id, a missing id and a
// `role: 'user'` message all answer the SAME byte-identical 404 — only
// assistant turns stream, and saying "that id exists but is a question" would
// confirm the id to a stranger as surely as a 403 would.
// =============================================================================

import { Controller, Headers, NotFoundException, Param, ParseUUIDPipe, Query, Sse } from '@nestjs/common';
import {
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { resolveStreamOffset } from '../../notes/generation/note-stream';
import { ASK_MESSAGE_NOT_FOUND, AskAccessService } from '../ask-access.service';
import { AskMessageStreamService } from './ask-message-stream.service';
import type { AskStreamMessage } from './ask-stream';

const DESCRIPTION =
  'Watch one assistant turn being written. A **view** over the durable answer ' +
  '`ask.respond` writes: the answer completes identically whether or not anybody ' +
  'connects, and closing the stream cancels nothing.\n\n' +
  'A message that is not in one of the caller’s own conversations, does not exist, or ' +
  'is a **user** message answers **404**, never 403, before any stream bytes.\n\n' +
  '**Frames.** `event: delta` `{ "delta": "…", "offset": n }` — answer text appended since ' +
  'the client’s position. `event: step` `{ "index": n, "name": "…", "summary": "…", ' +
  '"resultCount": n, "error": string | null, "offset": n }` — one recorded tool call; ' +
  'every recorded step is re-sent on every (re)connect before new text, so de-duplicate by ' +
  '`index`; a step’s `id:` is the current offset and never advances it. `event: done` ' +
  '`{ "status": "succeeded", "offset": n, "citations": AskCitation[], "finishReason": ' +
  '"stop" | "step_cap" | "token_cap" | "time_cap", "promptTokens": n | null, ' +
  '"completionTokens": n | null }`. `event: error` `{ "status": "failed", "offset": n, ' +
  '"errorClass": "auth" | "refusal" | "rate_limit" | "budget" | "timeout" | "other" | ' +
  '"gone", "reason": string | null }` — `gone` when the message was deleted mid-stream, ' +
  '`timeout` with `reason: "stream_duration_cap"` when this connection gave up (the turn ' +
  'may still finish; refetch the conversation). Plus `: heartbeat` comments about every ' +
  '25 seconds.\n\n' +
  '**Every text frame’s `id:` is the UTF-16 offset into the answer it ends at.** ' +
  'Reconnect with `Last-Event-ID` (or `?lastEventId=`) carrying the last id seen and the ' +
  'response resumes from exactly there — no repeated text, no lost text. A turn that has ' +
  'already settled replays what the offset was missing and ends at once.';

@ApiTags('Ask')
@Controller('ask')
export class AskMessageStreamController {
  constructor(
    private readonly access: AskAccessService,
    private readonly streams: AskMessageStreamService,
  ) {}

  @Sse('messages/:id/stream')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: 'Stream an assistant answer (SSE)', description: DESCRIPTION })
  @ApiParam({ name: 'id', description: 'Assistant message id', format: 'uuid' })
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description: 'The last frame id seen. Resumes from exactly that answer offset.',
  })
  @ApiQuery({
    name: 'lastEventId',
    required: false,
    type: Number,
    description:
      'The same value as the `Last-Event-ID` header, for a client that could not set one. ' +
      'The header wins when both are present and it is greater than 0.',
  })
  @ApiOkResponse({
    description: 'An open event stream. Ends on a settled turn, disconnect, or the cap.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            ': connected\n\n' +
            'event: step\nid: 0\ndata: {"index":0,"name":"search","summary":"Searched for Acme",' +
            '"resultCount":3,"error":null,"offset":0}\n\n' +
            'event: delta\nid: 24\ndata: {"delta":"Acme renewed in March.","offset":24}\n\n' +
            'event: done\nid: 24\ndata: {"status":"succeeded","offset":24,"citations":[],' +
            '"finishReason":"stop","promptTokens":812,"completionTokens":40}\n\n',
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Not one of your assistant messages.' })
  async stream(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) messageId: string,
    @Headers('last-event-id') header: string | undefined,
    @Query('lastEventId') query: string | undefined,
  ): Promise<Observable<AskStreamMessage>> {
    const message = await this.access.requireMessage(userId, messageId);

    if (message.role !== 'assistant') throw new NotFoundException(ASK_MESSAGE_NOT_FOUND);

    return this.streams.stream(message.id, resolveStreamOffset(header, query));
  }
}
