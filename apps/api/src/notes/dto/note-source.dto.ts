import { createZodDto } from 'nestjs-zod';
import { noteSourceDocumentResponseSchema } from '@marinoscar/kvox-contract/notes';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/notes` (issue #488, file `notes/note-source.ts`); they are re-exported below so no importer changes.
export {
  noteSourceDocumentResponseSchema,
} from '@marinoscar/kvox-contract/notes';

export class NoteSourceDocumentDto extends createZodDto(
  noteSourceDocumentResponseSchema,
) {}
