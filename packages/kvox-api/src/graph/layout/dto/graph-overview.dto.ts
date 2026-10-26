import { createZodDto } from 'nestjs-zod';
import {
  graphOverviewResponseSchema,
  graphOverviewRefreshResponseSchema,
  graphOverviewQuerySchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/graph-overview.ts`); they are re-exported below so no importer changes.
export {
  OVERVIEW_MAX_NODES,
  OVERVIEW_MAX_EDGES,
  graphOverviewResponseSchema,
  type GraphOverviewResponse,
  graphOverviewRefreshResponseSchema,
  type GraphOverviewRefreshResponse,
  graphOverviewQuerySchema,
  type GraphOverviewQuery,
} from '@marinoscar/kvox-contract/graph';

export class GraphOverviewResponseDto extends createZodDto(graphOverviewResponseSchema) {}
export class GraphOverviewRefreshResponseDto extends createZodDto(graphOverviewRefreshResponseSchema) {}
export class GraphOverviewQueryDto extends createZodDto(graphOverviewQuerySchema) {}
