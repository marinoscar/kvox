import { createZodDto } from 'nestjs-zod';
import { graphInsightsQuerySchema, graphInsightsResponseSchema } from '@marinoscar/kvox-contract/graph';

// The wire schemas live in `@marinoscar/kvox-contract/graph` (GIC-16, `graph/graph-insights.ts`).
export {
  GRAPH_INSIGHTS_WINDOWS,
  INSIGHTS_FADING_MIN_EVIDENCE,
  INSIGHTS_RISING_FACTOR,
  INSIGHTS_RISING_MIN_COUNT,
  graphInsightsQuerySchema,
  graphInsightsResponseSchema,
  type GraphInsightsQuery,
  type GraphInsightsResponse,
  type GraphInsightsWindow,
} from '@marinoscar/kvox-contract/graph';

export class GraphInsightsQueryDto extends createZodDto(graphInsightsQuerySchema) {}
export class GraphInsightsResponseDto extends createZodDto(graphInsightsResponseSchema) {}
