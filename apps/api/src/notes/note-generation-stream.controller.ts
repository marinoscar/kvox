// =============================================================================
// NoteGenerationStreamController (issue #52, epic #45, docs/specs/notes.md §5)
// =============================================================================
//
// TWO ROUTES, ONE STREAM:
//
//   GET /api/notes/:id/stream             notes:read + owner
//   GET /api/note-generations/:id/stream  notes:read + owner
//
// Both resolve to a single `note_generations` row and hand it to the same
// reader. The split exists because a TEMPLATE PREVIEW has no note to be
// addressed through (spec §4.4), not because the two behave differently — a
// client that has a note id uses the first, a client that has a generation id
// uses the second, and the bytes they receive are identical.
//
// -----------------------------------------------------------------------------
// WHY `notes:read` AND NOT A PAIR OF ITS OWN
// -----------------------------------------------------------------------------
//
// Watching a note being written is reading it. `notes:read` is seeded to all
// three roles (spec §6.3) precisely because generating a note is the core
// product action in this epic, and a permission that gated the LIVE view
// separately from the finished one would let a deployment grant a user notes
// they may only ever see after the fact.
//
// -----------------------------------------------------------------------------
// WHY THE STREAM CANNOT BE LOAD-BEARING
// -----------------------------------------------------------------------------
//
// Nothing on this controller writes anything. `note.generate` completes the
// note — body, version, status, notification — with no knowledge of whether a
// connection exists, stays open, or is ever read. These two routes are a VIEW
// over `note_generations.content`; deleting this whole file would cost a user
// the live view and not one character of a note.
//
// -----------------------------------------------------------------------------
// THE CLIENT CANNOT USE THE NATIVE `EventSource`
// -----------------------------------------------------------------------------
//
// Same constraint as `GET /api/notifications/stream`, same reason, same answer:
// these routes take the ordinary `Authorization: Bearer …`, the native
// `EventSource` constructor accepts no headers, and a `?token=` query parameter
// stays REJECTED — a URL is written verbatim into the nginx access log, kept in
// browser history and forwarded in `Referer`, which turns a live bearer
// credential into something replayable out of a log file. `apps/web/src/
// services/sse.ts` is the fetch-based client that already exists for this.
// =============================================================================

import { Controller, Headers, Param, ParseUUIDPipe, Query, Sse } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { NoteGenerationAccessService } from './access/note-generation-access.service';
import { NoteGenerationStreamService } from './generation/note-generation-stream.service';
import { parseLastEventId, type NoteStreamMessage } from './generation/note-stream';

/** The prose both operations share, so the two descriptions cannot drift. */
const FRAME_DOCS =
  '**Frames.** `event: delta` with `{ "delta": "…", "offset": n }` for text appended since ' +
  'the client’s position; `event: done` with `{ "status": "succeeded", "offset": n, ' +
  '"currentVersion": n | null }` when the generation commits; `event: error` with ' +
  '`{ "status": "failed", "offset": n, "errorClass": "auth" | "refusal" | "rate_limit" | ' +
  '"other" | "timeout" | "gone", "reason": string | null }` when it does not. Plus `: heartbeat` ' +
  'comment lines roughly every 25 seconds, so a proxy does not reap the connection during a ' +
  'long wait for the first token.\n\n' +
  '**Every frame’s `id:` is the buffer offset it ends at.** Reconnect with `Last-Event-ID` ' +
  '(or `?lastEventId=`) carrying the last id seen, and the response resumes from exactly ' +
  'there — no repeated text, no lost text.\n\n' +
  '**A generation that has already finished is not a special case.** The endpoint replays ' +
  'whatever the caller’s offset was missing and then immediately emits `done`, so a client ' +
  'runs one code path for every entry into the view and never has to ask “is this still ' +
  'running?” first.\n\n' +
  '**Termination.** Terminal status; the client disconnecting; or a hard duration cap derived ' +
  'from the generation job’s own timeout, which answers `error` with `errorClass: "timeout"` ' +
  'so a wedged job can never pin a connection open.\n\n' +
  '**The stream is additive.** The note completes identically whether or not anyone ever ' +
  'connects — closing the tab loses nothing.';

@ApiTags('Notes')
@Controller()
export class NoteGenerationStreamController {
  constructor(
    private readonly access: NoteGenerationAccessService,
    private readonly streams: NoteGenerationStreamService,
  ) {}

