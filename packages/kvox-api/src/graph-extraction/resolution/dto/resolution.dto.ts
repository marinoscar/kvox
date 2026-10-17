import { createZodDto } from 'nestjs-zod';
import {
  mergeEntityBodySchema,
  mergeEntityResponseSchema,
  reverseMergeBodySchema,
  reverseMergeResponseSchema,
  distinctPairBodySchema,
  distinctPairResponseSchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/resolution.ts`); they are re-exported below so no importer changes.
export {
  mergeEntityBodySchema,
  type MergeEntityBody,
  mergeEntityResponseSchema,
  type MergeEntityResponse,
  reverseMergeBodySchema,
  reverseMergeResponseSchema,
  type ReverseMergeResponse,
  distinctPairBodySchema,
  type DistinctPairBody,
  distinctPairResponseSchema,
  type DistinctPairResponse,
} from '@marinoscar/kvox-contract/graph';

export class MergeEntityBodyDto extends createZodDto(mergeEntityBodySchema) {}
export class MergeEntityResponseDto extends createZodDto(mergeEntityResponseSchema) {}
export class ReverseMergeBodyDto extends createZodDto(reverseMergeBodySchema) {}
export class ReverseMergeResponseDto extends createZodDto(reverseMergeResponseSchema) {}
export class DistinctPairBodyDto extends createZodDto(distinctPairBodySchema) {}
export class DistinctPairResponseDto extends createZodDto(distinctPairResponseSchema) {}
