// =============================================================================
// NotesController (issue #53, epic #45)
// =============================================================================
//
// Ten routes: create, list, summary, detail, edit, regenerate, browse history,
// read one version, restore one, delete.
//
// PER-ROUTE `@Auth`, NO CLASS-LEVEL GUARD, matching `TranscriptsController` and
// `NoteTemplatesController`: the permission a route enforces is readable on the
// route, and adding a route cannot inherit an authority nobody wrote down for
// it.
//
// -----------------------------------------------------------------------------
// `notes:read` AND `notes:write`, BOTH SEEDED TO ALL THREE ROLES
// -----------------------------------------------------------------------------
//
// Viewer included (spec §6.3), mirroring `transcripts:read`/`write` exactly:
// producing a note is the core action this epic exists to enable, and a fresh
// account's default role is Viewer. A permission model that made a new signup
// unable to make their first note would contradict the product's own
// onboarding.
//
// There is deliberately **no `notes:read_any`**, for the identical reason there
// is no `transcripts:read_any`: a note is derived from somebody's private
// conversation, and no permission string for reading another user's note
// content exists anywhere in this design, for any role, ever.
//
// -----------------------------------------------------------------------------
// ⚠ 404 ON EVERY ROUTE, NEVER 403, FOR A NOTE THE CALLER CANNOT SEE
// -----------------------------------------------------------------------------
//
// Decided in exactly one place — `access/note-access.service.ts` — whose header
// carries the argument. Read, patch, version, restore and delete all answer
// identically, in the same words.
//
// -----------------------------------------------------------------------------
// THE WEAK ETag, AND WHY THE HELPER IS IMPORTED RATHER THAN RE-WRITTEN
// -----------------------------------------------------------------------------
//
// `versionETag` and `matchesETag` already exist, exported, in
// `transcripts.controller.ts`. They implement RFC 9110's rules for
// `If-None-Match` — weak comparison, a list of validators, `*` — and a second
// copy here would be a second chance to get "a proxy stripped the `W/` prefix"
// wrong. The header is `W/"v<currentVersion>"`: WEAK, because two responses at
// one version are semantically equivalent rather than byte-identical
// (`updatedAt` moves for reasons the version does not name).
// =============================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { matchesETag, versionETag } from '../transcripts/transcripts.controller';
import {
  CreateNoteBodyDto,
  CreateNoteResultDto,
  NoteConflictDto,
  NoteDto,
  NoteListDto,
  NoteSummaryDto,
  NoteVersionDetailDto,
  NoteVersionsDto,
  RegenerateNoteBodyDto,
  RegenerateNoteResultDto,
  RestoreNoteVersionBodyDto,
  UpdateNoteBodyDto,
  createNoteSchema,
  noteListQuerySchema,
  noteVersionsQuerySchema,
  regenerateNoteSchema,
  restoreNoteVersionSchema,
  updateNoteSchema,
  type CreateNoteDto,
  type NoteListQueryDto,
  type NoteVersionsQueryDto,
  type RegenerateNoteDto,
  type RestoreNoteVersionDto,
  type UpdateNoteDto,
} from './dto/note.dto';
import { NotesService } from './notes.service';

