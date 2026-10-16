import { createZodDto } from 'nestjs-zod';
import {
  askCitationSchema,
  askToolCallSchema,
  askMessageSchema,
  askConversationSummarySchema,
  listAskConversationsQuerySchema,
  listAskConversationsResponseSchema,
  askConversationDetailSchema,
  getAskConversationQuerySchema,
  createAskConversationSchema,
  renameAskConversationSchema,
} from '@marinoscar/kvox-contract/ask';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/ask` (issue #488, file `ask/ask.ts`); they are re-exported below so no importer changes.
export {
  ASK_CONTENT_MAX_CHARS,
  ASK_TITLE_MAX_CHARS,
  ASK_ERROR_CLASSES,
  ASK_CONFLICT_REASONS,
  ASK_FINISH_REASONS,
  ASK_DETAIL_MESSAGE_LIMIT,
  ASK_PREVIEW_MAX_CHARS,
  askCitationSchema,
  type AskCitation,
  askToolCallSchema,
  type AskToolCall,
  askMessageSchema,
  type AskMessageResponse,
  askConversationSummarySchema,
  type AskConversationSummary,
  listAskConversationsQuerySchema,
  type ListAskConversationsQuery,
  listAskConversationsResponseSchema,
  type ListAskConversationsResponse,
  askConversationDetailSchema,
  type AskConversationDetail,
  getAskConversationQuerySchema,
  type GetAskConversationQuery,
  createAskConversationSchema,
  type CreateAskConversation,
  renameAskConversationSchema,
  type RenameAskConversation,
} from '@marinoscar/kvox-contract/ask';

export class AskCitationDto extends createZodDto(askCitationSchema) {}
export class AskToolCallDto extends createZodDto(askToolCallSchema) {}
export class AskMessageDto extends createZodDto(askMessageSchema) {}
export class AskConversationSummaryDto extends createZodDto(askConversationSummarySchema) {}
export class ListAskConversationsQueryDto extends createZodDto(listAskConversationsQuerySchema) {}
export class ListAskConversationsResponseDto extends createZodDto(listAskConversationsResponseSchema) {}
export class AskConversationDetailDto extends createZodDto(askConversationDetailSchema) {}
export class GetAskConversationQueryDto extends createZodDto(getAskConversationQuerySchema) {}
export class CreateAskConversationDto extends createZodDto(createAskConversationSchema) {}
export class RenameAskConversationDto extends createZodDto(renameAskConversationSchema) {}
