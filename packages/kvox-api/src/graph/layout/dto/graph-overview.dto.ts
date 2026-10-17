import { createZodDto } from 'nestjs-zod';
import {
  graphOverviewResponseSchema,
  graphOverviewRefreshResponseSchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/graph-overview.ts`); they are re-exported below so no importer changes.
export {
  OVERVIEW_MAX_NODES,
  graphOverviewResponseSchema,
  type GraphOverviewResponse,
  graphOverviewRefreshResponseSchema,
  type GraphOverviewRefreshResponse,
} from '@marinoscar/kvox-contract/graph';

export class GraphOverviewResponseDto extends createZodDto(graphOverviewResponseSchema) {}
export class GraphOverviewRefreshResponseDto extends createZodDto(graphOverviewRefreshResponseSchema) {}
