import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe, createZodDto } from 'nestjs-zod';
import {
  duplicatesScanResponseSchema,
  listDuplicatesQuerySchema,
  listDuplicatesResponseSchema,
  type DuplicatesScanResponse,
  type ListDuplicatesQuery,
  type ListDuplicatesResponse,
} from '@marinoscar/kvox-contract/graph';

import { DuplicatesService } from './duplicates.service.js';
import { KvoxAuth } from '../../core/index.js';
import { GRAPH_READ_PERMISSION, GRAPH_WRITE_PERMISSION, CurrentGraphActor, ApiDataResponse } from '../../graph/index.js';
import type { GraphActor } from '../../graph/index.js';

class ListDuplicatesResponseDto extends createZodDto(listDuplicatesResponseSchema) {}
class DuplicatesScanResponseDto extends createZodDto(duplicatesScanResponseSchema) {}

// =============================================================================
// GraphDuplicatesController (issue #766)
// =============================================================================
//
// "Possible duplicates": list likely-same entity pairs and queue the deeper
// re-scan. Both routes act only on the caller's own graph (no id in the path,
// so there is no other user's data to answer 404 for). Merging a pair is
// `POST /api/graph/entities/{id}/merge`; "not the same" is
// `POST /api/graph/distinct-pairs`.
// =============================================================================

/**
 * GraphDuplicatesController: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Graph')
@Controller('graph/duplicates')
export class GraphDuplicatesController {
  constructor(private readonly duplicates: DuplicatesService) {}

  @Get()
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'List possible duplicate entities',
    description:
      'Pairs of your own reviewed entities that probably are one thing, best first. Two sources: a fast ' +
      'name pass (one name inside the other, "OAC" for "Org Alpha Consulting", a shared name or alias, similar ' +
      'spelling), same type only, and the merges your open resolution proposals already suggest ' +
      '(`source: "resolution_proposal"`, with `proposalItemId`). Pairs you marked "not the same" are ' +
      'left out. Each pair names every signal that fired in `reasons`.\n\n' +
      'The name pass reads your 2 000 most recently updated entities and at most 200 similar-spelling ' +
      'pairs. Nothing is merged: use `POST /api/graph/entities/{id}/merge`.\n\n' +
      'Requires `graph:read`.',
  })
  @ApiQuery({ name: 'type', required: false, type: String, description: 'Only pairs of this entity type.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1 to 200, default 50.' })
  @ApiDataResponse(ListDuplicatesResponseDto, { description: 'The possible duplicates, best score first' })
  @ApiResponse({ status: 400, description: 'An invalid `type` or `limit`' })
  @ApiResponse({ status: 403, description: 'Missing `graph:read`' })
  async list(
    @Query(new ZodValidationPipe(listDuplicatesQuerySchema)) query: ListDuplicatesQuery,
    @CurrentGraphActor() user: GraphActor,
  ): Promise<ListDuplicatesResponse> {
    return this.duplicates.list(user, query);
  }

  @Post('scan')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Scan for possible duplicates',
    description:
      'Queues a `kg.resolve` re-scan of your whole graph (reason `manual`). It compares every entity ' +
      'with the rest by name, alias and meaning, and writes a **draft resolution proposal** of suggested ' +
      'merges to review; it never merges anything itself. It uses **your own** AI key for uncertain ' +
      'pairs, so it only runs when you ask. Asking while a scan is pending or running joins it ' +
      '(`alreadyRunning: true`, not an error).\n\n' +
      'Requires `graph:write`. **409** `details.reason: graph_disabled` when connected knowledge is off for this deployment.',
  })
  @ApiDataResponse(DuplicatesScanResponseDto, { status: 202, description: 'The queued (or joined) scan' })
  @ApiResponse({ status: 403, description: 'Missing `graph:write`' })
  @ApiResponse({ status: 409, description: '`graph_disabled`' })
  async scan(@CurrentGraphActor() user: GraphActor): Promise<DuplicatesScanResponse> {
    return this.duplicates.scan(user);
  }
}
