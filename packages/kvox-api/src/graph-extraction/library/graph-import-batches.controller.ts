import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { retryExtractionsResponseSchema, type RetryExtractionsResponse } from '@marinoscar/kvox-contract/graph';

import { KvoxAuth } from '../../core/index.js';
import { ApiDataResponse, CurrentGraphActor, GRAPH_WRITE_PERMISSION, type GraphActor } from '../../graph/index.js';
import { ExtractionRetryService } from './extraction-retry.service.js';

class RetryExtractionsResponseDto extends createZodDto(retryExtractionsResponseSchema) {}

// =============================================================================
// GraphImportBatchesController (#716, epic #708)
// =============================================================================
// Owner-only: another user's batch answers the same 404 as a missing one.
// =============================================================================

/**
 * GraphImportBatchesController: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Graph')
@Controller('graph/import-batches')
export class GraphImportBatchesController {
  constructor(private readonly retries: ExtractionRetryService) {}

  @Post(':batchId/retry-extractions')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Retry the failed graph extractions of an import batch',
    description:
      'Queues graph extraction again for the notes of one of your import batches whose latest attempt at ' +
      'the current version failed, or that were never extracted. Runs at the low bulk priority on your own ' +
      'AI key. Nothing is queued for a note that is being extracted or already has a draft. Requires ' +
      '`graph:write`. **404**: no such batch, or not yours.',
  })
  @ApiDataResponse(RetryExtractionsResponseDto, { status: 202, description: 'How many notes were queued' })
  @ApiResponse({ status: 404, description: 'No such batch, or not yours' })
  async retryExtractions(
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<RetryExtractionsResponse> {
    return this.retries.retry(user, batchId);
  }
}
