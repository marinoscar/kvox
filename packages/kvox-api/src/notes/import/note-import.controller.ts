import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  PayloadTooLargeException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { KvoxAuth } from '../../core/index.js';
import { ApiDataResponse } from '../../transcripts/index.js';
import { NoteDto } from '../dto/note.dto.js';
import { CurrentActor, type NotesActor } from '../notes-actor.js';
import { NOTES_MODULE_OPTIONS, type ResolvedNotesOptions } from '../notes.options.js';
import { NOTES_WRITE_PERMISSION } from '../notes.permissions.js';
import { NotesService } from '../notes.service.js';
import { NoteImportService } from './note-import.service.js';

// =============================================================================
// POST /api/notes/import (issue #585; docs/specs/notes.md §8.7)
// =============================================================================

/** The 500 a request gets when the host never registered `@fastify/multipart` (a host duty, `$hostPlugins`). */
const HOST_MULTIPART_MISSING =
  'This host has not registered @fastify/multipart on its Fastify app, so uploads cannot be read ' +
  '(a kvox host duty: see docs/guides/kvox-desktop.md and $hostPlugins in packages/kvox-slice-peers.json).';

/** The part of `@fastify/multipart`'s request decoration the import route uses. */
interface MultipartRequest {
  isMultipart(): boolean;
  file(options: { limits: { fileSize: number; files: number }; throwFileSizeLimit: boolean }): Promise<
    | {
        fieldname: string;
        filename: string;
        toBuffer(): Promise<Buffer>;
      }
    | undefined
  >;
}

/** A multipart failure as the client's error: 413 over the limit, 400 for any other Fastify one. */
function multipartClientError(error: unknown, maxBytes: number): unknown {
  const code = (error as { code?: unknown } | null)?.code;

  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new PayloadTooLargeException(`A note file may be at most ${maxBytes} bytes.`);
  }

  if (typeof code === 'string' && code.startsWith('FST_')) {
    return new BadRequestException('Invalid multipart body. Send multipart/form-data with a single "file" field.');
  }

  return error;
}

/**
 * NoteImportController: routes the slice registers itself; a host mounts them through
 * `NotesModule.forRoot` and never instantiates the controller.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Notes')
@Controller('notes')
export class NoteImportController {
  constructor(
    private readonly imports: NoteImportService,
    private readonly notes: NotesService,
    @Inject(NOTES_MODULE_OPTIONS) private readonly options: ResolvedNotesOptions,
  ) {}

  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  @KvoxAuth(NOTES_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Import a note from a Markdown note export',
    description:
      'Multipart upload with a single `file` part holding the Markdown the note export ' +
      'writes (`format: markdown`). Creates a new note owned by the caller, already ' +
      '`ready`, with the same title and body: the title comes from the front matter ' +
      '(`title`), else the leading `# heading`, else the file name; the exporter\'s title ' +
      'heading and provenance block are not part of the body. Any Markdown or text file ' +
      'is accepted the same way, so an export written without front matter imports as a ' +
      'plain-body note.\n\n' +
      'Version 1 is an `edit` authored by the caller, summary `Imported from <file>`. The ' +
      'file is kept as the note\'s source document (`sourceType: document`, ' +
      '`managed_by: notes`) and its text extraction is queued, so a regeneration with a ' +
      'template reads it like any document source. `kvox.notes.note_ready` is published, ' +
      'so connected knowledge treats the note like a generated one. The import is ' +
      'synchronous and bounded by the size limit (5 MiB by default, the slice option ' +
      '`maxImportBytes`).\n\n' +
      '- **201** the new note, as `GET /api/notes/{id}` returns it\n' +
      '- **400** no file, a part not named `file`, or not multipart; or the file is refused, ' +
      'with `details.reason`: `not_text` (not UTF-8 text), `invalid_front_matter` (a front ' +
      'matter block that is not closed or not `key: value` lines; `details.line` names the ' +
      'line), `unsupported_note_format` (the front matter names another format than ' +
      '`kvox.note/v1`; `details.schema` echoes it) or `empty_note` (no text once the title ' +
      'and header are read)\n' +
      '- **413** over the size limit\n\nRequires `notes:write`.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'A Markdown note export, or a Markdown or text file' },
      },
    },
  })
  @ApiDataResponse(NoteDto, { status: 201, description: 'Note imported' })
  @ApiResponse({
    status: 400,
    description:
      'Missing file or invalid multipart body; or `details.reason`: `not_text`, ' +
      '`invalid_front_matter`, `unsupported_note_format` or `empty_note`',
  })
  @ApiResponse({ status: 413, description: 'The file is over the import size limit' })
  async importNote(@Req() request: FastifyRequest, @CurrentActor() user: NotesActor) {
    // `@fastify/multipart` decorates the request; its types are the host's, so the slice
    // states the members it uses. The read is bounded BEFORE anything is buffered.
    const req = request as unknown as MultipartRequest;
    const maxBytes = this.options.maxImportBytes;

    if (typeof req.isMultipart !== 'function') {
      throw new InternalServerErrorException(HOST_MULTIPART_MISSING);
    }

    if (!req.isMultipart()) {
      throw new BadRequestException('Expected multipart/form-data with a single "file" field.');
    }

    let filename: string;
    let body: Buffer;

    try {
      const part = await req.file({ limits: { fileSize: maxBytes, files: 1 }, throwFileSizeLimit: true });

      if (!part) throw new BadRequestException('No file provided');
      if (part.fieldname !== 'file') throw new BadRequestException('The file must be sent in the "file" field.');

      filename = part.filename;
      body = await part.toBuffer();
    } catch (error) {
      throw multipartClientError(error, maxBytes);
    }

    const { noteId } = await this.imports.importFile(user, { filename, body });

    return this.notes.detail(noteId, user);
  }
}
