import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { KvoxAuth } from '../../core/index.js';
import { ApiDataResponse } from '../../transcripts/index.js';
import { CurrentActor, type NotesActor } from '../notes-actor.js';
import { NOTES_MODULE_OPTIONS, type ResolvedNotesOptions } from '../notes.options.js';
import { NOTES_WRITE_PERMISSION } from '../notes.permissions.js';
import { NoteLibraryRetryResultDto, NoteLibraryUploadResultDto } from './note-library.dto.js';
import { NoteLibraryUploadService } from './note-library-upload.service.js';

// =============================================================================
// Uploads into import batches (issue #715, epic #708; docs/specs/notes.md §8.8)
// =============================================================================

/** The 500 a request gets when the host never registered `@fastify/multipart`. */
const HOST_MULTIPART_MISSING =
  'This host has not registered @fastify/multipart on its Fastify app, so uploads cannot be read ' +
  '(a kvox host duty: see docs/guides/kvox-desktop.md and $hostPlugins in packages/kvox-slice-peers.json).';

/** One part as `@fastify/multipart`'s `parts()` yields it. */
interface MultipartPart {
  type: 'file' | 'field';
  fieldname: string;
  filename?: string;
  value?: unknown;
  toBuffer?(): Promise<Buffer>;
  file?: { truncated?: boolean };
}

/** The part of `@fastify/multipart`'s request decoration these routes use. */
interface MultipartRequest {
  isMultipart(): boolean;
  parts(options: {
    limits: { fileSize: number; files: number; fields: number };
    throwFileSizeLimit: boolean;
  }): AsyncIterable<MultipartPart>;
}

function tooLarge(maxBytes: number): PayloadTooLargeException {
  return new PayloadTooLargeException(`A document may be at most ${maxBytes} bytes.`);
}

/** A multipart failure as the client's error: 413 over the limit, 400 for any other Fastify one. */
function multipartClientError(error: unknown, maxBytes: number): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE') return tooLarge(maxBytes);
  if (typeof code === 'string' && code.startsWith('FST_')) {
    return new BadRequestException('Invalid multipart body. Send multipart/form-data with a "file" part.');
  }
  return error;
}

/**
 * NoteLibraryUploadController: routes the slice registers itself; a host mounts them through
 * `NotesModule.forRoot` and never instantiates the controller.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Notes')
@Controller('notes')
export class NoteLibraryUploadController {
  constructor(
    private readonly uploads: NoteLibraryUploadService,
    @Inject(NOTES_MODULE_OPTIONS) private readonly options: ResolvedNotesOptions,
  ) {}

  @Post('import-batches/:id/files')
  @HttpCode(HttpStatus.CREATED)
  @KvoxAuth(NOTES_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Upload one file into an import batch',
    description:
      'Multipart with a `file` part and optional `path` (the library-relative path; defaults to the ' +
      'file name) and `mtime` (ms since the epoch) fields, in any order. The file is stored and a ' +
      '`note.library.import` job is queued; the note is made by the job. A file whose bytes the library ' +
      'already imported answers `skipped: true` and queues nothing. A completed batch is re-opened.\n\n' +
      '- **201** `{ itemId, action, skipped }`\n' +
      '- **400** no file, bad multipart, `details.reason`: `invalid_path`, `unsupported_document`, ' +
      '`unsupported_office_format`\n- **404** no such batch, or not yours\n- **409** the batch was cancelled\n' +
      '- **413** over `maxDocumentImportBytes` (25 MiB by default)\n\nRequires `notes:write`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        path: { type: 'string' },
        mtime: { type: 'integer' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiDataResponse(NoteLibraryUploadResultDto, { status: 201, description: 'The queued item, or a skip' })
  @ApiResponse({ status: 404, description: 'No such batch, or it is not yours' })
  async upload(
    @Param('id', ParseUUIDPipe) batchId: string,
    @Req() request: FastifyRequest,
    @CurrentActor() user: NotesActor,
  ) {
    const req = request as unknown as MultipartRequest;
    const maxBytes = this.options.maxDocumentImportBytes;

    if (typeof req.parts !== 'function' || typeof req.isMultipart !== 'function') {
      throw new InternalServerErrorException(HOST_MULTIPART_MISSING);
    }
    if (!req.isMultipart()) throw new BadRequestException('Expected multipart/form-data with a "file" part.');

    let filename: string | undefined;
    let body: Buffer | undefined;
    let path: string | undefined;
    let mtimeMs: number | undefined;

    try {
      for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1, fields: 8 }, throwFileSizeLimit: true })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') throw new BadRequestException('The file must be sent in the "file" field.');
          if (body !== undefined) throw new BadRequestException('Send one file per request.');
          filename = part.filename ?? '';
          body = await part.toBuffer!();
          // `toBuffer` can return the first `fileSize` bytes WITHOUT throwing; truncated is over the limit.
          if (part.file?.truncated) throw tooLarge(maxBytes);
        } else if (part.fieldname === 'path' && typeof part.value === 'string') {
          path = part.value;
        } else if (part.fieldname === 'mtime' && typeof part.value === 'string') {
          const parsed = Number(part.value);
          if (Number.isFinite(parsed)) mtimeMs = parsed;
        }
      }
    } catch (error) {
      throw multipartClientError(error, maxBytes);
    }

    if (body === undefined || filename === undefined) throw new BadRequestException('No file provided');

    return this.uploads.upload(user, batchId, { filename, body, path, mtimeMs });
  }

  @Post('import-batches/:id/retry')
  @HttpCode(HttpStatus.OK)
  @KvoxAuth(NOTES_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Retry the failed items of an import batch',
    description:
      'Re-queues every failed item whose stored file still exists. Answers `{ requeued }`. ' +
      'Requires `notes:write`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(NoteLibraryRetryResultDto, { description: 'How many items were re-queued' })
  @ApiResponse({ status: 404, description: 'No such batch, or it is not yours' })
  retry(@Param('id', ParseUUIDPipe) batchId: string, @CurrentActor() user: NotesActor) {
    return this.uploads.retry(user, batchId);
  }
}
