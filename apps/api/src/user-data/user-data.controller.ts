import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import {
  CreateUserDataDeletionBodyDto,
  UserDataDeletionDto,
  UserDataSummaryDto,
} from './dto/user-data.dto';
import { UserDataService } from './user-data.service';

// =============================================================================
// UserDataController (issue #80) — the Danger Zone
// =============================================================================
//
// Two routes, both `@Auth()` with NO permission string:
//
//   GET  /api/user-data/summary     authenticated
//   POST /api/user-data/deletions   authenticated
//
// -----------------------------------------------------------------------------
// WHY NO PERMISSION STRING GATES THESE TWO
// -----------------------------------------------------------------------------
//
// The same answer `ai-credentials.controller.ts` gives, and it is worth
// restating because the obvious alternative looks defensible right up until you
// name the user it fails.
//
// Almost every route in this application names a real permission, including the
// ones that could have been left merely authenticated — `GET
// /api/transcription/config` names `transcripts:read`, `GET /api/ai/config`
// names `notes:read` — because a permission seeded to all three roles says
// something TRUE about what the route belongs to, where "authenticated and
// nothing else" says nothing at all.
//
// This is the case where that argument does not apply. The resource is not a
// feature of this application; it is THE CALLER'S OWN DATA, scoped by `userId`
// in the query itself. An RBAC permission decides what a ROLE may do to the
// application's resources; nothing about a role should decide whether a person
// may ask for their own recordings to be forgotten. The nearest precedents in
// this repository are `/api/user-settings`, `/api/pat` and `/api/ai-credentials`,
// all ownership-scoped rather than permission-scoped.
//
// ⚠ REJECTED: gating on `transcripts:write` + `notes:write`. It reads as the
// careful choice and it strands the one user who needs this most. A deployment
// that has revoked a user's `transcripts:write` — offboarding, a downgraded
// role, a misconfigured seed — has revoked their ability to REMOVE the
// recordings it is still holding for them, while leaving the recordings there.
// That is the identical failure `ai-credentials.controller.ts` describes for a
// key the user can no longer erase, with a larger blast radius: a person's
// right to delete their own data cannot be contingent on a permission somebody
// else administers. The composite `everything` scope makes it worse still,
// since it would then require the union of four unrelated permissions.
//
// -----------------------------------------------------------------------------
// OWNERSHIP IS ENFORCED IN THE QUERY, NOT BY A GUARD
// -----------------------------------------------------------------------------
//
// `@CurrentUser('id')` comes from the verified JWT and is the only user id
// either route ever sees. There is no route parameter naming a user and no
// field in either body that could carry one, so "delete somebody else's
// transcripts" is not a request these routes refuse — it is a request they
// cannot express. The enqueued job's `subjectId` is that same id, so even the
// queue row cannot name a different account.
//
// ⚠ THE ADMIN SURFACE IS DELIBERATELY ABSENT. There is no route here, for any
// role, that summarises or deletes ANOTHER user's data. That is the same
// posture `transcripts:read_any` and `notes:read_any` were deliberately never
// created with (CLAUDE.md's RBAC table): a recording is somebody's private
// conversation, and an administrator holding a button that destroys one
// person's library is a capability this design does not want to exist.
// =============================================================================

@ApiTags('User Data')
@Controller('user-data')
export class UserDataController {
  constructor(private readonly userData: UserDataService) {}

  @Get('summary')
  @Auth()
  @ApiOperation({
    summary: "Summarise the data this deployment holds for you",
    description:
      'Per-category row counts and the storage bytes behind them, plus whatever deletion is ' +
      'already in flight for you. Everything is scoped to the authenticated caller — there ' +
      'is no parameter naming a user, so there is no way to ask about anybody else.\n\n' +
      '`bytes` is a **decimal string**, not a number: a large media library exceeds ' +
      "JavaScript's safe integer range and a JSON number would round the figure shown in a " +
      'confirmation dialog.\n\n' +
      'Counts exclude anything already deleted and awaiting purge, so the numbers shrink ' +
      'only when you act, never on their own.\n\n' +
      '`activeDeletion` is non-null while a deletion is `pending` or `running`. Use it to ' +
      'disable the buttons — but it is a courtesy, not the guard: ' +
      '`POST /api/user-data/deletions` answers **409** regardless.',
  })
  @ApiDataResponse(UserDataSummaryDto, { description: "The caller's own data inventory" })
  async summary(@CurrentUser('id') userId: string) {
    return this.userData.summary(userId);
  }

  @Post('deletions')
  @Auth()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Delete your own data in bulk',
    description:
      'Queues a background job that removes the data you own in the chosen `scope`. Returns ' +
      '**202** as soon as the job exists; nothing is deleted synchronously, because the work ' +
      'fans out across several tables and object storage and outlives this request.\n\n' +
      '⚠ **There is no path back.** Deleted transcripts, notes and files are not recoverable ' +
      'from this application.\n\n' +
      '**Scopes.** `transcripts` removes your transcripts. `notes` removes your notes **and ' +
      'your own custom note templates** — a template is the recipe a note was generated ' +
      'from, and it has no meaning once the notes are gone. `files` removes your plain ' +
      'uploads only: a transcript\'s audio and a note\'s export belong to those, not here. ' +
      '`content` is `transcripts` + `notes`. `everything` is `content` + `files` + your AI ' +
      'provider keys + your personal access tokens.\n\n' +
      '**Your account survives.** No scope deletes your user record, your settings, your ' +
      'roles or your session — you stay signed in. `everything` revokes your API tokens, so ' +
      'any CLI or script using one will need a new token.\n\n' +
      '**`confirmation` must be the scope, uppercased** — `TRANSCRIPTS`, `NOTES`, `FILES`, ' +
      '`CONTENT` or `EVERYTHING`, compared exactly with no trimming and no case folding. ' +
      'The token is scope-specific deliberately: a word typed for one scope can never ' +
      'authorise another.\n\n' +
      '**This scope ignores the per-item refusals.** Deleting one note at a time refuses ' +
      'while it is generating or while another note is derived from it, and deleting one ' +
      'transcript refuses while a note cites it. A bulk deletion honours neither — it clears ' +
      'those links first and deletes anyway. A surviving note that cited a deleted ' +
      'transcript keeps its own text and loses the provenance link.',
  })
  @ApiDataResponse(UserDataDeletionDto, {
    status: 202,
    description: 'The deletion has been queued',
  })
  @ApiResponse({
    status: 400,
    description: '`confirmation` did not exactly match the scope, uppercased',
  })
  @ApiResponse({
    status: 409,
    description: 'A deletion is already pending or running for this caller',
  })
  async requestDeletion(
    @Body() dto: CreateUserDataDeletionBodyDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.userData.requestDeletion(userId, {
      scope: dto.scope,
      confirmation: dto.confirmation,
    });
  }
}
