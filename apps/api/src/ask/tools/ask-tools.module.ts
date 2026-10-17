// =============================================================================
// AskToolsModule (#377, epic #348; docs/specs/ontology.md §21)
// =============================================================================
//
// The Ask agent's read-only toolset, as its own module so the conversation
// module (#376's `AskModule`) and the chat loop (#378) import it rather than
// re-providing seven tools. It imports only READ surfaces:
//
//   - `GraphConfig` (`@marinoscar/kvox-api/graph`) for `GraphReadService`, `GraphNeighborhoodService`,
//     `GraphEvidenceService`, `EntityBriefService` (called with
//     `markViewed: false, enqueueStaleDigest: false`), `GraphOntologyService`
//     and `GraphPreferencesService`;
//   - `SearchModule` for `SearchService` — `search`'s document leg (§9.4);
//   - `PrismaModule` for the tools' own owner-scoped reads.
//
// No tool is given a write service; `ask-toolset.spec.ts` asserts it.
// =============================================================================

import { Module } from '@nestjs/common';

import { GraphConfig } from '../../kvox/graph/graph.config';
import { PrismaModule } from '../../prisma/prisma.module';
import { SearchConfig } from '../../kvox/search/search.config';
import { AskToolset } from './ask-toolset';
import { EntityBriefTool } from './entity-brief.tool';
import { EvidenceTool } from './evidence.tool';
import { GetEntityTool } from './get-entity.tool';
import { ListCommitmentsTool } from './list-commitments.tool';
import { NeighborsTool } from './neighbors.tool';
import { SearchTool } from './search.tool';
import { TimelineTool } from './timeline.tool';

/** The seven tool classes, in `ASK_TOOL_NAMES` order. */
export const ASK_TOOL_PROVIDERS = [
  SearchTool,
  GetEntityTool,
  NeighborsTool,
  TimelineTool,
  EvidenceTool,
  EntityBriefTool,
  ListCommitmentsTool,
] as const;

@Module({
  imports: [PrismaModule, GraphConfig, SearchConfig],
  providers: [...ASK_TOOL_PROVIDERS, AskToolset],
  exports: [AskToolset],
})
export class AskToolsModule {}
