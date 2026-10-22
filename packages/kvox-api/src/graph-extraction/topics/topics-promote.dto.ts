import { createZodDto } from 'nestjs-zod';
import { topicsPromoteRequestResponseSchema, topicsPromoteStatusSchema } from '@marinoscar/kvox-contract/graph';

// The wire schemas live in `@marinoscar/kvox-contract/graph` (file `graph/topics-promote.ts`).
export {
  topicsPromoteRequestResponseSchema,
  topicsPromoteStatusSchema,
  type TopicsPromoteRequestResponse,
  type TopicsPromoteStatus,
} from '@marinoscar/kvox-contract/graph';

export class TopicsPromoteRequestResponseDto extends createZodDto(topicsPromoteRequestResponseSchema) {}
export class TopicsPromoteStatusDto extends createZodDto(topicsPromoteStatusSchema) {}
