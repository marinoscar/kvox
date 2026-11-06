// =============================================================================
// NoteContextAttachmentsController (issue #810)
// =============================================================================
//
//   POST /api/notes/context/attachments            upload, gated on `notes:write`
//   GET  /api/notes/context/attachments/:objectId  readiness, `notes:read`
//
// The same guard, the same multipart handling and the same owner-scoped 404 as
// `NoteSourcesController`; see its header for why the upload is `notes:write` (not a storage
// permission) and why the multipart read is bounded before the service is called.
// =============================================================================

import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { KvoxAuth } from '../core/index.js';
import { ApiDataResponse } from '../transcripts/index.js';
import { CurrentActor } from './notes-actor.js';
import { NOTES_READ_PERMISSION, NOTES_WRITE_PERMISSION } from './notes.permissions.js';
import { NoteContextAttachmentStatusDto, NoteContextAttachmentUploadDto } from './dto/note-context-attachment.dto.js';
import { assertMultipart, readSingleFileUpload } from './multipart-upload.js';
import { NoteContextAttachmentsService } from './note-context-attachments.service.js';

/**
 * NoteContextAttachmentsController: routes the slice registers itself; a host mounts them through `NotesModule.forRoot` and never instantiates the controller.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Notes')
@Controller('notes/context/attachments')
export class NoteContextAttachmentsController {
  constructor(private readonly attachments: NoteContextAttachmentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @KvoxAuth(NOTES_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Upload a file to attach to a note as context',
    description:
      'Multipart upload with a single `file` part. A **document** (txt, md, pdf, docx, pptx) is ' +
      'stored and a `note.source.extract` job is queued; poll `GET /api/notes/context/attachments/{objectId}` ' +
      'until it is `ready` (its extracted text joins the prompt). An **image** (png, jpeg, webp, gif; ' +
      'the leading bytes must match the type) is stored and is `ready` at once; it is sent to the ' +
      'model as vision input, which needs a vision-capable model.\n\n' +
      'Pass the returned `objectId`s as `contextAttachmentIds` to `POST /api/notes` or ' +
      '`POST /api/notes/{id}/regenerate`. The size ceiling is the `ai.maxDocumentBytes` system ' +
      'setting (413 over it). An unsupported type is a **400** with `details.reason: ' +
      'context_attachment_unsupported_type`.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiDataResponse(NoteContextAttachmentUploadDto, { status: 201, description: 'File stored' })
  @ApiResponse({ status: 400, description: 'Missing file, invalid multipart body, or an unsupported type' })
  @ApiResponse({ status: 413, description: 'File exceeds `ai.maxDocumentBytes`' })
  async upload(@Req() request: FastifyRequest, @CurrentActor('id') userId: string) {
    assertMultipart(request);
    // READ THE CEILING FIRST: it bounds the read itself.
    const maxBytes = await this.attachments.maxBytes();
    const { filename, mimeType, body } = await readSingleFileUpload(request, maxBytes, 'file');

    return this.attachments.upload({ filename, mimeType, body }, userId);
  }

  @Get(':objectId')
  @KvoxAuth(NOTES_READ_PERMISSION)
  @ApiOperation({
    summary: 'Get the readiness of an uploaded context attachment',
    description:
      'An image is `ready` at once. A document is `extracting` until the extraction records a ' +
      'result, then `ready` (`characters` counts the text) or `unextractable` (`message` says ' +
      'why; it cannot be used). Owner-scoped: a missing id, an object this module does not own ' +
      'and another user\'s attachment all answer the same **404**.',
  })
  @ApiDataResponse(NoteContextAttachmentStatusDto, { status: 200, description: 'The attachment\'s readiness' })
  @ApiResponse({ status: 400, description: '`objectId` is not a UUID' })
  @ApiResponse({ status: 404, description: 'No context attachment with this id belongs to the caller' })
  async status(@Param('objectId', ParseUUIDPipe) objectId: string, @CurrentActor('id') userId: string) {
    return this.attachments.status(objectId, userId);
  }
}
