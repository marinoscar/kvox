import { createZodDto } from 'nestjs-zod';
import {
  createNameCheckSchema,
  nameCheckEstimateQuerySchema,
  nameCheckEstimateSchema,
  nameCheckRunSchema,
  createNameCheckResponseSchema,
  nameSuggestionSchema,
  latestNameCheckSchema,
  nameCheckDecisionSchema,
  applyNameSuggestionsResultSchema,
  rejectNameSuggestionsResultSchema,
} from '@marinoscar/kvox-contract/transcripts';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/transcripts` (issue #488, file `transcripts/transcript-name-check.ts`); they are re-exported below so no importer changes.
export {
  MAX_NAME_CHECK_TERMS,
  MAX_NAME_CHECK_TERM_LENGTH,
  MAX_NAME_CHECK_DECISIONS,
  NAME_CHECK_CONFLICT_REASONS,
  NAME_CHECK_MODES,
  createNameCheckSchema,
  type CreateNameCheckDto,
  nameCheckEstimateQuerySchema,
  type NameCheckEstimateQueryDto,
  nameCheckEstimateSchema,
  nameCheckRunSchema,
  createNameCheckResponseSchema,
  nameSuggestionSchema,
  nameSuggestionCountsSchema,
  latestNameCheckSchema,
  nameCheckDecisionSchema,
  type NameCheckDecisionDto,
  applyNameSuggestionsResultSchema,
  rejectNameSuggestionsResultSchema,
} from '@marinoscar/kvox-contract/transcripts';

export class CreateNameCheckBodyDto extends createZodDto(createNameCheckSchema) {}

export class NameCheckEstimateQueryParamsDto extends createZodDto(nameCheckEstimateQuerySchema) {}

export class NameCheckEstimateDto extends createZodDto(nameCheckEstimateSchema) {}

export class NameCheckRunDto extends createZodDto(nameCheckRunSchema) {}

export class CreateNameCheckResponseDto extends createZodDto(createNameCheckResponseSchema) {}

export class NameSuggestionDto extends createZodDto(nameSuggestionSchema) {}

export class LatestNameCheckDto extends createZodDto(latestNameCheckSchema) {}

export class NameCheckDecisionBodyDto extends createZodDto(nameCheckDecisionSchema) {}

export class ApplyNameSuggestionsResultDto extends createZodDto(applyNameSuggestionsResultSchema) {}

export class RejectNameSuggestionsResultDto extends createZodDto(rejectNameSuggestionsResultSchema) {}
