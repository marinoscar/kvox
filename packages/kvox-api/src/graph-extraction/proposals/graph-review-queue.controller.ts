import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe, createZodDto } from 'nestjs-zod';
import {
  commitBatchResponseSchema,
  commitBatchSchema,
  reviewQueueQuerySchema,
  reviewQueueResponseSchema,
  type CommitBatchDto,
  type CommitBatchResponse,
  type ReviewQueueQuery,
  type ReviewQueueResponse,
} from '@marinoscar/kvox-contract/graph';

import { ApiDataResponse, CurrentGraphActor, GRAPH_READ_PERMISSION, GRAPH_WRITE_PERMISSION, type GraphActor } from '../../graph/index.js';
import { KvoxAuth } from '../../core/index.js';
import { ProposalBatchCommitService } from './proposal-batch-commit.service.js';

class CommitBatchBodyDto extends createZodDto(commitBatchSchema) {}
class CommitBatchResponseDto extends createZodDto(commitBatchResponseSchema) {}
class ReviewQueueResponseDto extends createZodDto(reviewQueueResponseSchema) {}

// =============================================================================
// GraphReviewQueueController (#717, epic #708; ADR-0007)
// =============================================================================
// Owner-only: every query is scoped to the caller; another user's batch, library
// or proposal answers the same as a missing one.
// =============================================================================

/**
 * GraphReviewQueueController: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Graph')
@Controller('graph')
export class GraphReviewQueueController {
  constructor(private readonly batch: ProposalBatchCommitService) {}

  @Get('review-queue')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'List your open graph drafts across notes',
    description:
      'Your draft proposals grouped by library / import batch (`other` = notes imported on their own), ' +
      'with how many rows the safe policy would accept (`safe`) and how many wait for you. A stale ' +
      'proposal counts no safe rows. Capped at 500 proposals (`truncated`). Requires `graph:read`.',
  })
  @ApiDataResponse(ReviewQueueResponseDto, { description: 'The grouped queue' })
  async queue(
    @Query(new ZodValidationPipe(reviewQueueQuerySchema)) query: ReviewQueueQuery,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<ReviewQueueResponse> {
    return this.batch.reviewQueue(user, query.limit);
  }

  @Post('proposals/commit-batch')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Commit the safe rows of many drafts',
    description:
      'Exactly one of `batchId`, `libraryId`, `proposalIds` (max 500) and `policy: "safe"`. For each of ' +
      'your drafts in scope, in order: a stale one is skipped; the rows the safe policy accepts are ' +
      'accepted (never a sensitive person fact, a closing, an ambiguous or merge row, a row below ' +
      '`graph.review.minConfidence`); the proposal is committed on its own; rows left waiting move to a ' +
      'new draft (`remainderProposalId`). One proposal failing never stops the others. Requires `graph:write`. ' +
      '**404**: no such batch or library, or not yours.',
  })
  @ApiBody({ type: CommitBatchBodyDto })
  @ApiDataResponse(CommitBatchResponseDto, { description: 'One result per proposal' })
  @ApiResponse({ status: 400, description: 'Not exactly one selector, or another policy' })
  @ApiResponse({ status: 404, description: 'No such batch or library, or not yours' })
  async commitBatch(
    @Body(new ZodValidationPipe(commitBatchSchema)) body: CommitBatchDto,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<CommitBatchResponse> {
    return this.batch.commitBatch(user, body);
  }
}