@ApiTags('Notes')
@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  // ===========================================================================
  // Create
  // ===========================================================================

  @Post()
  @Auth({ permissions: [PERMISSIONS.NOTES_WRITE] })
  @ApiOperation({
    summary: 'Create a note and generate it',
    description:
      'Creates the note **and** queues its generation in one call, the same shape ' +
      '`POST /api/transcripts` has: what the user asked for is "a note from this recording", ' +
      'not "a row I will later ask you to fill in".\n\n' +
      'Every check runs before anything is created, so a refused request leaves no ' +
      'half-made note behind:\n\n' +
      '- **409 `details.reason: ai_key_missing`** when **you** have saved no API key. The ' +
      'deployment is fine; a note is generated on your own provider account. **No note is ' +
      'created.**\n' +
      '- **409 `details.reason: ai_not_configured`** when the deployment has not enabled AI ' +
      'or permits no model this build can run.\n' +
      '- **400** when the assembled prompt does not fit the model\'s context window — with ' +
      'the numbers in the message — or the model is not one this deployment permits.\n' +
      '- **404** when you cannot read the source, or the template is not yours and not a ' +
      'built-in.\n\n' +
      '⚠ The generation is billed to **your** provider account, not the deployment\'s.\n\n' +
      'The note comes back in `draft` with `currentVersion: 0` and an empty `body`. Watch it ' +
      'arrive on `GET /api/notes/{id}/stream`; it completes identically with nobody watching.',
  })
  @ApiBody({ type: CreateNoteBodyDto })
  @ApiDataResponse(CreateNoteResultDto, {
    status: 201,
    description: 'The note, and the generation queued for it',
  })
  @ApiResponse({ status: 400, description: 'The prompt does not fit, or the model is not permitted' })
  @ApiResponse({ status: 404, description: 'No such template or source, or no access to it' })
  @ApiResponse({
    status: 409,
    description: 'You have no API key saved, or AI is not configured for this deployment',
    type: NoteConflictDto,
  })
  async create(
    @Body(new ZodValidationPipe(createNoteSchema)) dto: CreateNoteDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notes.create(dto, user);
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  @Get()
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: 'List notes',
    description:
      'Your notes, `updatedAt` descending, paginated by an opaque **cursor** rather than a ' +
      'page number — generation and every save rewrite `updatedAt`, and offset paging over a ' +
      'list that reorders itself while a user scrolls skips rows and repeats others.\n\n' +
      'Filter by `status`, by source kind (`sourceType`), by a specific source ' +
      '(`sourceTranscriptId`, `sourceNoteId`, `sourceObjectId`), by `templateId`, or by a ' +
      'case-insensitive title substring (`q`).\n\n' +
      '**Template previews never appear here.** A preview generation has no note ' +
      '(`note_id: NULL`) and creates none; this route reads `notes`.\n\n' +
      'Each row carries an `excerpt` rather than the whole body — fetch the note itself for ' +
      'the rest.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'generating', 'ready', 'failed', 'deleting'] })
  @ApiQuery({ name: 'sourceType', required: false, enum: ['transcript', 'note', 'document'] })
  @ApiQuery({ name: 'sourceTranscriptId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'sourceNoteId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'sourceObjectId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'templateId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'Case-insensitive title substring' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: '`nextCursor` from the previous page' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1-100 (default 20)' })
  @ApiDataResponse(NoteListDto, { description: 'One page of notes' })
  async list(
    @Query(new ZodValidationPipe(noteListQuerySchema)) query: NoteListQueryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.notes.list(query, userId);
  }

  // ⚠ DECLARED BEFORE `@Get(':id')`. Fastify's router would otherwise match
  // `/api/notes/summary` against the uuid parameter route, and `ParseUUIDPipe`
  // would answer 400 for a literal path that exists.
  @Get('summary')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: 'Home-page summary',
    description:
      'Three lists and four counts in one request: what is still being generated, the eight ' +
      'most recently touched notes, the eight most recent failures, and the totals. Exists so ' +
      'the home page renders in one round trip rather than four.',
  })
  @ApiDataResponse(NoteSummaryDto, { description: 'The caller\'s note summary' })
  async summary(@CurrentUser('id') userId: string) {
    return this.notes.summary(userId);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: 'Get one note',
    description:
      'The note as it stands: its markdown `body`, its status, its `currentVersion`, which ' +
      'provider and model produced the current text, and what it was generated from.\n\n' +
      'Carries a **weak ETag**, `W/"v<currentVersion>"`. A conditional request whose ' +
      '`If-None-Match` matches is answered **304 with no body**, which is what makes polling ' +
      'this route while nothing changes nearly free.\n\n' +
      'A caller with no access gets **404**, never 403: the existence of a specific note id ' +
      'is itself information a stranger has no business learning.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(NoteDto, { description: 'The note' })
  @ApiResponse({ status: 304, description: 'Unchanged since the `If-None-Match` version' })
  @ApiResponse({ status: 404, description: 'No such note, or no access to it' })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const note = await this.notes.detail(id, user);

    return this.conditional(note.currentVersion, note, request, reply);
  }

  @Get(':id/versions')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: 'Browse the version history',
    description:
      'Every save, newest first, cursor-paginated. Each entry carries its `kind` ' +
      '(`ai_generated`, `edit`, `restore`), its one-line `summary`, who saved it and — for a ' +
      'restore — which version it was restored from. Bodies are not included; fetch one with ' +
      '`GET /api/notes/{id}/versions/{version}`.\n\n' +
      '**`author: null` means the AI**, not a missing value: version 1 is the provider\'s own ' +
      'output. Nothing in this API ever deletes a version row short of the note itself being ' +
      'purged.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: '`nextCursor` from the previous page' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1-100 (default 20)' })
  @ApiDataResponse(NoteVersionsDto, { description: 'One page of versions' })
  @ApiResponse({ status: 404, description: 'No such note, or no access to it' })
  async versions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(noteVersionsQuerySchema)) query: NoteVersionsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notes.listVersions(id, query, user);
  }

  @Get(':id/versions/:version')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: 'Read one version',
    description:
      'The note **as it was** at this version, in full.\n\n' +
      'A stored snapshot, not a replay: a note is a page or two of prose, so every version ' +
      'holds the whole markdown body and reading history is a single row read. No reducer, no ' +
      'snapshot job, and **version 1 is always retrievable**.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'version', type: Number })
  @ApiDataResponse(NoteVersionDetailDto, { description: 'The version' })
  @ApiResponse({ status: 404, description: 'No such note or version, or no access' })
  async version(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notes.getVersion(id, version, user);
  }

  // ===========================================================================
  // Write and lifecycle
  // ===========================================================================

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.NOTES_WRITE] })
  @ApiOperation({
    summary: 'Edit a note',
    description:
      'Changes the title, the body, or both.\n\n' +
      'A **body** change requires `baseVersion` and appends a `note_versions` row with you as ' +
      'its author — the AI\'s original is never overwritten and stays retrievable forever. A ' +
      '**title** change is deliberately not versioned: a title is metadata about the note, ' +
      'not content of it, so recording a rename would put a no-op in the history that a later ' +
      'restore could "undo" into a name nobody chose.\n\n' +
      '**409 `details.reason: stale_base_version`** when `baseVersion` is not the note\'s ' +
      'current version — and the body **names `details.currentVersion`**, so the client can ' +
      'show what it is about to overwrite. Two tabs is the ordinary case, and silently ' +
      'discarding the other tab\'s paragraph is the specific failure this exists to rule out.' +
      '\n\n**409 `details.reason: generating`** while a generation is streaming into the note: ' +
      'it is the only writer until it settles.\n\n' +
      'Send `clientBatchId` to make a retry safe: a repeat returns the original result and ' +
      'creates no second version.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: UpdateNoteBodyDto })
  @ApiDataResponse(NoteDto, { description: 'The updated note' })
  @ApiResponse({ status: 400, description: '`baseVersion` missing alongside `body`, or neither field sent' })
  @ApiResponse({ status: 404, description: 'No such note, or no access to it' })
  @ApiResponse({
    status: 409,
    description: 'A stale `baseVersion` (the body names the current one), or the note is generating',
    type: NoteConflictDto,
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateNoteSchema)) dto: UpdateNoteDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notes.update(id, dto, user);
  }

  @Post(':id/regenerate')
  @Auth({ permissions: [PERMISSIONS.NOTES_WRITE] })
  @ApiOperation({
    summary: 'Regenerate a note',
    description:
      'The **only** retry path. `note.generate` never auto-retries — a second attempt would ' +
      'call the same provider with your own key and, a completion being non-deterministic, ' +
      'show different text than the partial stream you watched fail — so retrying is a person ' +
      'pressing a button, and it queues a brand-new job with a fresh one-attempt budget.\n\n' +
      '**History is kept.** The previous body is already a version and stays one; a ' +
      'successful run appends the next version rather than overwriting anything. A `ready` ' +
      'note keeps showing its last good content until the new generation commits.\n\n' +
      'Optionally regenerate with a different `templateId`, a replacement `contextText` ' +
      '(`null` clears it) or a one-off `model`. An empty body re-runs exactly what the note ' +
      'already records.\n\n' +
      '⚠ Billed to **your** provider account.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: RegenerateNoteBodyDto })
  @ApiDataResponse(RegenerateNoteResultDto, { description: 'The note, and the generation queued for it' })
  @ApiResponse({ status: 404, description: 'No such note, template or source, or no access' })
  @ApiResponse({
    status: 409,
    description: 'Already generating, no API key saved, or AI is not configured',
    type: NoteConflictDto,
  })
  async regenerate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(regenerateNoteSchema)) dto: RegenerateNoteDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notes.regenerate(id, dto, user);
  }

  @Post(':id/versions/:version/restore')
  @Auth({ permissions: [PERMISSIONS.NOTES_WRITE] })
  @ApiOperation({
    summary: 'Restore an earlier version',
    description:
      '**History is never rewritten.** A restore **appends** a new version (`kind: restore`) ' +
      'whose body is the old one\'s and which records `restoredFromVersion`. Every version in ' +
      'between — including the one that was current a moment ago — stays exactly as it was, ' +
      'and **version 1, the AI original, is always retrievable**.\n\n' +
      '`baseVersion` **must equal** the note\'s `currentVersion`: a restore carries no ' +
      'per-entity expectations of its own, so a stale view means asking to discard edits the ' +
      'caller has never seen. A mismatch is a **409** naming `details.currentVersion`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'version', type: Number })
  @ApiBody({ type: RestoreNoteVersionBodyDto })
  @ApiDataResponse(NoteDto, { description: 'The note, at its new `restore` version' })
  @ApiResponse({ status: 404, description: 'No such note or version, or no access' })
  @ApiResponse({
    status: 409,
    description: '`baseVersion` is stale, that version is already current, or the note is generating',
    type: NoteConflictDto,
  })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body(new ZodValidationPipe(restoreNoteVersionSchema)) dto: RestoreNoteVersionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notes.restore(id, version, dto, user);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.NOTES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a note',
    description:
      'Owner only. Moves the note to `deleting` and queues `note.purge`, which removes its ' +
      'rows and the storage artifacts it owns — its exports, and the uploaded source document ' +
      '**only when this note is the last thing referencing it**.\n\n' +
      '`deleting` is a real, visible status rather than an immediate row delete because ' +
      'reaching object storage is work that outlives this request: the user-visible delete is ' +
      'instant and the cleanup is durable and retryable. **There is no path back.**\n\n' +
      '**409** while the note is `generating` — a purge would otherwise race the job still ' +
      'writing to it — and **409** while another note names this one as its source, listing ' +
      'the notes standing in the way.\n\n' +
      'The source **transcript is never touched**: a note pointing at it is deleted, the ' +
      'recording is not.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deletion started' })
  @ApiResponse({ status: 404, description: 'No such note, or the caller is not its owner' })
  @ApiResponse({
    status: 409,
    description: 'The note is generating, or another note was generated from it',
    type: NoteConflictDto,
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.notes.remove(id, user);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Stamp the ETag, and answer `304` when the caller already has this version.
   *
   * The `undefined` return is what `TransformInterceptor` recognises — it skips
   * the `{ data, meta }` envelope entirely once the status is 304, so the
   * response carries **no body**, which is what RFC 9110 requires of one.
   */
  private conditional<T>(
    version: number,
    payload: T,
    request: FastifyRequest,
    reply: FastifyReply,
  ): T | undefined {
    const etag = versionETag(version);

    reply.header('ETag', etag);
    // `private, no-cache` — re-validate every time, never store in a shared
    // cache, which is the correct posture for a per-user, access-controlled
    // resource.
    reply.header('Cache-Control', 'private, no-cache');

    if (matchesETag(request.headers['if-none-match'], etag)) {
      reply.status(HttpStatus.NOT_MODIFIED);

      return undefined;
    }

    return payload;
  }
}
