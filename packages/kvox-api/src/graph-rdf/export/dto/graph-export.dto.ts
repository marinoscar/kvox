import { createZodDto } from 'nestjs-zod';
import {
  createGraphExportSchema,
  kgExportSchema,
  createGraphExportResponseSchema,
  graphExportListSchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/graph-export.ts`); they are re-exported below so no importer changes.
export {
  KG_EXPORT_STATUSES,
  createGraphExportSchema,
  type CreateGraphExportDto,
  kgExportStatsSchema,
  kgExportSchema,
  type KgExportView,
  createGraphExportResponseSchema,
  type CreateGraphExportResponse,
  graphExportListSchema,
  type GraphExportList,
} from '@marinoscar/kvox-contract/graph';

export class CreateGraphExportBodyDto extends createZodDto(createGraphExportSchema) {}
export class KgExportDto extends createZodDto(kgExportSchema) {}
export class CreateGraphExportResponseDto extends createZodDto(createGraphExportResponseSchema) {}
export class GraphExportListDto extends createZodDto(graphExportListSchema) {}
