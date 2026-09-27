import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
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
} from './dto/graph-export.dto';
import { GraphExportService, KG_EXPORT_TTL_DAYS } from './graph-export.service';

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

@ApiTags('Graph')
@Controller('graph/exports')
export class GraphExportController {
  constructor(private readonly exports: GraphExportService) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
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
  @ApiBody({ type: CreateGraphExportBodyDto })
  @ApiDataResponse(CreateGraphExportResponseDto, { status: 202, description: 'A render was queued' })
  @ApiResponse({ status: 200, description: 'An identical, unexpired export already existed (`reused: true`)' })
  @ApiResponse({ status: 409, description: '`details.reason: "graph_empty"` — nothing to export' })
  async create(
    @Body(new ZodValidationPipe(createGraphExportSchema)) dto: CreateGraphExportDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CreateGraphExportResponse> {
    const result = await this.exports.requestExport(user.id, dto.format);
    reply.status(result.reused ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return result;
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'List your graph exports',
    description:
      'Your unexpired exports, newest first (at most 20), each with its status and — once `ready` — a ' +
      'short-lived signed `downloadUrl`. Requires `graph:read`.',
  })
  @ApiDataResponse(GraphExportListDto, { description: 'Your exports' })
  async list(@CurrentUser() user: RequestUser): Promise<GraphExportList> {
    return this.exports.list(user.id);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'Get one graph export',
    description:
      'Status and stats of one of your exports. Once `ready`, `downloadUrl` is a **15-minute signed URL** ' +
      'serving the file as an attachment named `filename` (the `Content-Disposition` is signed into the ' +
      'URL). **404** for an export that is not yours, does not exist, or has expired. Requires `graph:read`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(KgExportDto, { description: 'The export' })
  @ApiResponse({ status: 404, description: 'No such export, expired, or not yours' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser): Promise<KgExportView> {
    return this.exports.get(user.id, id);
  }
}
