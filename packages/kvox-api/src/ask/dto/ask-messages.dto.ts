import { createZodDto } from 'nestjs-zod';
import { postAskMessageSchema, postAskMessageResponseSchema } from '@marinoscar/kvox-contract/ask';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/ask` (issue #488, file `ask/ask-messages.ts`); they are re-exported below so no importer changes.
export {
  postAskMessageSchema,
  type PostAskMessage,
  postAskMessageResponseSchema,
  type PostAskMessageResponse,
} from '@marinoscar/kvox-contract/ask';

export class PostAskMessageDto extends createZodDto(postAskMessageSchema) {}
export class PostAskMessageResponseDto extends createZodDto(postAskMessageResponseSchema) {}
