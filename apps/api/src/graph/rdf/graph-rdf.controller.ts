import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { matchesETag } from '../../transcripts/transcripts.controller';
import { GraphRdfService, type RdfArtefact } from './graph-rdf.service';

// =============================================================================
// GraphRdfController (issue #385, docs/specs/ontology.md §18.2)
// =============================================================================
//
// `GET /api/graph/ontology.ttl` (OWL/RDFS) and `GET /api/graph/ontology.shacl.ttl`
// (SHACL shapes): the vocabulary and the constraints graph data satisfies,
// generated from the ontology definition file plus the caller's own attribute
// definitions. Vocabulary only — never row data.
//
// RAW TURTLE, NOT THE `{ data }` ENVELOPE. The body is a Turtle document an RDF
// tool reads directly, so the handler writes the reply itself (`@Res()`),
// which is the documented way past the global `TransformInterceptor`
// (`openapi/data-envelope.ts` skips schemaless-JSON responses likewise).
//
// CONDITIONAL. Weak ETag over the ontology version and the caller's attribute
// definitions (`graph-rdf.service.ts`); a matching `If-None-Match` is a 304
// with no body, decided before anything is generated.
// =============================================================================

const TURTLE = 'text/turtle; charset=utf-8';

const CONDITIONAL_NOTE =
  '\n\nCarries a **weak ETag** over the ontology version and your attribute definitions; ' +
  'a request whose `If-None-Match` matches is answered `304` with no body. ' +
  '`Cache-Control: private, max-age=0, must-revalidate`. Gated on `graph:read`, seeded to every role.';

@ApiTags('Graph')
@Controller('graph')
export class GraphRdfController {
  constructor(private readonly rdf: GraphRdfService) {}

  @Get('ontology.ttl')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'The ontology as OWL/RDFS (Turtle)',
    description:
      'The knowledge-graph vocabulary as OWL/RDFS, generated from the ontology definition file — ' +
      'never hand-maintained — over **every** domain, so it describes every row that can exist. ' +
      '`owl:versionInfo` is the ontology version. Types, attributes and relations are aligned to ' +
      'Schema.org/PROV-O with `rdfs:subClassOf`/`rdfs:subPropertyOf`; your own attribute ' +
      'definitions appear as `kv:attr/<definition id>` (deprecated ones flagged ' +
      '`owl:deprecated`, `sensitive` ones never). `IDENTIFIED_AS`, `MENTIONS` and `SUPPORTED_BY` ' +
      'are not properties: speakers are not exported, mentions are coarse, and evidence is ' +
      '`prov:wasDerivedFrom`.' +
      CONDITIONAL_NOTE,
  })
  @ApiResponse({
    status: 200,
    description: 'The OWL/RDFS vocabulary',
    content: { 'text/turtle': { schema: { type: 'string' } } },
  })
  @ApiResponse({ status: 304, description: 'Unchanged since the `If-None-Match` ETag' })
  async getOntologyTurtle(
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<FastifyReply> {
    return this.send('owl', user, request, reply);
  }

  @Get('ontology.shacl.ttl')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'The ontology as SHACL shapes (Turtle)',
    description:
      'The constraints graph data satisfies, as SHACL, generated from the same definition file as ' +
      '`ontology.ttl`: one closed `sh:NodeShape` per type (`sh:closed true` — an undeclared ' +
      'property is a violation), `required` → `sh:minCount 1`, selects → `sh:in`, relation ' +
      'endpoints → `sh:class`, URLs → `sh:pattern`, at least one `prov:wasDerivedFrom` on every ' +
      'node (no orphans), a `kv:AssertionShape` for reified temporal edges, and your own ' +
      'attribute definitions on their type (`sensitive` ones omitted — they are never exported).' +
      CONDITIONAL_NOTE,
  })
  @ApiResponse({
    status: 200,
    description: 'The SHACL shapes',
    content: { 'text/turtle': { schema: { type: 'string' } } },
  })
  @ApiResponse({ status: 304, description: 'Unchanged since the `If-None-Match` ETag' })
  async getShaclTurtle(
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<FastifyReply> {
    return this.send('shacl', user, request, reply);
  }

  private async send(
    artefact: RdfArtefact,
    user: RequestUser,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const prepared = await this.rdf.prepare(user.id, artefact);
    reply.header('ETag', prepared.etag);
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');

    if (matchesETag(request.headers['if-none-match'], prepared.etag)) {
      return reply.status(HttpStatus.NOT_MODIFIED).send();
    }

    return reply.status(HttpStatus.OK).header('Content-Type', TURTLE).send(prepared.body());
  }
}
