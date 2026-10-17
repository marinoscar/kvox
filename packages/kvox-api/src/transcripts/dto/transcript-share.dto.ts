import { createZodDto } from 'nestjs-zod';
import {
  createTranscriptShareSchema,
  updateTranscriptShareSchema,
  transcriptShareSchema,
  transcriptSharesSchema,
} from '@marinoscar/kvox-contract/transcripts';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/transcripts` (issue #488, file `transcripts/transcript-share.ts`); they are re-exported below so no importer changes.
export {
  TRANSCRIPT_SHARE_ROLES,
  type TranscriptShareRoleName,
  MAX_EMAIL_LENGTH,
  createTranscriptShareSchema,
  type CreateTranscriptShareDto,
  updateTranscriptShareSchema,
  type UpdateTranscriptShareDto,
  transcriptShareSchema,
  transcriptSharesSchema,
} from '@marinoscar/kvox-contract/transcripts';

export class CreateTranscriptShareBodyDto extends createZodDto(
  createTranscriptShareSchema,
) {}

export class UpdateTranscriptShareBodyDto extends createZodDto(
  updateTranscriptShareSchema,
) {}

export class TranscriptShareDto extends createZodDto(transcriptShareSchema) {}

export class TranscriptSharesDto extends createZodDto(transcriptSharesSchema) {}
