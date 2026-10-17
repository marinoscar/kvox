import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import {
  CreateGraphExportBodyDto,
  CreateGraphExportResponseDto,
  GraphExportListDto,
  KgExportDto,
  createGraphExportSchema,
  type CreateGraphExportDto,
  type CreateGraphExportResponse,
  type GraphExportList,
  type KgExportView,
} from './dto/graph-export.dto.js';
import { GraphExportService, KG_EXPORT_TTL_DAYS } from './graph-export.service.js';
import { KvoxAuth } from '../../core/index.js';
import { GRAPH_READ_PERMISSION, CurrentGraphActor, ApiDataResponse } from '../../graph/index.js';
import type { GraphActor } from '../../graph/index.js';

// =============================================================================
// GraphExportController (#386, epic #349; docs/specs/ontology.md §12, §18.2)
// =============================================================================
//
// `/api/graph/exports`: take your own graph out as JSON-LD, Turtle or N-Quads.
// All three routes are `graph:read` — reading one's own graph out is a read
// (§12) — and owner-scoped: a foreign export id is a 404, never a 403.
//
// Realized as POST + GET rather than the spec's first sketch,
// `GET /api/graph/export?format=`, because a GET that enqueues work is unsafe
// to prefetch.
// =============================================================================

const SENSITIVE_NOTE =
  '`sensitive` person facts and attribute values are **never** exported, under any setting — ' +
  'they are left out and counted in `stats.excludedSensitive`.';

/**
 * GraphExportController: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@ApiTags('Graph')
@Controller('graph/exports')
export class GraphExportController {
  constructor(private readonly exports: GraphExportService) {}

  @Post()
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Export your graph as RDF',
    description:
      'Queues a `kg.export` job that writes your whole graph — reviewed (`accepted`/`edited`) entities, ' +
      'relations and facts, superseded facts as history, and the citations behind each — as **JSON-LD**, ' +
      '**Turtle** or **N-Quads**, validating against `GET /api/graph/ontology.shacl.ttl`.\n\n' +
      `${SENSITIVE_NOTE}\n\n` +
      '- **202** `{ export, reused: false }` when a render was queued. Poll `GET /api/graph/exports/{id}`.\n' +
      '- **200** `{ export, reused: true }` when an unexpired export of the same, unchanged graph in this ' +
      'format already exists — any committed change to your graph produces a new export. A failed export is ' +
      'never reused.\n' +
      '- **409** `details.reason: "graph_empty"` when your graph has nothing readable to export.\n\n' +
      `An export and its file are deleted ${KG_EXPORT_TTL_DAYS} days after it was requested.\n\n` +
      'Requires `graph:read`.',
  })
  /**
   * Create.
   */
  @ApiBody({ type: CreateGraphExportBodyDto })
  @ApiDataResponse(CreateGraphExportResponseDto, { status: 202, description: 'A render was queued' })
  @ApiResponse({ status: 200, description: 'An identical, unexpired export already existed (`reused: true`)' })
  @ApiResponse({ status: 409, description: '`details.reason: "graph_empty"` — nothing to export' })
  async create(
    @Body(new ZodValidationPipe(createGraphExportSchema)) dto: CreateGraphExportDto,
    @CurrentGraphActor() user: GraphActor,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CreateGraphExportResponse> {
    const result = await this.exports.requestExport(user.id, dto.format);
    reply.status(result.reused ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return result;
  }

  @Get()
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'List your graph exports',
    description:
      'Your unexpired exports, newest first (at most 20), each with its status and — once `ready` — a ' +
      'short-lived signed `downloadUrl`. Requires `graph:read`.',
  })
  /**
   * List.
   */
  @ApiDataResponse(GraphExportListDto, { description: 'Your exports' })
  async list(@CurrentGraphActor() user: GraphActor): Promise<GraphExportList> {
    return this.exports.list(user.id);
  }

  @Get(':id')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Get one graph export',
    description:
      'Status and stats of one of your exports. Once `ready`, `downloadUrl` is a **15-minute signed URL** ' +
      'serving the file as an attachment named `filename` (the `Content-Disposition` is signed into the ' +
      'URL). **404** for an export that is not yours, does not exist, or has expired. Requires `graph:read`.',
  })
  /**
   * Get.
   */
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(KgExportDto, { description: 'The export' })
  @ApiResponse({ status: 404, description: 'No such export, expired, or not yours' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentGraphActor() user: GraphActor): Promise<KgExportView> {
    return this.exports.get(user.id, id);
  }
}
