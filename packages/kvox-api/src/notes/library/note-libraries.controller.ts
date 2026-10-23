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
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import {
  createNoteLibraryRequestSchema,
  noteLibraryScanRequestSchema,
  updateNoteLibraryRequestSchema,
  type CreateNoteLibraryRequest,
  type NoteLibraryScanRequest,
  type UpdateNoteLibraryRequest,
} from '@marinoscar/kvox-contract/notes';

import { KvoxAuth } from '../../core/index.js';
import { ApiDataResponse } from '../../transcripts/index.js';
import { CurrentActor, type NotesActor } from '../notes-actor.js';
import { NOTES_READ_PERMISSION, NOTES_WRITE_PERMISSION } from '../notes.permissions.js';
import {
  CreateNoteImportBatchResultDto,
  CreateNoteLibraryBodyDto,
  NoteImportBatchDto,
  NoteImportBatchItemsPageDto,
  NoteImportBatchListDto,
  NoteLibraryDto,
  NoteLibraryListDto,
  NoteLibraryScanBodyDto,
  NoteLibraryScanResultDto,
  UpdateNoteLibraryBodyDto,
  importBatchItemsQuerySchema,
  importBatchListQuerySchema,
  type ImportBatchItemsQuery,
  type ImportBatchListQuery,
} from './note-library.dto.js';
import { NoteLibrariesService } from './note-libraries.service.js';

// =============================================================================
// Note libraries and import batches (issue #714, epic #708; docs/specs/notes.md §8.8)
// =============================================================================
//
// Per-route `KvoxAuth`, owner-only: a library or batch that is not the caller's is a 404,
// never a 403, like a note. The static `libraries` and `import-batches` paths sit beside
// `NotesController`'s `:id` routes; Fastify's router prefers a static segment.
// =============================================================================

const NOT_FOUND = {
  status: 404,
  description: 'No such library or batch, or it is not yours',
} as const;

/**
 * NoteLibrariesController: routes the slice registers itself; a host mounts them through
 * `NotesModule.forRoot` and never instantiates the controller.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Notes')
@Controller('notes')
export class NoteLibrariesController {
  constructor(private readonly libraries: NoteLibrariesService) {}

  @Post('libraries')
  @KvoxAuth(NOTES_WRITE_PERMISSION)
  @ApiOperation({ summary: 'Create a note library', description: 'Requires `notes:write`.' })
  @ApiBody({ type: CreateNoteLibraryBodyDto })
  @ApiDataResponse(NoteLibraryDto, { status: 201, description: 'The new library' })
  create(
    @Body(new ZodValidationPipe(createNoteLibraryRequestSchema)) dto: CreateNoteLibraryRequest,
    @CurrentActor() user: NotesActor
  ) {
    return this.libraries.create(user, dto.name);
  }

  @Get('libraries')
  @KvoxAuth(NOTES_READ_PERMISSION)
  @ApiOperation({
    summary: 'List your note libraries',
    description: 'Newest first, each with its file counts by status. Requires `notes:read`.',
  })
  @ApiDataResponse(NoteLibraryListDto, { description: 'Your libraries' })
  list(@CurrentActor() user: NotesActor) {
    return this.libraries.list(user);
  }

  @Get('libraries/:id')
  @KvoxAuth(NOTES_READ_PERMISSION)
  @ApiOperation({ summary: 'Get a note library', description: 'Requires `notes:read`.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(NoteLibraryDto, { description: 'The library' })
  @ApiResponse(NOT_FOUND)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() user: NotesActor) {
    return this.libraries.get(user, id);
  }

  @Patch('libraries/:id')
  @KvoxAuth(NOTES_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Rename a library or change its policy',
    description: 'Any of `name`, `autoExtract`, `autoCommit`. Requires `notes:write`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: UpdateNoteLibraryBodyDto })
  @ApiDataResponse(NoteLibraryDto, { description: 'The library' })
  @ApiResponse(NOT_FOUND)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateNoteLibraryRequestSchema)) dto: UpdateNoteLibraryRequest,
    @CurrentActor() user: NotesActor
  ) {
    return this.libraries.update(user, id, dto);
  }

  @Delete('libraries/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @KvoxAuth(NOTES_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Delete a library',
    description:
      'Deletes the library and its file rows. The notes made from its files are kept, and its ' +
      'import batches stay with no library. Requires `notes:write`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse(NOT_FOUND)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() user: NotesActor
  ): Promise<void> {
    await this.libraries.remove(user, id);
  }

  @Post('libraries/:id/scan')
  @HttpCode(HttpStatus.OK)
  @KvoxAuth(NOTES_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Scan a library: diff a manifest',
    description:
      'The client sends what it found (path, size, mtime, optionally a sha256). The answer lists ' +
      'the paths to `upload`, the paths whose hash is `hashNeeded` first (send them again with ' +
      '`sha256`), the paths now `missing`, and an `estimate`. `batchId` is the batch the uploads ' +
      'belong to, `null` when there is nothing to do. `complete: false` never marks files missing. ' +
      'Requires `notes:write`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: NoteLibraryScanBodyDto })
  @ApiDataResponse(NoteLibraryScanResultDto, { description: 'What to upload' })
  @ApiResponse(NOT_FOUND)
  scan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(noteLibraryScanRequestSchema)) dto: NoteLibraryScanRequest,
    @CurrentActor() user: NotesActor
  ) {
    return this.libraries.scan(user, id, dto);
  }

  @Post('import-batches')
  @KvoxAuth(NOTES_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Open an ad-hoc import batch',
    description:
      'A batch that belongs to no library, for files dropped on the page. Requires `notes:write`.',
  })
  @ApiDataResponse(CreateNoteImportBatchResultDto, { status: 201, description: 'The new batch' })
  createBatch(@CurrentActor() user: NotesActor) {
    return this.libraries.createAdHocBatch(user);
  }

  @Get('import-batches')
  @KvoxAuth(NOTES_READ_PERMISSION)
  @ApiOperation({
    summary: 'List recent import batches',
    description:
      'Newest first, optionally of one library, with item counts. Requires `notes:read`.',
  })
  @ApiDataResponse(NoteImportBatchListDto, { description: 'Recent batches' })
  listBatches(
    @Query(new ZodValidationPipe(importBatchListQuerySchema)) query: ImportBatchListQuery,
    @CurrentActor() user: NotesActor
  ) {
    return this.libraries.listBatches(user, query);
  }

  @Get('import-batches/:id')
  @KvoxAuth(NOTES_READ_PERMISSION)
  @ApiOperation({
    summary: 'Get an import batch',
    description:
      'The batch with its counts by item status and by pipeline stage. Requires `notes:read`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(NoteImportBatchDto, { description: 'The batch' })
  @ApiResponse(NOT_FOUND)
  getBatch(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() user: NotesActor) {
    return this.libraries.getBatch(user, id);
  }

  @Get('import-batches/:id/items')
  @KvoxAuth(NOTES_READ_PERMISSION)
  @ApiOperation({
    summary: 'List the items of an import batch',
    description:
      'Oldest first, cursor-paginated, optionally filtered by `status`. Requires `notes:read`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(NoteImportBatchItemsPageDto, { description: 'A page of items' })
  @ApiResponse(NOT_FOUND)
  listItems(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(importBatchItemsQuerySchema)) query: ImportBatchItemsQuery,
    @CurrentActor() user: NotesActor
  ) {
    return this.libraries.listItems(user, id, query);
  }
}
