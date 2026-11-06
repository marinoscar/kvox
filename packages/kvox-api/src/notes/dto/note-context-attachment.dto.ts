import { createZodDto } from 'nestjs-zod';
import {
  noteContextAttachmentStatusResponseSchema,
  noteContextAttachmentUploadResponseSchema,
} from '@marinoscar/kvox-contract/notes';

/** `POST /api/notes/context/attachments` (issue #810). */
export class NoteContextAttachmentUploadDto extends createZodDto(noteContextAttachmentUploadResponseSchema) {}

/** `GET /api/notes/context/attachments/{objectId}` (issue #810). */
export class NoteContextAttachmentStatusDto extends createZodDto(noteContextAttachmentStatusResponseSchema) {}
