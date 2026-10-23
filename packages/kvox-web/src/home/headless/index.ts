// The headless entry of the `home` slice of @marinoscar/kvox-web: what Home decides
// without drawing anything. Which sections exist, when an account counts as new,
// and the first-run journey as data, so a host with another design system builds
// its own Home on the same rules. No MUI, no router. The one hook here,
// `useHomeImports`, reads the note libraries and import batches for the
// knowledge-first cards.

export { defaultJourneySteps, isJourneyStepVisible, resolveJourneySteps } from './journey.js';
export type {
  KvoxJourneyContext,
  KvoxJourneyProgress,
  KvoxJourneyStep,
  KvoxJourneyStepAction,
  ResolveJourneyStepsOptions,
} from './journey.js';
export { KVOX_HOME_SECTIONS, KVOX_KNOWLEDGE_HOME_SECTIONS, isNewAccount } from './sections.js';
export type { KvoxHomeSection, NewAccountFacts } from './sections.js';
export { HOME_RECENT_IMPORTS_LIMIT, summarizeLibraries, useHomeImports } from './imports.js';
export type { HomeLibrariesSummary, UseHomeImportsOptions, UseHomeImportsResult } from './imports.js';
