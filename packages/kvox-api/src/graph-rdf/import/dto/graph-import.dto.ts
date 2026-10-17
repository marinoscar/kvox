import { createZodDto } from 'nestjs-zod';
import {
  createGraphImportResponseSchema,
  acceptAttributeOfferSchema,
  attributeOfferResponseSchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/graph-import.ts`); they are re-exported below so no importer changes.
export {
  GRAPH_IMPORT_FORMATS,
  type GraphImportFormat,
  GRAPH_IMPORT_FAILURE_REASONS,
  type GraphImportFailureReason,
  GRAPH_IMPORT_OFFER_STATUSES,
  type GraphImportOfferStatus,
  GRAPH_IMPORT_MAX_VIOLATIONS,
  graphImportViolationSchema,
  type GraphImportViolation,
  graphImportOfferSchema,
  type GraphImportOffer,
  graphImportStatsSchema,
  type GraphImportStats,
  createGraphImportResponseSchema,
  type CreateGraphImportResponse,
  acceptAttributeOfferSchema,
  type AcceptAttributeOfferDto,
  attributeOfferResponseSchema,
  type AttributeOfferResponse,
} from '@marinoscar/kvox-contract/graph';

export class CreateGraphImportResponseDto extends createZodDto(createGraphImportResponseSchema) {}
export class AcceptAttributeOfferBodyDto extends createZodDto(acceptAttributeOfferSchema) {}
export class AttributeOfferResponseDto extends createZodDto(attributeOfferResponseSchema) {}
