import { createZodDto } from 'nestjs-zod';
import { noteSourceDownloadSchema } from '@marinoscar/kvox-contract/notes';

export {
  noteSourceDownloadSchema,
  noteSourceDownloadQuerySchema,
  type NoteSourceDownload,
  type NoteSourceDownloadQuery,
} from '@marinoscar/kvox-contract/notes';

export class NoteSourceDownloadDto extends createZodDto(noteSourceDownloadSchema) {}
