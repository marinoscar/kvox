import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import {
  AcceptAttributeOfferBodyDto,
  AttributeOfferResponseDto,
  CreateGraphImportResponseDto,
  acceptAttributeOfferSchema,
  type AcceptAttributeOfferDto,
  type AttributeOfferResponse,
  type CreateGraphImportResponse,
} from './dto/graph-import.dto';
import { GRAPH_IMPORT_MAX_BYTES } from './graph-import.constants';
import { GraphImportService } from './graph-import.service';

// =============================================================================
// GraphImportController (#387, epic #349; docs/specs/ontology.md §12, §18.3)
// =============================================================================
//
// `POST /api/graph/imports` — upload an RDF file; it becomes a `kind: import`
// proposal once `kg.import` has validated it against your SHACL shapes. Every
// route is `graph:write` (§12: importing curates your graph) and owner-only.
//
// Listing and reading imports reuse #366's routes unchanged —
// `GET /api/graph/proposals?kind=import` and `GET /api/graph/proposals/{id}` —
// with the import-specific facts in `proposal.stats`. The two attribute-offer
// routes are additive to that surface.
//
// The multipart read is bounded BEFORE anything is buffered (the
// `NoteSourcesController` rule): `req.file({ limits: { fileSize } })` with
// `throwFileSizeLimit` makes Fastify stop reading at 20 MiB and answer 413.
// =============================================================================

const NOT_FOUND = 'No such proposal or offer, or not yours (the same answer either way).';
const NOT_DRAFT = '`details.reason: "proposal_not_draft"` — the proposal has left `draft`; or `"offer_decided"` — the offer was already accepted or rejected.';

function toClientError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new PayloadTooLargeException(`An import may be at most ${GRAPH_IMPORT_MAX_BYTES} bytes.`);
  }
  if (typeof code === 'string' && code.startsWith('FST_')) {
    return new BadRequestException('Invalid multipart body. Send multipart/form-data with a single "file" field.');
  }
  return error;
}

@ApiTags('Graph')
@Controller('graph')
export class GraphImportController {
  constructor(private readonly imports: GraphImportService) {}

  @Post('imports')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @ApiOperation({
    summary: 'Import an RDF file into your graph, as a proposal',
    description:
      'Multipart upload with a single `file` part: **Turtle** (`.ttl`, `text/turtle`), **JSON-LD** ' +
      '(`.jsonld`/`.json`, `application/ld+json`) or **N-Quads** (`.nq`, `application/n-quads`) — the ' +
      'extension decides, then the declared type. At most 20 MiB and 200,000 triples.\n\n' +
      'Stores the file (`managed_by: graph`), creates a `kind: import` proposal in `extracting` and queues ' +
      '`kg.import`, which parses it, negotiates the ontology version (`owl:versionInfo`), offers every ' +
      'undeclared property as an attribute definition, validates the rest against **your** SHACL shapes ' +
      '(`GET /api/graph/ontology.shacl.ttl`) — **all or nothing**: one violation imports nothing — and turns ' +
      'what passes into ordinary proposal rows, resolved against your graph. Nothing enters the graph until ' +
      'you review and commit it (`POST /api/graph/proposals/{id}/commit`). Poll ' +
      '`GET /api/graph/proposals/{id}`; `stats` carries the validation report, the offers and the counts. ' +
      'JSON-LD remote contexts are never fetched. `sensitive` person facts are never imported in bulk.\n\n' +
      '- **202** `{ proposalId, jobId }`\n' +
      '- **400** no/empty file, invalid multipart body, or a format imports do not read\n' +
      '- **409** `details.reason: "graph_disabled"` (connected knowledge is off) or `"extraction_running"` ' +
      '(another import of yours is still being checked — one at a time)\n' +
      '- **413** over 20 MiB\n\nRequires `graph:write`.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiDataResponse(CreateGraphImportResponseDto, { status: 202, description: 'File stored and `kg.import` queued' })
  @ApiResponse({ status: 400, description: 'Missing or empty file, invalid multipart body, or an unreadable format' })
  @ApiResponse({ status: 409, description: '`graph_disabled` or `extraction_running`' })
  @ApiResponse({ status: 413, description: 'Over 20 MiB' })
  async upload(@Req() req: FastifyRequest, @CurrentUser() user: RequestUser): Promise<CreateGraphImportResponse> {
    if (!req.isMultipart()) throw new BadRequestException('Expected multipart/form-data with a single "file" field.');
    let filename: string;
    let mimeType: string;
    let body: Buffer;
    try {
      const part = await req.file({ limits: { fileSize: GRAPH_IMPORT_MAX_BYTES, files: 1 }, throwFileSizeLimit: true });
      if (!part) throw new BadRequestException('No file provided');
      if (part.fieldname !== 'file') throw new BadRequestException('The file must be sent in the "file" field.');
      filename = part.filename;
      mimeType = part.mimetype;
      body = await part.toBuffer();
    } catch (error) {
      throw toClientError(error);
    }
    return this.imports.upload(user, { filename, mimeType, body });
  }

  @Post('proposals/:id/attribute-offers/:offerId/accept')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @ApiOperation({
    summary: 'Accept an imported property as an attribute',
    description:
      'Creates the offered attribute definition — one per entity type the property appeared on, through the ' +
      'same rules as `POST /api/graph/attribute-defs` (kind from the values, `label` from the body, the file, ' +
      'or the IRI) — and moves the property’s values into the affected rows’ `props`, keyed by the new ' +
      'definition’s key. An `entity_ref` value keeps only when the row it names is linked to an existing ' +
      'entity. **404**: ' + NOT_FOUND + ' **409**: ' + NOT_DRAFT + ' Requires `graph:write`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'offerId', type: String })
  @ApiBody({ type: AcceptAttributeOfferBodyDto, required: false })
  @ApiDataResponse(AttributeOfferResponseDto, { description: 'The offer, now accepted, and the definitions created' })
  @ApiResponse({ status: 400, description: 'The property sits only on relations, or no carrying type is in your graph' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: NOT_DRAFT })
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('offerId') offerId: string,
    @Body(new ZodValidationPipe(acceptAttributeOfferSchema)) body: AcceptAttributeOfferDto | undefined,
    @CurrentUser() user: RequestUser,
  ): Promise<AttributeOfferResponse> {
    return this.imports.acceptOffer(user, id, offerId, body ?? {});
  }

  @Post('proposals/:id/attribute-offers/:offerId/reject')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @ApiOperation({
    summary: 'Reject an imported property',
    description:
      'Drops the property’s values — closed by default: it was never going to be kept silently. **404**: ' +
      NOT_FOUND + ' **409**: ' + NOT_DRAFT + ' Requires `graph:write`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'offerId', type: String })
  @ApiDataResponse(AttributeOfferResponseDto, { description: 'The offer, now rejected' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: NOT_DRAFT })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<AttributeOfferResponse> {
    return this.imports.rejectOffer(user, id, offerId);
  }
}
