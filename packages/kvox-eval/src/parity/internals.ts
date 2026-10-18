// =============================================================================
// The slices' internals the parity scenario runs (issue #580)
// =============================================================================
//
// Same rule as `kg/internals.ts`: the one place this slice names a function that
// `@marinoscar/kvox-api` keeps internal (tagged `@internal`, no stability
// promise). NOT EXPORTED from the package.
// =============================================================================

import { internals as extractionInternals } from '@marinoscar/kvox-api/graph-extraction/testing';
import { internals as askInternals } from '@marinoscar/kvox-api/ask/testing';

export const { buildExtractionContext } = extractionInternals;
export type ExtractionContext = extractionInternals.ExtractionContext;

export const {
  AskRespondHandler,
  AskToolset,
  EntityBriefTool,
  EvidenceTool,
  GetEntityTool,
  ListCommitmentsTool,
  NeighborsTool,
  SearchTool,
  TimelineTool,
} = askInternals;
export type AskToolContext = askInternals.AskToolContext;
export type HandleRegistry = InstanceType<typeof askInternals.HandleRegistry>;
export const HandleRegistryClass = askInternals.HandleRegistry;
