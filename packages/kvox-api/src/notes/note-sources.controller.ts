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
  InternalServerErrorException,
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

import { KvoxAuth } from '../core/index.js';
import { ApiDataResponse } from '../transcripts/index.js';
import { CurrentActor, type NotesActor } from './notes-actor.js';
import { NOTES_WRITE_PERMISSION } from './notes.permissions.js';

import { NoteSourceDocumentDto } from './dto/note-source.dto.js';
import { acceptedDocumentTypesSentence } from './extraction/document-format.js';
import { NoteSourcesService } from './note-sources.service.js';

/** The 500 a request gets when the host never registered `@fastify/multipart` (a host duty, `$hostPlugins`). */
const HOST_MULTIPART_MISSING =
  'This host has not registered @fastify/multipart on its Fastify app, so uploads cannot be read ' +
  '(a kvox host duty: see docs/guides/kvox-desktop.md and $hostPlugins in packages/kvox-slice-peers.json).';

/**
 * Turn Fastify's multipart failures into the status they mean.
 *
 * `FST_REQ_FILE_TOO_LARGE` is a 413 and everything else in the `FST_` family is
 * a malformed body, which is a 400. Without this they surface as 500s, which
 * tells the user their file broke the server rather than that it is too big.
 */
/** The part of `@fastify/multipart`'s request decoration this controller uses. */
interface MultipartRequest {
  isMultipart(): boolean;
  file(options: { limits: { fileSize: number; files: number }; throwFileSizeLimit: boolean }): Promise<
    | {
        fieldname: string;
        filename: string;
        mimetype: string;
        toBuffer(): Promise<Buffer>;
        file?: { truncated?: boolean };
      }
    | undefined
  >;
}

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

/**
 * NoteSourcesController: routes the slice registers itself; a host mounts them through `NotesModule.forRoot` and never instantiates the controller.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Notes')
@Controller('notes/sources')
export class NoteSourcesController {
  constructor(private readonly sources: NoteSourcesService) {}

  @Post('documents')
  @HttpCode(HttpStatus.CREATED)
  @KvoxAuth(NOTES_WRITE_PERMISSION)
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
    @Req() request: FastifyRequest,
    @CurrentActor('id') userId: string,
  ) {
    // `@fastify/multipart` decorates the request; its types are the host's, so the slice states
    // the two members it uses.
    const req = request as unknown as MultipartRequest;

    // A host that skipped the plugin has no decoration: say so instead of a bare TypeError.
    if (typeof req.isMultipart !== 'function') {
      throw new InternalServerErrorException(HOST_MULTIPART_MISSING);
    }

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
      // Bounded by `fileSize` above. Over it must be a 413, never a truncated
      // file: that is the difference between a 413 and a corrupt document stored
      // as valid (the check below covers the case `toBuffer` does not throw).
      body = await part.toBuffer();
      // ⚠ `toBuffer` can return the first `fileSize` bytes WITHOUT throwing when the limit is
      // hit as the last chunk is read (#585); a truncated file is over the limit, never valid.
      if (part.file?.truncated) throw Object.assign(new Error('File too large'), { code: 'FST_REQ_FILE_TOO_LARGE' });
    } catch (error) {
      throw toClientError(error, maxBytes);
    }

    return this.sources.uploadDocument({ filename, mimeType, body }, userId);
  }
}
