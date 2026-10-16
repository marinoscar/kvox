import { createZodDto } from 'nestjs-zod';
import { forgetEntitySchema, forgetEntityResponseSchema } from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/graph-forget.ts`); they are re-exported below so no importer changes.
export {
  FORGET_CONFIRMATION,
  FORGET_CONFIRMATION_MESSAGE,
  FORGET_NOT_PERSON_MESSAGE,
  forgetEntitySchema,
  type ForgetEntityDto,
  forgetEntityResponseSchema,
  type ForgetEntityResponse,
} from '@marinoscar/kvox-contract/graph';

export class ForgetEntityBodyDto extends createZodDto(forgetEntitySchema) {}
export class ForgetEntityResponseDto extends createZodDto(forgetEntityResponseSchema) {}
