// The MUI half of the transcripts slice: the pages, the library and the status
// chip other screens embed, the slot contracts, and the data the app spreads into
// its registries (the destination and the routes).

export { NewTranscriptPage } from './pages/NewTranscriptPage.js';
export { TranscriptHistoryPage } from './pages/TranscriptHistoryPage.js';
export { TranscriptPage } from './pages/TranscriptPage.js';
export { CREATE_NOTE_NOT_READY_REASON } from './pages/TranscriptPage.js';
export type { TranscriptPageProps } from './pages/TranscriptPage.js';
export { TranscriptsPage } from './pages/TranscriptsPage.js';
export type { TranscriptsPageProps } from './pages/TranscriptsPage.js';
export { TranscriptsLibraryView } from './components/TranscriptsLibraryView.js';
export type { TranscriptsLibraryViewProps } from './components/TranscriptsLibraryView.js';
export { TranscriptStatusChip } from './components/TranscriptStatusChip.js';
export { IMPORT_TRANSCRIPT_LABEL, ImportTranscriptButton } from './components/ImportTranscriptButton.js';
export type { ImportTranscriptButtonProps } from './components/ImportTranscriptButton.js';
export type { TranscriptStatusChipProps } from './components/TranscriptStatusChip.js';
export { SlotBoundary } from './slots.js';
export type {
  SlotBoundaryProps,
  SlotBoundaryState,
  TranscriptAiAccess,
  TranscriptAiState,
  TranscriptPageSlots,
  TranscriptSelectionActionsProps,
  TranscriptShareDialogProps,
  TranscriptSharingAdapter,
  TranscriptSpeakerPeople,
  TranscriptsLibrarySlots,
} from './slots.js';
export { kvoxTranscriptsDestinationRoutes, kvoxTranscriptsDestinations } from './navigation.js';
export { kvoxTranscriptsRoutes } from './routes.js';
