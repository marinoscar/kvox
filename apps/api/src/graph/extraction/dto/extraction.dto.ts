import { createZodDto } from 'nestjs-zod';
import {
  requestExtractionSchema,
  extractionEstimateSchema,
  requestExtractionResponseSchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/extraction.ts`); they are re-exported below so no importer changes.
export {
  userGuidanceSchema,
  type UserGuidance,
  requestExtractionSchema,
  type RequestExtractionDto,
  extractionEstimateSchema,
  type ExtractionEstimate,
  requestExtractionResponseSchema,
  type RequestExtractionResponse,
  extractionEstimateQuerySchema,
  type ExtractionEstimateQuery,
} from '@marinoscar/kvox-contract/graph';

export class RequestExtractionBodyDto extends createZodDto(requestExtractionSchema) {}
export class ExtractionEstimateDto extends createZodDto(extractionEstimateSchema) {}
export class RequestExtractionResponseDto extends createZodDto(requestExtractionResponseSchema) {}
