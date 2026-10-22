import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  TopicsPromoteRequestResponseDto,
  TopicsPromoteStatusDto,
  type TopicsPromoteRequestResponse,
  type TopicsPromoteStatus,
} from './topics-promote.dto.js';
import { TopicsPromoteService } from './topics-promote.service.js';
import { KvoxAuth } from '../../core/index.js';
import { GRAPH_WRITE_PERMISSION, CurrentGraphActor, ApiDataResponse } from '../../graph/index.js';
import type { GraphActor } from '../../graph/index.js';

// =============================================================================
// GraphTopicsPromoteController (#666, epic #661; docs/specs/ontology.md §11)
// =============================================================================
//
// "Find topics in past meetings": queue `kg.topics_promote` and read its state.
// Both routes are `graph:write` and act only on the caller's own meetings: no id
// in the path, so there is no other user's data to answer 404 for.
// =============================================================================

/**
 * GraphTopicsPromoteController: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Graph')
@Controller('graph/topics')
export class GraphTopicsPromoteController {
  constructor(private readonly topics: TopicsPromoteService) {}

  @Post('promote')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Find topics in past meetings',
    description:
      'Queues a `kg.topics_promote` job that reads the topics listed on your past meetings, matches ' +
      'each against the Topics already in your graph (so "licence costs" lands on "licensing cost"), ' +
      'and writes **draft proposals** to review at `/graph/review`: one per Topic, holding the Topic ' +
      'and a "Meeting discussed Topic" row for each meeting, each citing the meeting\'s own source. ' +
      'Nothing is added to your graph until you commit a proposal. Running it again proposes nothing ' +
      'that is already proposed or in your graph.\n\n' +
      'It uses **your own** AI key (matching and, for uncertain matches, a small request each), so it ' +
      'only ever runs when you ask. Asking while a run is pending or running joins that run ' +
      '(`deduplicated: true`).\n\n' +
      'Requires `graph:write`. **409** `details.reason: graph_disabled` when connected knowledge is ' +
      'off for this deployment.',
  })
  @ApiDataResponse(TopicsPromoteRequestResponseDto, { status: 202, description: 'The queued (or joined) run' })
  /**
   * Request.
   */
  @ApiResponse({ status: 403, description: 'Missing `graph:write`' })
  @ApiResponse({ status: 409, description: '`graph_disabled`' })
  async request(@CurrentGraphActor() user: GraphActor): Promise<TopicsPromoteRequestResponse> {
    return this.topics.request(user);
  }

  @Get('promote')
  @KvoxAuth(GRAPH_WRITE_PERMISSION)
  @ApiOperation({
    summary: 'Where the topics search stands',
    description:
      'Your latest "Find topics in past meetings" run (`pending`, `running`, `succeeded`, `failed`, or ' +
      '`null` when you never ran it) and `proposedTopics`: the topic proposals from past meetings ' +
      'waiting for your review. The count grows while a run is working.\n\n' +
      'Requires `graph:write`.',
  })
  @ApiDataResponse(TopicsPromoteStatusDto, { description: 'The latest run and the proposals waiting' })
  /**
   * Status.
   */
  @ApiResponse({ status: 403, description: 'Missing `graph:write`' })
  async status(@CurrentGraphActor() user: GraphActor): Promise<TopicsPromoteStatus> {
    return this.topics.status(user);
  }
}
