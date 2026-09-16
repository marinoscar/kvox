import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import {
  SEARCH_INDEX_REQUEST_CAP,
  SearchIndexRequestResultDto,
  SearchIndexStatusDto,
} from './dto/search-index-status.dto';
import { SearchIndexStatusService } from './search-index-status.service';

// =============================================================================
// SearchIndexController (issue #191, epic #165) — the last issue in the epic
// =============================================================================
//
// Two routes, and they exist because of a decision made three issues earlier:
//
//   GET  /api/search/index-status   authenticated
//   POST /api/search/index          authenticated
//
// Indexing spends the DOCUMENT OWNER'S OWN vendor account, so this epic has no
// silent backfill and no cron (`job-types.ts`'s header is that argument in
// full). An explicit action needs somewhere to be taken, and a degradation
// nobody can see is indistinguishable from a broken feature: without these two
// routes `semantic: false` is invisible, and the whole epic reads as not
// working.
//
// -----------------------------------------------------------------------------
// A SEPARATE CONTROLLER FROM `search.controller.ts`, ON THE SAME PREFIX
// -----------------------------------------------------------------------------
//
// `GET /api/search` is a QUERY endpoint: it reads two modules' tables through
// raw ranked SQL and lives in `SearchModule`, which deliberately imports
// nothing but `PrismaModule`. These two are an INDEXING surface: they read the
// AI policy, the caller's credential and the job queue, and they belong in
// `SearchIndexingModule` beside the service and handler they drive. Bolting
// them onto the query controller would drag the AI provider registry, the
// credential store and `JobsModule` into the graph of a read-only search
// endpoint — precisely what `search.module.ts`'s own header refuses to do.
//
// Nest is perfectly happy with two controllers sharing a path prefix; the
// routes are distinct, and `/search/index-status` reads to a client as what it
// is: a fact about the search feature.
//
// -----------------------------------------------------------------------------
// WHY NEITHER ROUTE NAMES A PERMISSION
// -----------------------------------------------------------------------------
//
// The same answer `user-data.controller.ts` and `ai-credentials.controller.ts`
// give, and it is worth restating because the plausible alternatives all fail
// somebody.
//
// Almost every route in this application names a real permission, including
// ones that could have been left merely authenticated — `GET
// /api/transcription/config` names `transcripts:read`, `GET /api/ai/config`
// names `notes:read` — because a permission seeded to all three roles says
// something TRUE about what the route belongs to.
//
// This is the case where that argument does not apply. THE RESOURCE IS THE
// CALLER'S OWN CONTENT AND THE CALLER'S OWN VENDOR ACCOUNT, scoped by `ownerId`
// in the query itself. `@CurrentUser('id')` comes from the verified JWT and is
// the only user id either route ever sees: there is no path parameter naming a
// user, and neither route takes a body at all, so "index somebody else's
// library" is not a request these routes refuse — it is a request they cannot
// express.
//
// ⚠ REJECTED: gating on `transcripts:read` + `notes:read`. `PermissionsGuard`
// requires ALL declared permissions (`every`, not `some`), so a deployment that
// had narrowed a user to one document type would 403 them out of seeing the
// state of the other — and the pair is the wrong question anyway: this endpoint
// does not read document CONTENT, it reports counts about documents the caller
// already owns and queues work billed to their own account.
//
// ⚠ REJECTED: an admin surface, at `/admin/settings/...`, that indexes on a
// user's behalf. THE KEY IS THE USER'S, THE CONTENT IS THE USER'S, AND THE BILL
// IS THE USER'S. An administrator pressing this button would be spending
// somebody else's money on somebody else's private recordings; there is no
// deployment key to fall back on (epic #45 is strict bring-your-own-key), so
// such a button could not even work. This is also why there is no
// `search_index:read_any` — the same posture `transcripts:read_any` and
// `notes:read_any` were deliberately never created with.
// =============================================================================

@ApiTags('Search')
@Controller('search')
export class SearchIndexController {
  constructor(private readonly status: SearchIndexStatusService) {}

  @Get('index-status')
  @Auth()
  @ApiOperation({
    summary: 'What of your library is semantically searchable',
    description:
      'Per-document-type counts of what has been indexed for **semantic** search, plus whether ' +
      'indexing can run at all and why not when it cannot.\n\n' +
      '**Everything here is scoped to documents you own** — not the transcripts somebody ' +
      'shared with you. A share lets you read another person\'s recording; it does not make ' +
      'their indexing bill yours. Indexing authenticates as the **document owner**, so their ' +
      'own copy of this page is where those documents are indexed from.\n\n' +
      '**`unindexed` is the number that matters, and it is not one of the database states.** ' +
      'Every other count requires an indexing record to exist. A document that predates ' +
      'semantic search, or whose owner had no API key when it arrived, has no record at all — ' +
      'so a library reporting `0 indexed, 0 pending, 0 failed` may be entirely unsearchable ' +
      'rather than entirely fine. `unindexed` is what `POST /api/search/index` acts on.\n\n' +
      '**`available` and `hasKey` are independent, deliberately.** `available: false` means ' +
      'your administrator has not configured an AI provider that does embeddings; ' +
      '`hasKey: false` means you have not saved a key. They have different fixes and different ' +
      'people to talk to, and `reason` names whichever applies.\n\n' +
      '**Never errors for an unconfigured deployment.** "Nothing is set up yet" is an ordinary ' +
      'state and is reported, not thrown.',
  })
  @ApiDataResponse(SearchIndexStatusDto, {
    description: 'The caller\'s own indexing state',
  })
  async indexStatus(@CurrentUser('id') userId: string) {
    return this.status.status(userId);
  }

  @Post('index')
  @Auth()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Index your library for semantic search',
    description:
      'Queues background indexing for the documents **you own** that have never been indexed, ' +
      'or whose content has changed since they were. Returns **202** as soon as the jobs ' +
      'exist; nothing is indexed synchronously, and the work continues whether or not you stay ' +
      'on the page.\n\n' +
      '⚠ **This spends your own AI provider account.** This deployment holds no API key of its ' +
      'own — every key belongs to an individual user — so indexing authenticates as you and ' +
      'the embedding usage is billed to you. That is also why there is no automatic backfill: ' +
      'nothing in this application ever starts this work on your behalf.\n\n' +
      `**Bounded at ${SEARCH_INDEX_REQUEST_CAP} documents per call.** \`remaining\` reports ` +
      'what is left over and `cap` reports the ceiling, so a client can say "200 of 900 ' +
      'queued" and offer the button again. The bound is on what **one press** can commit you ' +
      'to, not on how much you may index.\n\n' +
      '**Pressing twice is harmless.** A document already queued or being indexed is skipped ' +
      'here, and the queue deduplicates anything that slips past — a second press while the ' +
      'first batch drains creates no second run.\n\n' +
      '**409 `details.reason`** — `ai_not_configured` or `embedding_unsupported` when this ' +
      'deployment cannot embed at all, `ai_key_missing` when you have saved no key. Refused ' +
      'rather than queued, because those jobs would each write "skipped" and index nothing.',
  })
  @ApiDataResponse(SearchIndexRequestResultDto, {
    status: 202,
    description: 'Indexing has been queued',
  })
  @ApiResponse({
    status: 409,
    description:
      'This deployment has no embedding provider, or you have saved no API key — ' +
      '`details.reason` says which',
  })
  async requestIndex(@CurrentUser('id') userId: string) {
    return this.status.requestIndex(userId);
  }
}
