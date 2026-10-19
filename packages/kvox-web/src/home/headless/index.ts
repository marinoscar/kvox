// The headless entry of the `home` slice of @marinoscar/kvox-web: what Home decides
// without drawing anything. Which sections exist, when an account counts as new,
// and the first-run journey as data, so a host with another design system builds
// its own Home on the same rules. No MUI, no router.

export { defaultJourneySteps, isJourneyStepVisible, resolveJourneySteps } from './journey.js';
export type {
  KvoxJourneyContext,
  KvoxJourneyProgress,
  KvoxJourneyStep,
  KvoxJourneyStepAction,
  ResolveJourneyStepsOptions,
} from './journey.js';
export { KVOX_HOME_SECTIONS, isNewAccount } from './sections.js';
export type { KvoxHomeSection, NewAccountFacts } from './sections.js';
