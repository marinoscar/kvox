import { createZodDto } from 'nestjs-zod';
import {
  createManualRelationResponseSchema,
  createManualRelationSchema,
  removeManualRelationResponseSchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas live in `@marinoscar/kvox-contract/graph` (`graph/graph-relation-edit.ts`, #586).
export {
  MANUAL_RELATION_TYPES,
  createManualRelationSchema,
  createManualRelationResponseSchema,
  removeManualRelationResponseSchema,
  type CreateManualRelationDto,
  type CreateManualRelationResponse,
  type ManualRelation,
  type ManualRelationType,
  type RemoveManualRelationResponse,
} from '@marinoscar/kvox-contract/graph';

export class CreateManualRelationBodyDto extends createZodDto(createManualRelationSchema) {}
export class CreateManualRelationResponseDto extends createZodDto(createManualRelationResponseSchema) {}
export class RemoveManualRelationResponseDto extends createZodDto(removeManualRelationResponseSchema) {}