  @Sse('notes/:id/stream')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Stream the note’s current generation (SSE)',
    description:
      'Attaches to the generation named by the note’s `currentGenerationId` — the one being ' +
      'written now, or the one that produced the note’s current content.\n\n' +
      'A note that is not the caller’s, has been deleted, or has never generated anything ' +
      'answers **404**, never 403: confirming that a specific note id exists is itself ' +
      'something a stranger has no business learning.\n\n' +
      FRAME_DOCS,
  })
  @ApiParam({ name: 'id', description: 'Note id', format: 'uuid' })
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description: 'The last frame id seen. Resumes from exactly that buffer offset.',
  })
  @ApiQuery({
    name: 'lastEventId',
    required: false,
    type: Number,
    description:
      'The same value as the `Last-Event-ID` header, for a client that could not set one. ' +
      'The header wins when both are present.',
  })
  @ApiOkResponse({
    description: 'An open event stream. Ends on terminal status, disconnect, or the cap.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            ': connected\n\nevent: delta\nid: 27\ndata: {"delta":"# Weekly sync\\n","offset":27}' +
            '\n\nevent: done\nid: 812\ndata: {"status":"succeeded","offset":812,"currentVersion":1}\n\n',
        },
      },
    },
  })
  async streamForNote(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) noteId: string,
    @Headers('last-event-id') header: string | undefined,
    @Query('lastEventId') query: string | undefined,
  ): Promise<Observable<NoteStreamMessage>> {
    const target = await this.access.requireForNote(userId, noteId);

    return this.streams.stream(target.generationId, resolveOffset(header, query));
  }

  @Sse('note-generations/:id/stream')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Stream one generation (SSE)',
    description:
      'Attaches to a generation by its own id — the only reachable form for a **template ' +
      'preview**, which has no note to be addressed through.\n\n' +
      'A generation belonging to anybody else answers **404**, never 403. A preview’s ' +
      'requester is read from the generating job’s payload, and a preview whose requester ' +
      'can no longer be established answers 404 as well: this endpoint fails closed.\n\n' +
      FRAME_DOCS,
  })
  @ApiParam({ name: 'id', description: 'Generation id', format: 'uuid' })
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description: 'The last frame id seen. Resumes from exactly that buffer offset.',
  })
  @ApiQuery({
    name: 'lastEventId',
    required: false,
    type: Number,
    description:
      'The same value as the `Last-Event-ID` header, for a client that could not set one. ' +
      'The header wins when both are present.',
  })
  @ApiOkResponse({
    description: 'An open event stream. Ends on terminal status, disconnect, or the cap.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            ': connected\n\nevent: delta\nid: 27\ndata: {"delta":"# Weekly sync\\n","offset":27}' +
            '\n\nevent: done\nid: 812\ndata: {"status":"succeeded","offset":812,"currentVersion":null}\n\n',
        },
      },
    },
  })
  async streamGeneration(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) generationId: string,
    @Headers('last-event-id') header: string | undefined,
    @Query('lastEventId') query: string | undefined,
  ): Promise<Observable<NoteStreamMessage>> {
    const target = await this.access.require(userId, generationId);

    return this.streams.stream(target.generationId, resolveOffset(header, query));
  }
}

/**
 * Where to resume from: the header if it is usable, otherwise the query.
 *
 * ⚠ BOTH CARRY A FRAME ID — WHICH, PER ISSUE #52, IS A BUFFER OFFSET. Not
 * `note_generations.last_event_id`, whose value is a flush counter and would
 * resume a client near the START of the buffer if passed here. Nothing is lost
 * if one is (the replay is simply longer than it needed to be), but the two
 * numbers must not be confused: `note-stream.ts`'s header records why the offset
 * is what travels.
 *
 * The HEADER WINS because a reconnecting client's header is set by the transport
 * and reflects what actually arrived, while a query parameter is whatever the
 * page had in hand when it opened the connection — and is therefore the older of
 * the two whenever both exist. `parseLastEventId` is total, so an unusable
 * header is `0`, which falls through to the query rather than silently
 * restarting a resumable client from the beginning.
 */
function resolveOffset(
  header: string | undefined,
  query: string | undefined,
): number {
  const fromHeader = parseLastEventId(header);

  return fromHeader > 0 ? fromHeader : parseLastEventId(query);
}
