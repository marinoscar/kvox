import { createZodDto } from 'nestjs-zod';
import {
  noteSourceDocumentResponseSchema,
  noteSourceDocumentStatusResponseSchema,
} from '@marinoscar/kvox-contract/notes';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/notes` (issue #488, file `notes/note-source.ts`); they are re-exported below so no importer changes.
export {
  noteSourceDocumentResponseSchema,
  noteSourceDocumentStatusResponseSchema,
} from '@marinoscar/kvox-contract/notes';

export class NoteSourceDocumentDto extends createZodDto(
  noteSourceDocumentResponseSchema,
) {}

/** `GET /api/notes/sources/documents/{objectId}` — the extraction status of one source document (#596). */
export class NoteSourceDocumentStatusDto extends createZodDto(
  noteSourceDocumentStatusResponseSchema,
) {}
