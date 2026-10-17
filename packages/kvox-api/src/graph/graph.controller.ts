import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { EffectiveSchemaPayload } from '@marinoscar/kvox-contract/ontology';

import { GraphOntologyDto } from './dto/graph-ontology.dto.js';
import { GraphOntologyService } from './ontology/graph-ontology.service.js';
import { KvoxAuth } from '../core/index.js';
import { GRAPH_READ_PERMISSION } from './graph.permissions.js';
import { CurrentGraphActor } from './graph-actor.js';
import type { GraphActor } from './graph-actor.js';
import { ApiDataResponse } from './api-data-response.js';

// =============================================================================
// GraphController (#354, epic #344, docs/specs/ontology.md §12, §17.4)
// =============================================================================
//
// `/api/graph`. PER-ROUTE `@Auth`, no class-level guard, matching
// `NotesController` and `TranscriptsController`.
//
// Today one route: the caller's effective ontology, which every graph form in
// the web app is generated from. Later issues (#355, #370) add entity, relation,
// fact and search routes here; every one of them authorises a row through
// `GraphAccessService.require` before touching it — no access is always a 404,
// never a 403.
// =============================================================================

@ApiTags('Graph')
@Controller('graph')
export class GraphController {
  constructor(private readonly ontology: GraphOntologyService) {}

  @Get('ontology')
  @KvoxAuth(GRAPH_READ_PERMISSION)
  @ApiOperation({
    summary: 'Your effective ontology',
    description:
      'The schema **your** knowledge graph is made of: the `core` domain, every domain you ' +
      'have enabled (`work` by default), the attributes those domains mix into each other\'s ' +
      'types, and your own attribute definitions — deprecated ones included, flagged with ' +
      '`deprecated: true` so existing values stay readable. Every graph form is generated ' +
      'from this response rather than from a list of types compiled into the client.\n\n' +
      'Gated on `graph:read`, seeded to every role including Viewer. Deliberately **not** ' +
      'gated on the deployment\'s AI switch: reading your own schema is not an AI call, and ' +
      'turning AI off must never make an already-curated graph unreadable.',
  })
  @ApiDataResponse(GraphOntologyDto, { description: 'Your effective ontology' })
  async getOntology(@CurrentGraphActor() user: GraphActor): Promise<EffectiveSchemaPayload> {
    return this.ontology.payloadFor(user.id);
  }
}
