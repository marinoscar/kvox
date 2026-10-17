import { createZodDto } from 'nestjs-zod';
import {
  exportOptionFieldSchema,
  transcriptExporterSchema,
  transcriptExportersSchema,
  createTranscriptExportSchema,
  transcriptExportSchema,
} from '@marinoscar/kvox-contract/transcripts';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/transcripts` (issue #488, file `transcripts/transcript-export.ts`); they are re-exported below so no importer changes.
export {
  TRANSCRIPT_EXPORT_STATUSES,
  exportOptionFieldSchema,
  transcriptExporterSchema,
  transcriptExportersSchema,
  createTranscriptExportSchema,
  type CreateTranscriptExportDto,
  transcriptExportSchema,
} from '@marinoscar/kvox-contract/transcripts';

export class ExportOptionFieldDto extends createZodDto(exportOptionFieldSchema) {}

export class TranscriptExporterDto extends createZodDto(transcriptExporterSchema) {}

export class TranscriptExportersDto extends createZodDto(transcriptExportersSchema) {}

export class CreateTranscriptExportBodyDto extends createZodDto(createTranscriptExportSchema) {}

export class TranscriptExportDto extends createZodDto(transcriptExportSchema) {}
