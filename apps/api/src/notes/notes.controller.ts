// =============================================================================
// NotesController (issue #53, epic #45)
// =============================================================================
//
// Ten routes: create, list, summary, detail, edit, regenerate, browse history,
// read one version, restore one, delete — plus #54's three exports and #184's
// two retitles.
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
  RetitleNoteResultDto,
  RetitleSweepResultDto,
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
import {
  CreateNoteExportBodyDto,
  NoteExportDownloadDto,
  NoteExportDto,
  NoteExportListDto,
  NoteExportersDto,
  createNoteExportSchema,
  type CreateNoteExportDto,
} from './dto/note-export.dto';
import { NoteExportService } from './export/note-export.service';
import { NotesService } from './notes.service';

@ApiTags('Notes')
@Controller('notes')
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly exports: NoteExportService,
  ) {}

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

  // ⚠ DECLARED BEFORE `@Get(':id')`, for the identical reason `summary` is.
  @Get('exporters')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: 'List the available export formats',
    description:
      'Every registered note exporter, with the options it accepts. The export dialog builds ' +
      'itself from this response rather than from a list of formats compiled into the ' +
      'client, so a deployment that registers a new exporter offers it immediately.\n\n' +
      'Each option carries its `key`, a `label`, a `description` and a `default`. Send the ' +
      'keys you want to change inside `options` on `POST /api/notes/{id}/exports`; an ' +
      'unknown key is a **400**, never a silently ignored field.',
  })
  @ApiDataResponse(NoteExportersDto, { description: 'The registered export formats' })
  exporters() {
    return this.exports.listExporters();
  }

  // ⚠ ALSO BEFORE `@Get(':id')`. `notes/exports/:exportId/download` is four
  // segments and cannot collide with the two-segment `:id` route, but it sits
  // here beside its sibling so the literal-prefix rule is visible in one place.
  @Get('exports/:exportId/download')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: 'Download a rendered export',
    description:
      'A short-lived (15 minute) **signed URL** that serves the rendered file as an ' +
      'attachment named `<title> (v<n>).<ext>`. The `Content-Disposition` is signed **into** ' +
      'the URL, so a client cannot add the filename afterwards.\n\n' +
      'No note id in the path: the export names its own note, and access is decided on that ' +
      'note. An export belonging to somebody else\'s note answers **404** — the same answer ' +
      'a non-existent export id gets, so an export id cannot be used to discover that ' +
      'another user\'s note exists.\n\n' +
      '**404** while the export is still rendering, and **404** once it has expired: there ' +
      'is no file to hand back in either case. Request the identical export again and you ' +
      'get the identical file.',
  })
  @ApiParam({ name: 'exportId', type: String, format: 'uuid' })
  @ApiDataResponse(NoteExportDownloadDto, { description: 'The signed download' })
  @ApiResponse({ status: 404, description: 'No such export, not ready, or no access to its note' })
  async downloadExport(
    @Param('exportId', ParseUUIDPipe) exportId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.exports.download(exportId, user);
  }

  // ===========================================================================
  // Retitle (issue #184, epic #163)
  // ===========================================================================

  // ⚠ DECLARED BEFORE THE PARAMETERISED ROUTES, the same rule `summary` and
  // `exporters` are declared under. `notes/retitle` is a literal two-segment
  // path and today no `@Post(':id')` exists for it to be matched against — but
  // the day one does, a route declared after it would be shadowed and answer
  // 400 from `ParseUUIDPipe` for a path that exists. The rule is cheap; the
  // failure it prevents is a live endpoint that silently stops working.
  //
  // Its sibling `:id/retitle` sits here beside it rather than down in the write
  // section, so the pair reads as the one feature it is.
  @Post('retitle')
  @Auth({ permissions: [PERMISSIONS.NOTES_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Retitle your library',
    description:
      'Queues a `note.retitle` job for a capped page of **your own** notes that are still ' +
      'named after the template that generated them, and reports how many are left.\n\n' +
      'A note is selected when it is `ready`, not deleted, and its `titleSource` is still ' +
      '`template`. **A note you renamed yourself is never selected**, and neither is one this ' +
      'pass has already named (`titleSource: ai`) — so calling this repeatedly converges ' +
      'rather than re-billing you for the same library. Use ' +
      '`POST /api/notes/{id}/retitle` to re-name a specific note regardless.\n\n' +
      '**Resumable and stoppable.** `queued` is what this call started; `remaining` is what ' +
      'still matches. Call again once the jobs settle; `remaining: 0` means done. Stop by not ' +
      'calling again — each note is its own job and no batch state is left behind.\n\n' +
      'Calling twice does **not** queue a note twice: a note with a `note.retitle` job already ' +
      'pending or running collapses into that job.\n\n' +
      '⚠ Each note is a small completion billed to **your** provider account. A note whose ' +
      'title cannot be produced by the model falls back to its own first heading, and failing ' +
      'that keeps the name it has — neither is an error.',
  })
  @ApiDataResponse(RetitleSweepResultDto, {
    status: 202,
    description: 'The jobs queued, and how many notes still match',
  })
  async retitleAll(@CurrentUser() user: RequestUser) {
    return this.notes.retitleAll(user);
  }

  @Post(':id/retitle')
  @Auth({ permissions: [PERMISSIONS.NOTES_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Suggest a title for one note',
    description:
      'Queues a `note.retitle` job for this note and returns immediately — titling is a ' +
      'provider call, so it is queue work, not something a request waits on. Re-read the note ' +
      '(or watch the job) to see the new title.\n\n' +
      'The title is taken from the note\'s own content: the model that generated it is asked ' +
      'what it would call it, falling back to the body\'s first heading or sentence, falling ' +
      'back to the name it already has. None of those fallbacks is an error.\n\n' +
      '⚠ **This route will rename a note you named yourself.** Asking for a suggestion about ' +
      'a note in front of you is an explicit choice, so it wins — unlike ' +
      '`POST /api/notes/retitle`, which never touches a name a person chose because it sweeps ' +
      'notes nobody is looking at. The previous title is not kept anywhere: a title is ' +
      'metadata about the note, not versioned content of it.\n\n' +
      '**409** while the note is `generating` — that generation names the note itself when it ' +
      'commits, and two passes racing for one title spend tokens for one answer.\n\n' +
      '⚠ Billed to **your** provider account.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(RetitleNoteResultDto, {
    status: 202,
    description: 'The `note.retitle` job queued for this note',
  })
  @ApiResponse({ status: 404, description: 'No such note, or no access to it' })
  @ApiResponse({
    status: 409,
    description: 'The note is generating',
    type: NoteConflictDto,
  })
  async retitle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notes.retitle(id, user);
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
  // Export (issue #54, spec §8)
  // ===========================================================================

  @Post(':id/exports')
  @Auth({ permissions: [PERMISSIONS.NOTES_WRITE] })
  @ApiOperation({
    summary: 'Export a note',
    description:
      'Renders one version of this note into one format — `markdown`, `pdf` or `docx` — as a ' +
      '**queue job**. There is no size threshold below which an export runs inside the ' +
      'request, because a threshold is two code paths where the fast one breaks on the first ' +
      'unusually long note.\n\n' +
      '**202** with the new export when a render was queued. **200** when an export of the ' +
      'same version, format and options already exists and has not expired: the identical ' +
      'request produces the identical file, so it is returned rather than rendered again. ' +
      'The `reused` field says which happened, for a client that cannot see the status ' +
      'line.\n\n' +
      '`version` defaults to the current version; **any version in the history may be ' +
      'exported** and the export contains *that* version\'s body, so an exported document ' +
      'names exactly what it contains. `options` are validated against the chosen format\'s ' +
      'own schema from `GET /api/notes/exporters` — an unknown key is a 400.\n\n' +
      'Every format carries a **provenance header** naming the source (the transcript and ' +
      'its date, the source note, or the document filename), the template used, the version ' +
      'exported and the generation timestamp. There is no option to suppress it: it is the ' +
      'export\'s only carried memory of where the content came from once the file has left ' +
      'this application.\n\n' +
      'Exports expire after **7 days** and their files are deleted by the notes housekeeping ' +
      'sweep. Nothing is lost — requesting the identical export again produces the identical ' +
      'file.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: CreateNoteExportBodyDto })
  @ApiDataResponse(NoteExportDto, {
    status: 202,
    description: 'A render was queued; poll `GET /api/notes/{id}/exports` for its status',
  })
  @ApiResponse({ status: 200, description: 'An identical, unexpired export already existed' })
  @ApiResponse({
    status: 400,
    description: 'Unknown format, or an option that format does not accept',
  })
  @ApiResponse({ status: 404, description: 'No such note or version, or no access to it' })
  async createExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createNoteExportSchema)) dto: CreateNoteExportDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.exports.requestExport(id, dto, user);

    reply.status(result.created ? HttpStatus.ACCEPTED : HttpStatus.OK);

    return result.export;
  }

  @Get(':id/exports')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: "List a note's exports",
    description:
      'Every unexpired export of this note, newest first, each with its status and — once it ' +
      'is `ready` — a short-lived signed `downloadUrl`.\n\n' +
      'Poll this while an export is `pending`. A `failed` export carries the reason in ' +
      '`error`; requesting the same export again queues a fresh render rather than returning ' +
      'the failure, because a failed row is never reused.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(NoteExportListDto, { description: "The note's exports" })
  @ApiResponse({ status: 404, description: 'No such note, or no access to it' })
  async listExports(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.exports.listExports(id, user);
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
