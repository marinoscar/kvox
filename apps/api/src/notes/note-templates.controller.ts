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
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import {
  CreateNoteTemplateBodyDto,
  DeleteNoteTemplateResultDto,
  NoteTemplateDto,
  NoteTemplateListDto,
  PreviewNoteTemplateBodyDto,
  PreviewNoteTemplateResultDto,
  UpdateNoteTemplateBodyDto,
  createNoteTemplateSchema,
  listNoteTemplatesQuerySchema,
  previewNoteTemplateSchema,
  updateNoteTemplateSchema,
  type CreateNoteTemplateDto,
  type ListNoteTemplatesQueryDto,
  type PreviewNoteTemplateDto,
  type UpdateNoteTemplateDto,
} from './dto/note-template.dto';
import { NoteTemplatePreviewService } from './note-template-preview.service';
import { NoteTemplatesService } from './note-templates.service';

// =============================================================================
// NoteTemplatesController (issue #50, epic #45)
// =============================================================================
//
// Nine routes (the last two, per-user hide/unhide, are issue #310). A Note Template is what makes this feature adaptable without
// hard-coding every AI workflow into the application — "produce meeting notes"
// and "produce a follow-up email" are two ROWS, not two code paths — so this
// controller is deliberately a thin CRUD surface over `note_templates` plus the
// one thing that is not CRUD at all: preview.
//
// PER-ROUTE `@Auth`, NO CLASS-LEVEL GUARD, matching `TranscriptsController`:
// the permission a route enforces is readable on the route, and adding a route
// cannot inherit an authority nobody wrote down for it.
//
// -----------------------------------------------------------------------------
// THE TWO REFUSALS, SIDE BY SIDE, BECAUSE THEY LOOK INCONSISTENT AND ARE NOT
// -----------------------------------------------------------------------------
//
//   PATCH/DELETE a BUILT-IN            → 403. Its existence is public: it is in
//                                        every account's own catalogue.
//   PATCH/DELETE ANOTHER USER'S        → 404. Its existence is private.
//
// Both decisions are made in exactly one place —
// `access/note-template-access.service.ts` — whose header carries the full
// argument, and both are asserted next to each other in the integration suite
// so the difference reads as designed rather than as a bug.
//
// -----------------------------------------------------------------------------
// `POST /preview` IS `note_templates:write`, AND IT SPENDS THE CALLER'S MONEY
// -----------------------------------------------------------------------------
//
// The gate is the one issue #50's table names. (docs/specs/notes.md §6.3
// sketched this as `POST /:id/preview` on `notes:write`; the issue supersedes
// it on both counts — the route is collection-level because a preview does not
// need a saved template to exist, and the permission is the templates one
// because the action being performed is "try this template". Both permissions
// are seeded to all three roles, so no deployment behaves differently either
// way.)
//
// It is a REAL generation on the caller's OWN provider account. Every response
// field says so, because the alternative is that the only statement of it lives
// in one screen's UI copy where a second client would never find it.
// =============================================================================

@ApiTags('Note Templates')
@Controller('note-templates')
export class NoteTemplatesController {
  constructor(
    private readonly templates: NoteTemplatesService,
    private readonly previews: NoteTemplatePreviewService,
  ) {}

  // ===========================================================================
  // Read
  // ===========================================================================

  @Get()
  @Auth({ permissions: [PERMISSIONS.NOTE_TEMPLATES_READ] })
  @ApiOperation({
    summary: 'List note templates',
    description:
      'Your own templates **plus every built-in**, in one list, each flagged `builtIn`. A ' +
      'brand-new account with nothing of its own still opens a full, usable catalogue — that is ' +
      'what the seeded built-ins are for.\n\n' +
      'Another user\'s templates are **never** included, under any role: there is no ' +
      '`note_templates:read_any` and no admin read-any route.\n\n' +
      'Archived templates of your own are omitted unless `includeArchived=true`. Built-ins are ' +
      'never archived — nothing can write to them.\n\n' +
      'Templates **you** have hidden (`PUT /{id}/hidden`, built-ins included) are omitted unless ' +
      '`includeHidden=true`; every item carries `hidden` for you. Hiding is per-user — ' +
      'another account hiding a built-in never removes it from yours. `total` counts the ' +
      'filtered list.',
  })
  @ApiQuery({
    name: 'includeArchived',
    required: false,
    type: Boolean,
    description: 'Include your own archived templates (default `false`).',
  })
  @ApiQuery({
    name: 'includeHidden',
    required: false,
    type: Boolean,
    description: 'Include templates you have hidden, built-ins included (default `false`).',
  })
  @ApiDataResponse(NoteTemplateListDto, { description: 'Your templates and the built-ins' })
  async list(
    @Query(new ZodValidationPipe(listNoteTemplatesQuerySchema))
    query: ListNoteTemplatesQueryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.templates.list(userId, query);
  }

