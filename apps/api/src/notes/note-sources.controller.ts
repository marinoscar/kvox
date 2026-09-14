// =============================================================================
// NoteSourcesController (issue #51, epic #45)
// =============================================================================
//
// ONE ROUTE: `POST /api/notes/sources/documents`, gated on `notes:write`.
//
// ⚠ IT IS `notes:write`, NOT `storage:write`, AND NOT A NEW PAIR. Uploading a
// document here is the first half of creating a note — the object it produces
// is `managed_by: 'notes'`, is invisible to the generic storage surface, and
// has no purpose except being named as a note's `sourceObjectId`. Gating it on
// `storage:write` would mean a user who may create notes but not upload
// arbitrary files cannot use the feature, and a user who may upload files but
// not create notes can mint note-managed objects nothing will ever consume.
// `notes:write` is seeded to ALL THREE ROLES (Viewer included), which is the
// posture docs/specs/notes.md §6.3 chose for exactly this kind of core product
// action.
//
// -----------------------------------------------------------------------------
// WHY THE MULTIPART READ IS BOUNDED BEFORE THE SERVICE IS CALLED
// -----------------------------------------------------------------------------
//
// `req.file({ limits: { fileSize } })` with `throwFileSizeLimit: true` makes
// Fastify stop reading and reject at the ceiling, rather than this process
// buffering an arbitrary upload and *then* measuring it. The ceiling is
// `ai.maxDocumentBytes`, read per request — so it has to be read BEFORE the
// part is consumed, which is why the settings read is the first thing this
// method does rather than something the service does on its own.
//
// The alternative — accept, measure, refuse — is how one upload turns into one
// out-of-memory kill, and no amount of checking afterwards undoes the bytes
// already in the heap.
//
// -----------------------------------------------------------------------------
// WHY THE TYPE IS REFUSED HERE AND NOT IN THE JOB
// -----------------------------------------------------------------------------
//
// See `NoteSourcesService`'s header: an object created here cannot be listed or
// deleted through the generic storage endpoints, so an upload accepted and then
// rejected by a job leaves the user with a file they can neither see nor
// remove. The refusal names every accepted type, because "unsupported file
// type" without the list is a guessing game.
// =============================================================================

import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { NoteSourceDocumentDto } from './dto/note-source.dto';
import { acceptedDocumentTypesSentence } from './extraction/document-format';
import { NoteSourcesService } from './note-sources.service';

/**
 * Turn Fastify's multipart failures into the status they mean.
 *
 * `FST_REQ_FILE_TOO_LARGE` is a 413 and everything else in the `FST_` family is
 * a malformed body, which is a 400. Without this they surface as 500s, which
 * tells the user their file broke the server rather than that it is too big.
 */
function toClientError(error: unknown, maxBytes: number): unknown {
  const code = (error as { code?: unknown } | null)?.code;

  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new PayloadTooLargeException(
      `This document is larger than the ${maxBytes}-byte limit this deployment allows for a ` +
        'note source document.',
    );
  }

  if (typeof code === 'string' && code.startsWith('FST_')) {
    return new BadRequestException(
      'Invalid multipart body. Send multipart/form-data with a single "file" field.',
    );
  }

  return error;
}

@ApiTags('Notes')
@Controller('notes/sources')
export class NoteSourcesController {
  constructor(private readonly sources: NoteSourcesService) {}

  @Post('documents')
  @HttpCode(HttpStatus.CREATED)
  @Auth({ permissions: [PERMISSIONS.NOTES_WRITE] })
  @ApiOperation({
    summary: 'Upload a document to generate a note from',
    description:
      'Multipart upload with a single `file` part. The document is stored as a storage object ' +
      '`managed_by: notes` — invisible to `GET /api/storage/objects`, and refusing the generic ' +
      '`DELETE` with a 409 naming this module — and a `note.source.extract` job is queued to ' +
      'turn it into plain text.\n\n' +
      `Accepted types: \`${acceptedDocumentTypesSentence()}\`. Anything else is a **400** ` +
      'carrying the accepted list, and **no object is created**.\n\n' +
      'The size ceiling is the `ai.maxDocumentBytes` system setting; over it is a **413**. ' +
      'Extraction runs on the queue rather than inline because a document outlives the request ' +
      'that uploaded it — and it may be claimed by a worker node, since it needs nothing but ' +
      'the bytes.\n\n' +
      'A PDF that is password-protected, that contains only scanned images, or that is corrupt ' +
      'is **not** a failure of this request: the upload succeeds, and the extraction records a ' +
      'readable reason the note UI shows. Optical character recognition is not supported.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiDataResponse(NoteSourceDocumentDto, {
    status: 201,
    description: 'Document stored and extraction queued',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing file, invalid multipart body, or a type this application cannot read',
  })
  @ApiResponse({ status: 413, description: 'Document exceeds `ai.maxDocumentBytes`' })
  async uploadDocument(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ) {
    if (!req.isMultipart()) {
      throw new BadRequestException(
        'Expected multipart/form-data with a single "file" field.',
      );
    }

    // READ THE CEILING FIRST — it bounds the read itself. See the header.
    const maxBytes = await this.sources.maxDocumentBytes();

    let filename: string;
    let mimeType: string;
    let body: Buffer;

    try {
      const part = await req.file({
        limits: { fileSize: maxBytes, files: 1 },
        throwFileSizeLimit: true,
      });

      if (!part) {
        throw new BadRequestException('No file provided');
      }

      if (part.fieldname !== 'file') {
        throw new BadRequestException('The document must be sent in the "file" field.');
      }

      filename = part.filename;
      mimeType = part.mimetype;
      // Bounded by `fileSize` above. `toBuffer` rejects with
      // FST_REQ_FILE_TOO_LARGE rather than returning a truncated file, which is
      // the difference between a 413 and a corrupt document stored as valid.
      body = await part.toBuffer();
    } catch (error) {
      throw toClientError(error, maxBytes);
    }

    return this.sources.uploadDocument({ filename, mimeType, body }, userId);
  }
}
