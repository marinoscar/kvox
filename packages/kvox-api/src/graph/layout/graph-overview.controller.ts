import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import {
  GraphOverviewRefreshResponseDto,
  GraphOverviewResponseDto,
  graphOverviewQuerySchema,
  type GraphOverviewQuery,
  OVERVIEW_MAX_NODES,
  OVERVIEW_MAX_EDGES,
  type GraphOverviewRefreshResponse,
  type GraphOverviewResponse,
} from './dto/graph-overview.dto.js';
import { GraphOverviewService } from './graph-overview.service.js';
import { KvoxAuth, KvoxTimeZoneService, TimeZoneHeader } from '../../core/index.js';
import { GRAPH_READ_PERMISSION, GRAPH_WRITE_PERMISSION } from '../graph.permissions.js';
import { CurrentGraphActor } from '../graph-actor.js';
import type { GraphActor } from '../graph-actor.js';
import { ApiDataResponse } from '../api-data-response.js';

// =============================================================================
// GraphOverviewController (#371, epic #347; docs/specs/ontology.md §12, §22.3)
// =============================================================================
//
// `/api/graph/overview`: the whole-graph picture from a precomputed snapshot,
// and a manual refresh. Owner-scoped by construction — both routes act only on
// the caller's own graph, so there is no id to 404 on.
// =============================================================================

@ApiTags('Graph')
@Controller('graph/overview')
export class GraphOverviewController {
  constructor(
    private readonly overviews: GraphOverviewService,
    private readonly zones: KvoxTimeZoneService,
  ) {}

  @Get()
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Get the whole-graph overview',
    description:
      'Your whole graph at once — clusters and 2D positions — read from the latest snapshot the ' +
      '`kg.graph_layout` job computed. **This request never recomputes the layout.**\n\n' +
      '- **`status: "none"`**: no snapshot yet. If your graph has entities and no layout job is ' +
      'queued, one is queued now (`pending: true`) — the only case this request queues anything.\n' +
      '- **`stale: true`**: your graph changed after the snapshot was computed. It is reported, ' +
      'never refreshed automatically — use `POST /api/graph/overview/refresh`.\n' +
      '- **Labels are read live.** An entity merged, forgotten or deleted since the snapshot is ' +
      "dropped from `nodes` and `memberSample`, and a cluster named after one falls back to " +
      '`Cluster <n>` (`Unconnected` for cluster `-1`, which pools every isolated entity).\n' +
      `- **\`nodes\`** carries at most ${OVERVIEW_MAX_NODES} entities, highest degree first; ` +
      '`nodesTruncated` says whether more matched.\n' +
      '- **Filters** (all optional, applied to the snapshot, positions unchanged): `types` keeps those entity ' +
      'types (comma-separated; item kinds are accepted but have no nodes here); `from`/`to` keep entities with ' +
      'evidence dated in the window (a transcript\'s `recorded_at` or a note\'s `created_at`, else the ' +
      'citation time; evidence on a relation or item counts for the entities it links). ' +
      '`typeCounts` is time-filtered but not type-filtered.\n' +
      `- **\`edges=true\`** adds \`edges\` (\`{id, source, target, type}\`, one per live relation valid now with ` +
      `both ends in \`nodes\`; strongest, then newest first; at most ${OVERVIEW_MAX_EDGES}, \`edgesTruncated\`). ` +
      'Omitted otherwise.\n\n' +
      'Requires `graph:read`. Always 200 for your own graph.',
  })
  @ApiQuery({ name: 'types', required: false, type: String, description: 'Comma-separated entity types / item kinds; absent = all' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD or ISO 8601 with offset' })
  @ApiQuery({ name: 'edges', required: false, enum: ['true', 'false'], description: 'true adds edges among the returned nodes' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD or ISO 8601 with offset' })
  @ApiDataResponse(GraphOverviewResponseDto, { description: 'The latest snapshot, or `status: "none"`' })
  @ApiResponse({ status: 400, description: 'Unknown type, or an invalid date' })
  async overview(
    @CurrentGraphActor() user: GraphActor,
    @Query(new ZodValidationPipe(graphOverviewQuerySchema)) query: GraphOverviewQuery,
    @TimeZoneHeader() timeZoneHeader?: string,
  ): Promise<GraphOverviewResponse> {
    // `from`/`to` bound evidence instants: a bare day is local midnight in the requester's zone.
    const timeZone = query.from || query.to ? await this.zones.forRequest(user.id, timeZoneHeader) : undefined;
    return this.overviews.overview(user.id, query, timeZone);
  }

  @Post('refresh')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Recompute the whole-graph overview',
    description:
      'Queues a `kg.graph_layout` job that recomputes your overview snapshot now. At most one ' +
      'layout job per user is ever queued: asking again while one is pending or running returns ' +
      'that job with `deduplicated: true` (and an automatic one still waiting to start is ' +
      'started now). Never a 409.\n\n' +
      'Requires `graph:write`.',
  })
  @ApiDataResponse(GraphOverviewRefreshResponseDto, {
    status: 202,
    description: 'The queued (or already queued) layout job',
  })
  async refresh(@CurrentGraphActor() user: GraphActor): Promise<GraphOverviewRefreshResponse> {
    return this.overviews.refresh(user.id);
  }
}
