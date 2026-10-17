import { createZodDto } from 'nestjs-zod';
import {
  proposalDetailSchema,
  proposalListResponseSchema,
  noteProposalResponseSchema,
  patchItemSchema,
  itemDecisionResponseSchema,
  bulkDecisionSchema,
  bulkDecisionResponseSchema,
  addItemSchema,
  emptyBodySchema,
  commitResponseSchema,
  proposalResponseSchema,
  revertBodySchema,
  revertResponseSchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/proposal.ts`); they are re-exported below so no importer changes.
export {
  proposalStatusSchema,
  type ProposalStatus,
  proposalKindSchema,
  decisionSchema,
  type ProposalDecision,
  GROUP_KEYS,
  groupKeySchema,
  type GroupKey,
  proposalCountsSchema,
  type ProposalCounts,
  proposalSummarySchema,
  type ProposalSummary,
  evidenceViewSchema,
  type EvidenceView,
  PROPOSAL_ITEM_KINDS,
  type ProposalItemKind,
  proposalItemViewSchema,
  type ProposalItemView,
  proposalDetailSchema,
  type ProposalDetail,
  listProposalsQuerySchema,
  type ListProposalsQuery,
  getProposalQuerySchema,
  type GetProposalQuery,
  proposalListResponseSchema,
  type ProposalListResponse,
  noteProposalResponseSchema,
  type NoteProposalResponse,
  endpointTargetSchema,
  type EndpointTarget,
  evidenceSpanInputSchema,
  type EvidenceSpanInput,
  RELINK_FIELDS,
  type RelinkField,
  patchItemSchema,
  type PatchItemDto,
  itemDecisionResponseSchema,
  type ItemDecisionResponse,
  bulkDecisionSchema,
  type BulkDecisionDto,
  BULK_SKIP_REASONS,
  type BulkSkipReason,
  bulkDecisionResponseSchema,
  type BulkDecisionResponse,
  addItemSchema,
  type AddItemDto,
  emptyBodySchema,
  commitResultSchema,
  type CommitResult,
  commitResponseSchema,
  type CommitResponse,
  proposalResponseSchema,
  type ProposalResponse,
  revertBodySchema,
  type RevertBody,
  REVERT_KEPT_KINDS,
  REVERT_KEPT_WHY,
  revertKeptSchema,
  type RevertKept,
  revertResultSchema,
  type RevertResult,
  revertResponseSchema,
  type RevertResponse,
  PROPOSAL_BAD_REQUEST_REASONS,
  COMMIT_ISSUE_CODES,
} from '@marinoscar/kvox-contract/graph';

export class ProposalDetailDto extends createZodDto(proposalDetailSchema) {}
export class ProposalListResponseDto extends createZodDto(proposalListResponseSchema) {}
export class NoteProposalResponseDto extends createZodDto(noteProposalResponseSchema) {}
export class PatchItemBodyDto extends createZodDto(patchItemSchema) {}
export class ItemDecisionResponseDto extends createZodDto(itemDecisionResponseSchema) {}
export class BulkDecisionBodyDto extends createZodDto(bulkDecisionSchema) {}
export class BulkDecisionResponseDto extends createZodDto(bulkDecisionResponseSchema) {}
export class AddItemBodyDto extends createZodDto(addItemSchema) {}
export class EmptyProposalBodyDto extends createZodDto(emptyBodySchema) {}
export class CommitResponseDto extends createZodDto(commitResponseSchema) {}
export class ProposalResponseDto extends createZodDto(proposalResponseSchema) {}
export class RevertBodyDto extends createZodDto(revertBodySchema) {}
export class RevertResponseDto extends createZodDto(revertResponseSchema) {}
