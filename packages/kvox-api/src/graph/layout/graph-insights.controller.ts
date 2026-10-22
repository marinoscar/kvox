import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import {
  GRAPH_INSIGHTS_WINDOWS,
  GraphInsightsResponseDto,
  graphInsightsQuerySchema,
  type GraphInsightsQuery,
  type GraphInsightsResponse,
} from './dto/graph-insights.dto.js';
import { GraphInsightsService } from './graph-insights.service.js';
import { KvoxAuth } from '../../core/index.js';
import { GRAPH_READ_PERMISSION } from '../graph.permissions.js';
import { CurrentGraphActor } from '../graph-actor.js';
import type { GraphActor } from '../graph-actor.js';
import { ApiDataResponse } from '../api-data-response.js';

// =============================================================================
// GraphInsightsController (GIC-16, #677, epic #661; docs/specs/ontology.md §22.3)
// =============================================================================
//
// `/api/graph/insights`: what deserves a look in the caller's own graph. Owner-scoped
// by construction (no id to 404 on); sensitive person facts never contribute.
// =============================================================================

@ApiTags('Graph')
@Controller('graph/insights')
export class GraphInsightsController {
  constructor(private readonly insights: GraphInsightsService) {}

  @Get()
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Get graph insights',
    description:
      'What deserves a look in your graph, in plain language:\n\n' +
      '- **themes** — the groups of your overview snapshot (the `kg.graph_layout` job), biggest first.\n' +
      '- **connectors** — entities that link otherwise separate groups, from the same snapshot ' +
      '(approximate betweenness, computed by the job, never by this request).\n' +
      '- **rising** — entities mentioned in at least 3 notes or recordings in the window and at least ' +
      '2x as many as in the window just before (meetings are left out).\n' +
      '- **fadingTies** — pairs of people or organizations linked by a current relation that had at ' +
      'least 3 pieces of evidence before the window and none in it.\n' +
      '- **openRisks** — Risk items with status `open`, highest severity first.\n\n' +
      'Themes and connectors carry `stale`/`pending` like `GET /api/graph/overview` and are never ' +
      'recomputed here. Windows end now and are 30, 90 or 365 days. Sensitive person facts are excluded. ' +
      'A window query over the 3 s budget answers 503 with `details.reason: "graph_query_timeout"`.\n\n' +
      'Requires `graph:read`; always your own graph.',
  })
  @ApiQuery({ name: 'window', required: false, enum: [...GRAPH_INSIGHTS_WINDOWS], description: 'Default 30d.' })
  @ApiDataResponse(GraphInsightsResponseDto, { description: 'Insights for the window' })
  async get(
    @CurrentGraphActor() user: GraphActor,
    @Query(new ZodValidationPipe(graphInsightsQuerySchema)) query: GraphInsightsQuery,
  ): Promise<GraphInsightsResponse> {
    return this.insights.insights(user.id, query.window);
  }
}
