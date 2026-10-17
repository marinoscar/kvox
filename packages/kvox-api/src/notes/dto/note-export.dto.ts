import { createZodDto } from 'nestjs-zod';
import {
  noteExportOptionFieldSchema,
  noteExporterSchema,
  noteExportersSchema,
  createNoteExportSchema,
  noteExportSchema,
  noteExportListSchema,
  noteExportDownloadSchema,
} from '@marinoscar/kvox-contract/notes';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/notes` (issue #488, file `notes/note-export.ts`); they are re-exported below so no importer changes.
export {
  NOTE_EXPORT_STATUSES,
  noteExportOptionFieldSchema,
  noteExporterSchema,
  noteExportersSchema,
  createNoteExportSchema,
  type CreateNoteExportDto,
  noteExportSchema,
  noteExportListSchema,
  noteExportDownloadSchema,
} from '@marinoscar/kvox-contract/notes';

export class NoteExportOptionFieldDto extends createZodDto(noteExportOptionFieldSchema) {}

export class NoteExporterDto extends createZodDto(noteExporterSchema) {}

export class NoteExportersDto extends createZodDto(noteExportersSchema) {}

export class CreateNoteExportBodyDto extends createZodDto(createNoteExportSchema) {}

export class NoteExportDto extends createZodDto(noteExportSchema) {}

export class NoteExportListDto extends createZodDto(noteExportListSchema) {}

export class NoteExportDownloadDto extends createZodDto(noteExportDownloadSchema) {}