  // ⚠ DECLARED BEFORE `@Get(':id')`, and `@Post('preview')` below is declared
  // before nothing at all for the same family of reason: a literal path segment
  // must be registered ahead of the `:id` parameter route, or Fastify matches
  // it against the parameter and `ParseUUIDPipe` answers 400 for a route that
  // exists. (`preview` is a POST and `:id` is a GET, so they cannot actually
  // collide today — the ordering is kept anyway so that adding
  // `POST /note-templates/:id` later does not quietly break it.)
  @Post('preview')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auth({ permissions: [PERMISSIONS.NOTE_TEMPLATES_WRITE] })
  @ApiOperation({
    summary: 'Preview a template — saved or unsaved — against a real source',
    description:
      'Try a template before trusting it with a real note. Send either a saved `templateId` ' +
      '(your own, or a built-in) **or** an unsaved `template` body — the second is the point of ' +
      'this endpoint: you should not have to save a template you have not decided you want in ' +
      'order to find out whether you want it.\n\n' +
      '⚠ **This is a real generation, and it is billed to your own provider account.** It is the ' +
      'same `note.generate` job, the same prompt assembly, the same token budget and the same ' +
      'error taxonomy a real note uses — there is no cheaper "simulated" path, deliberately, ' +
      'because a second implementation would drift from the real one exactly when it mattered.\n\n' +
      'Returns **202** with a `generationId`. Attach to it exactly as you would a note\'s own ' +
      'generation; the tokens stream into the same `note_generations` row.\n\n' +
      '**A preview creates no template and no note.** Its generation row has `noteId: null`, ' +
      'never appears in `GET /api/notes`, and is hard-deleted at `expiresAt` by ' +
      '`notes.housekeeping`. Nothing references it, so nothing breaks when it goes.\n\n' +
      'Refusals: **404** for a template or source you cannot read (never 403 — the existence of ' +
      "somebody else's row is not something this API confirms), **409** when the deployment has " +
      'not enabled AI or you have not saved a key, **400** for an unpermitted model or a source ' +
      'whose assembled prompt exceeds the token budget — that last one naming the actual ' +
      'numbers, before anything has been created or billed.',
  })
  @ApiBody({ type: PreviewNoteTemplateBodyDto })
  @ApiDataResponse(PreviewNoteTemplateResultDto, {
    status: 202,
    description: 'Preview generation queued',
  })
  @ApiResponse({ status: 400, description: 'Unpermitted model, or the prompt exceeds the budget' })
  @ApiResponse({ status: 404, description: 'No such template or source, for you' })
  @ApiResponse({ status: 409, description: 'AI is not configured, or you have no API key' })
  async preview(
    @Body(new ZodValidationPipe(previewNoteTemplateSchema)) dto: PreviewNoteTemplateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.previews.preview(dto, user);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.NOTE_TEMPLATES_READ] })
  @ApiOperation({
    summary: 'Get one note template',
    description:
      'Your own, or a built-in. **Anything else is a 404** — the existence of another user\'s ' +
      'template is not something this API confirms.',
  })
  @ApiParam({ name: 'id', description: 'Template id' })
  @ApiDataResponse(NoteTemplateDto, { description: 'The template' })
  @ApiResponse({ status: 404, description: 'No such template, for you' })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.templates.get(userId, id);
  }

  // ===========================================================================
  // Write
  // ===========================================================================

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auth({ permissions: [PERMISSIONS.NOTE_TEMPLATES_WRITE] })
  @ApiOperation({
    summary: 'Create a note template',
    description:
      'The new template is **yours**. There is no owner field in this request and there never ' +
      'may be one: a client that could name an owner could name `null`, which is exactly how a ' +
      'user would mint a built-in.\n\n' +
      'Names are unique among your own templates only — a built-in may share a name with one of ' +
      'yours, and a collision with one of your own is a **409**.\n\n' +
      '`instructions` over its character ceiling is a **400** naming both the submitted size and ' +
      'the limit.',
  })
  @ApiBody({ type: CreateNoteTemplateBodyDto })
  @ApiDataResponse(NoteTemplateDto, { status: 201, description: 'Template created' })
  @ApiResponse({ status: 400, description: 'Invalid body, or oversized instructions' })
  @ApiResponse({ status: 409, description: 'You already have a template with that name' })
  async create(
    @Body(new ZodValidationPipe(createNoteTemplateSchema)) dto: CreateNoteTemplateDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.templates.create(userId, dto);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.NOTE_TEMPLATES_WRITE] })
  @ApiOperation({
    summary: 'Edit one of your own note templates',
    description:
      'Every field optional; an absent key leaves the column alone, and an explicit `null` on ' +
      '`tone`, `length` or `model` clears it.\n\n' +
      '⚠ **A built-in answers 403, not 404** — deliberately unlike the 404 another user\'s ' +
      'template answers. A built-in is listed in your own catalogue, so its existence is not a ' +
      'secret and pretending it is gone would be misleading rather than protective; another ' +
      "user's template's existence *is* a secret. Built-ins are immutable through this API " +
      'under every role, which is what keeps the seeded set a stable, re-runnable baseline — ' +
      '`POST /{id}/duplicate` is how you customise one.',
  })
  @ApiParam({ name: 'id', description: 'Template id' })
  @ApiBody({ type: UpdateNoteTemplateBodyDto })
  @ApiDataResponse(NoteTemplateDto, { description: 'The updated template' })
  @ApiResponse({ status: 400, description: 'Invalid body, or oversized instructions' })
  @ApiResponse({ status: 403, description: 'Built-in templates are immutable' })
  @ApiResponse({ status: 404, description: 'No such template, for you' })
  @ApiResponse({ status: 409, description: 'You already have a template with that name' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateNoteTemplateSchema)) dto: UpdateNoteTemplateDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.templates.update(userId, id, dto);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.NOTE_TEMPLATES_WRITE] })
  @ApiOperation({
    summary: 'Delete one of your own note templates',
    description:
      '**Archives rather than deletes when notes still reference it**, and says which happened ' +
      'in `outcome`. The referencing note keeps its `templateId` either way — a note that can no ' +
      'longer say what produced it is the opposite of what this feature is for — and an archived ' +
      'template is still readable, still duplicable, and reversible with ' +
      '`PATCH { "isArchived": false }`.\n\n' +
      '⚠ **A built-in answers 403, not 404**, for the reason `PATCH` states.',
  })
  @ApiParam({ name: 'id', description: 'Template id' })
  @ApiDataResponse(DeleteNoteTemplateResultDto, { description: 'Deleted, or archived' })
  @ApiResponse({ status: 403, description: 'Built-in templates are immutable' })
  @ApiResponse({ status: 404, description: 'No such template, for you' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.templates.remove(userId, id);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @Auth({ permissions: [PERMISSIONS.NOTE_TEMPLATES_WRITE] })
  @ApiOperation({
    summary: 'Duplicate a template into your own',
    description:
      '**This is how you customise a built-in.** Works against any template you can read — a ' +
      'built-in, or another of your own for a "start from a variant" flow — and produces a new ' +
      'row owned by you, with a suffixed name, that you may edit freely. The original is ' +
      'untouched, which is what keeps the seeded set a baseline a re-seed can safely re-run.\n\n' +
      'Every column is copied, not just `instructions`: a copy that dropped the structure, tone ' +
      'and length would hand you a form to refill from scratch. `isArchived` resets to `false` — ' +
      'a duplicate is a fresh starting point even when its source was archived.\n\n' +
      'No lineage is recorded. A template is a recipe, not evidence; once duplicated it is ' +
      'simply yours.',
  })
  @ApiParam({ name: 'id', description: 'Template id to copy — yours or a built-in' })
  @ApiDataResponse(NoteTemplateDto, { status: 201, description: 'Your new copy' })
  @ApiResponse({ status: 404, description: 'No such template, for you' })
  async duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.templates.duplicate(userId, id);
  }

  // ===========================================================================
  // Per-user visibility (issue #310)
  // ===========================================================================
  //
  // ⚠ `note_templates:write`, but the ACCESS check is `'read'` — hiding changes
  // one row keyed on the caller and nothing on the template, so a BUILT-IN may
  // be hidden (no 403). Another user's template is still a 404.

  @Put(':id/hidden')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auth({ permissions: [PERMISSIONS.NOTE_TEMPLATES_WRITE] })
  @ApiOperation({
    summary: 'Hide a template from your own picker',
    description:
      'Hides the template from **your** `GET /api/note-templates` list (unless ' +
      '`includeHidden=true`). Works on any template you can read — **built-ins included**: ' +
      'nothing on the shared template changes, so the built-in 403 `PATCH`/`DELETE` answer does ' +
      'not apply here. Nobody else\'s list is affected.\n\n' +
      'A hidden template still works: notes already generated from it keep it, and it can still ' +
      'be read, generated from, previewed and duplicated by id.\n\n' +
      'Idempotent — hiding a template that is already hidden succeeds.',
  })
  @ApiParam({ name: 'id', description: 'Template id — yours or a built-in' })
  @ApiResponse({ status: 204, description: 'Hidden (or already hidden)' })
  @ApiResponse({ status: 404, description: 'No such template, for you' })
  async hide(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.templates.hide(userId, id);
  }

  @Delete(':id/hidden')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auth({ permissions: [PERMISSIONS.NOTE_TEMPLATES_WRITE] })
  @ApiOperation({
    summary: 'Un-hide a template in your own picker',
    description:
      'Returns a template you hid to your `GET /api/note-templates` list. Built-ins included.\n\n' +
      'Idempotent — un-hiding a template that is not hidden succeeds. An id you cannot read is ' +
      'still a **404**.',
  })
  @ApiParam({ name: 'id', description: 'Template id — yours or a built-in' })
  @ApiResponse({ status: 204, description: 'Visible (or already visible)' })
  @ApiResponse({ status: 404, description: 'No such template, for you' })
  async unhide(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.templates.unhide(userId, id);
  }
}
