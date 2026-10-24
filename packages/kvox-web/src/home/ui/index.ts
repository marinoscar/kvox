// The MUI half of the `home` slice of @marinoscar/kvox-web: the Home page KVox web
// and KVox Desktop both draw, its sections as components, and the destination and
// route a navigation lists. Needs `@mui/material`, `@mui/icons-material` and
// `react-router-dom`; the rules it applies live in `./headless`.

export { KvoxHomePage } from './KvoxHomePage.js';
export type { KvoxHomePageProps } from './KvoxHomePage.js';
export { kvoxHomeDestination, kvoxHomeDestinationRoutes } from './navigation.js';
export { kvoxHomeRoutes } from './routes.js';

export { CountsStrip, countsEntries } from './components/CountsStrip.js';
export {
  GraphStatsHomeCard,
  HOME_GRAPH_RECENT_LIMIT,
  HomeAskCard,
  KnowledgeHomeGrid,
  LibrariesHomeCard,
  RecentImportsHomeCard,
  ReviewQueueHomeCard,
} from './components/KnowledgeCards.js';
export type { CountsEntry, CountsStripProps } from './components/CountsStrip.js';
export {
  GRAPH_REVIEW_LIMIT,
  GRAPH_REVIEW_POLL_MS,
  GraphReviewCard,
} from './components/GraphReviewCard.js';
export { HomeHero, firstNameOf } from './components/HomeHero.js';
export type { HomeHeroProps } from './components/HomeHero.js';
export { HomeSearchField, searchPathFor } from './components/HomeSearchField.js';
export { HomeSkeleton } from './components/HomeSkeleton.js';
export type { HomeSkeletonProps } from './components/HomeSkeleton.js';
export { InProgressSection, dedupeServerItems } from './components/InProgressSection.js';
export type { InProgressSectionProps } from './components/InProgressSection.js';
export {
  JOURNEY_INTRO,
  JOURNEY_STAGES,
  JourneyEmptyState,
} from './components/JourneyEmptyState.js';
export type { JourneyEmptyStateProps, JourneyStage } from './components/JourneyEmptyState.js';
export {
  KVOX_NOTE_FIRST_JOURNEY,
  KVOX_NOTE_FIRST_JOURNEY_INTRO,
  noteFirstJourneySteps,
} from './components/NoteFirstJourney.js';
export {
  KNOWLEDGE_LIMIT,
  KNOWLEDGE_TYPES,
  KnowledgeSection,
} from './components/KnowledgeSection.js';
export { NeedsAttention } from './components/NeedsAttention.js';
export type { NeedsAttentionProps } from './components/NeedsAttention.js';
export { NoteSummaryCard } from './components/NoteSummaryCard.js';
export type { NoteSummaryCardProps } from './components/NoteSummaryCard.js';
export { RecentNotes } from './components/RecentNotes.js';
export type { RecentNotesProps } from './components/RecentNotes.js';
export { RecentTranscripts } from './components/RecentTranscripts.js';
export type { RecentTranscriptsProps } from './components/RecentTranscripts.js';
export { SharedWithMe } from './components/SharedWithMe.js';
export type { SharedWithMeProps } from './components/SharedWithMe.js';
export { TranscriptSummaryCard, accessRoleLabel } from './components/TranscriptSummaryCard.js';
export type { HomeTranscriptItem, TranscriptSummaryCardProps } from './components/TranscriptSummaryCard.js';
