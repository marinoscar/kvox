import { createZodDto } from 'nestjs-zod';
import {
  applyOperationsSchema,
  mergeUndoSchema,
  operationsResultSchema,
  operationsConflictSchema,
  transcriptSearchQuerySchema,
  transcriptSearchSchema,
  transcriptVersionsQuerySchema,
  transcriptVersionSummarySchema,
  transcriptVersionsSchema,
  transcriptVersionDetailSchema,
  restoreVersionSchema,
} from '@marinoscar/kvox-contract/transcripts';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/transcripts` (issue #488, file `transcripts/transcript-editing.ts`); they are re-exported below so no importer changes.
export {
  applyOperationsSchema,
  type ApplyOperationsDto,
  mergeUndoSchema,
  operationsResultSchema,
  operationsConflictSchema,
  MAX_SEARCH_MATCHES,
  transcriptSearchQuerySchema,
  type TranscriptSearchQueryDto,
  transcriptSearchSchema,
  transcriptVersionsQuerySchema,
  type TranscriptVersionsQueryDto,
  transcriptVersionSummarySchema,
  transcriptVersionsSchema,
  transcriptVersionDetailSchema,
  restoreVersionSchema,
  type RestoreVersionDto,
} from '@marinoscar/kvox-contract/transcripts';

export class ApplyOperationsBodyDto extends createZodDto(applyOperationsSchema) {}

export class MergeUndoDto extends createZodDto(mergeUndoSchema) {}

export class OperationsResultDto extends createZodDto(operationsResultSchema) {}

export class OperationsConflictDto extends createZodDto(operationsConflictSchema) {}

export class TranscriptSearchQueryParamsDto extends createZodDto(transcriptSearchQuerySchema) {}

export class TranscriptSearchDto extends createZodDto(transcriptSearchSchema) {}

export class TranscriptVersionsQueryParamsDto extends createZodDto(
  transcriptVersionsQuerySchema,
) {}

export class TranscriptVersionSummaryDto extends createZodDto(transcriptVersionSummarySchema) {}

export class TranscriptVersionsDto extends createZodDto(transcriptVersionsSchema) {}

export class TranscriptVersionDetailDto extends createZodDto(transcriptVersionDetailSchema) {}

export class RestoreVersionBodyDto extends createZodDto(restoreVersionSchema) {}
