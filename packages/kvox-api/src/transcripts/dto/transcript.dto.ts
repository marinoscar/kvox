import { createZodDto } from 'nestjs-zod';
import {
  createTranscriptSchema,
  transcriptSpeakerSchema,
  transcriptWordSchema,
  transcriptSegmentSchema,
  transcriptSegmentWordsSchema,
  transcriptListItemSchema,
  transcriptListSchema,
  transcriptDetailSchema,
  transcriptSegmentsSchema,
  transcriptWordsSchema,
  transcriptSummarySchema,
  transcriptAudioSchema,
  updateTranscriptSchema,
  transcriptListQuerySchema,
  transcriptWordsQuerySchema,
  createTranscriptResponseSchema,
} from '@marinoscar/kvox-contract/transcripts';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/transcripts` (issue #488, file `transcripts/transcript.ts`); they are re-exported below so no importer changes.
export {
  TRANSCRIPT_STATUSES,
  TRANSCRIPTION_STATUSES,
  PLAYBACK_STATUSES,
  TRANSCRIPT_ACCESS_ROLES,
  MAX_TITLE_LENGTH,
  transcriptSourceSchema,
  keytermsSchema,
  createTranscriptSchema,
  type CreateTranscriptDto,
  transcriptSpeakerSchema,
  transcriptWordSchema,
  transcriptSegmentSchema,
  transcriptSegmentWordsSchema,
  transcriptListItemSchema,
  transcriptListSchema,
  transcriptDetailSchema,
  transcriptSegmentsSchema,
  transcriptWordsSchema,
  transcriptSummarySchema,
  transcriptAudioSchema,
  updateTranscriptSchema,
  type UpdateTranscriptDto,
  transcriptListQuerySchema,
  type TranscriptListQueryDto,
  transcriptWordsQuerySchema,
  type TranscriptWordsQueryDto,
  DEFAULT_WORDS_WINDOW_MS,
  MAX_WORDS_WINDOW_MS,
  createTranscriptResponseSchema,
} from '@marinoscar/kvox-contract/transcripts';

export class CreateTranscriptBodyDto extends createZodDto(createTranscriptSchema) {}

export class TranscriptSpeakerDto extends createZodDto(transcriptSpeakerSchema) {}

export class TranscriptWordDto extends createZodDto(transcriptWordSchema) {}

export class TranscriptSegmentDto extends createZodDto(transcriptSegmentSchema) {}

export class TranscriptSegmentWordsDto extends createZodDto(
  transcriptSegmentWordsSchema,
) {}

export class TranscriptListItemDto extends createZodDto(transcriptListItemSchema) {}

export class TranscriptListDto extends createZodDto(transcriptListSchema) {}

export class TranscriptDetailDto extends createZodDto(transcriptDetailSchema) {}

export class TranscriptSegmentsDto extends createZodDto(transcriptSegmentsSchema) {}

export class TranscriptWordsDto extends createZodDto(transcriptWordsSchema) {}

export class TranscriptSummaryDto extends createZodDto(transcriptSummarySchema) {}

export class TranscriptAudioDto extends createZodDto(transcriptAudioSchema) {}

export class UpdateTranscriptBodyDto extends createZodDto(updateTranscriptSchema) {}

export class TranscriptListQueryParamsDto extends createZodDto(
  transcriptListQuerySchema,
) {}

export class TranscriptWordsQueryParamsDto extends createZodDto(
  transcriptWordsQuerySchema,
) {}

export class CreateTranscriptResponseDto extends createZodDto(
  createTranscriptResponseSchema,
) {}
