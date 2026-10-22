// =============================================================================
// The Ask agent's tool providers (#377, epic #348; docs/specs/ontology.md §21)
// =============================================================================
//
// The eight read-only tool classes, listed once so `AskModule` provides them and the toolset
// spec can prove none of them depends on a write service. They import only READ surfaces,
// reached through the modules `AskModule.forRoot` imports:
//
//   - the graph slice: `GraphReadService`, `GraphNeighborhoodService`, `GraphEvidenceService`,
//     `EntityBriefService` (called with `markViewed: false, enqueueStaleDigest: false`),
//     `GraphOntologyService` and `GraphPreferencesService`;
//   - the search slice: `SearchService`, `search`'s document leg (§9.4), and the host's
//     transcript-visibility rule;
//   - `KVOX_PRISMA` for the tools' own owner-scoped reads.
//
// No tool is given a write service; `ask-toolset.spec.ts` asserts it.
// =============================================================================

import { EntityBriefTool } from './entity-brief.tool.js';
import { EvidenceTool } from './evidence.tool.js';
import { GetEntityTool } from './get-entity.tool.js';
import { ListCommitmentsTool } from './list-commitments.tool.js';
import { ListRisksTool } from './list-risks.tool.js';
import { NeighborsTool } from './neighbors.tool.js';
import { SearchTool } from './search.tool.js';
import { TimelineTool } from './timeline.tool.js';

/** The eight tool classes, in `ASK_TOOL_NAMES` order. */
export const ASK_TOOL_PROVIDERS = [
  SearchTool,
  GetEntityTool,
  NeighborsTool,
  TimelineTool,
  EvidenceTool,
  EntityBriefTool,
  ListCommitmentsTool,
  ListRisksTool,
] as const;
