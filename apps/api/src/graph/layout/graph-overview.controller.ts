import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  GraphOverviewRefreshResponseDto,
  GraphOverviewResponseDto,
  OVERVIEW_MAX_NODES,
  type GraphOverviewRefreshResponse,
  type GraphOverviewResponse,
} from './dto/graph-overview.dto';
import { GraphOverviewService } from './graph-overview.service';

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
  constructor(private readonly overviews: GraphOverviewService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
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
      '`nodesTruncated` says whether more were positioned.\n\n' +
      'Requires `graph:read`. Always 200 for your own graph.',
  })
  @ApiDataResponse(GraphOverviewResponseDto, { description: 'The latest snapshot, or `status: "none"`' })
  async overview(@CurrentUser() user: RequestUser): Promise<GraphOverviewResponse> {
    return this.overviews.overview(user.id);
  }

  @Post('refresh')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
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
  async refresh(@CurrentUser() user: RequestUser): Promise<GraphOverviewRefreshResponse> {
    return this.overviews.refresh(user.id);
  }
}
