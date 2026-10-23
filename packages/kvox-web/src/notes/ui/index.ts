// The MUI half of the notes slice: the pages, the library and the pieces other
// screens embed, the slot contracts, and the data the app spreads into its
// registries (the destination, the routes and the Note Templates card). The
// editor (`@tiptap/*`) and the markdown renderer (`react-markdown`) are optional
// peers of this entry only.

export { NoteHistoryPage } from './pages/NoteHistoryPage.js';
export { NewNotePage } from './pages/NewNotePage.js';
export type { NewNotePageProps } from './pages/NewNotePage.js';
export { NotePage } from './pages/NotePage.js';
export type { NotePageProps } from './pages/NotePage.js';
export { NotesImportActions, NotesPage } from './pages/NotesPage.js';
export { NOTE_IMPORT_FORMATS_TEXT, NoteLibrariesPage } from './pages/NoteLibrariesPage.js';
export type { NoteLibrariesPageProps } from './pages/NoteLibrariesPage.js';
export { AUTO_COMMIT_SAFE_POLICY_TEXT, NoteLibraryPage } from './pages/NoteLibraryPage.js';
export type { NoteLibraryPageProps } from './pages/NoteLibraryPage.js';
export {
  NoteImportBatchPage,
  defaultReviewQueuePath,
  importCompletionSentence,
} from './pages/NoteImportBatchPage.js';
export type { NoteImportBatchPageProps } from './pages/NoteImportBatchPage.js';
export { ImportNotesButton } from './components/ImportNotesButton.js';
export type { ImportNotesButtonProps } from './components/ImportNotesButton.js';
export { NotesDropZone } from './components/NotesDropZone.js';
export type { NotesDropZoneProps } from './components/NotesDropZone.js';
export { ScanConfirmDialog, scanPlanSummary } from './components/ScanConfirmDialog.js';
export type { ScanConfirmDialogProps } from './components/ScanConfirmDialog.js';
export { ImportBatchItemList, importStageLabel } from './components/ImportBatchItemList.js';
export type { ImportBatchItemListProps } from './components/ImportBatchItemList.js';
export { ImportStageFunnel, importFunnelSteps } from './components/ImportStageFunnel.js';
export type { ImportFunnelStep, ImportStageFunnelProps } from './components/ImportStageFunnel.js';
export { NoteLibraryCard, noteLibraryPath } from './components/NoteLibraryCard.js';
export type { NoteLibraryCardProps } from './components/NoteLibraryCard.js';
export {
  noteImportBatchPath,
  summarizeImportFailures,
  useAdHocNoteImport,
} from './library/useAdHocNoteImport.js';
export type { AdHocNoteImport, NoteImportNavigationState } from './library/useAdHocNoteImport.js';
export { useLibrarySyncRunner, syncErrorMessage } from './library/useLibrarySyncRunner.js';
export type { LibrarySyncRunner, LibrarySyncRunnerOptions } from './library/useLibrarySyncRunner.js';
export { useLibraryFolders } from './library/useLibraryFolders.js';
export type { LibraryFolders } from './library/useLibraryFolders.js';
export {
  describeSyncProgress,
  formatImportBytes,
  formatTokenEstimate,
  pluralize,
  syncProgressPercent,
} from './library/format.js';
export type { NotesPageProps } from './pages/NotesPage.js';
export { UserNoteTemplatesPage } from './pages/UserNoteTemplatesPage.js';
export type { UserNoteTemplatesPageProps } from './pages/UserNoteTemplatesPage.js';
export { NotesLibraryView, SourceLine } from './components/NotesLibraryView.js';
export type { NotesLibraryViewProps } from './components/NotesLibraryView.js';
export { MarkdownView } from './components/MarkdownView.js';
export type { MarkdownViewProps } from './components/MarkdownView.js';
export { ModelSelect } from './components/ModelSelect.js';
export type { ModelSelectProps } from './components/ModelSelect.js';
export { NoteStatusChip } from './components/NoteStatusChip.js';
export type { NoteStatusChipProps } from './components/NoteStatusChip.js';
export { TranscriptNotesSection } from './components/TranscriptNotesSection.js';
export type { TranscriptNotesSectionProps } from './components/TranscriptNotesSection.js';
export { NO_NOTES_AI_ACCESS } from './ai.js';
export type { NotesAiAccess, NotesAiModel, NotesAiState } from './ai.js';
export { NotesSlotBoundary } from './slots.js';
export type {
  NoteHeaderActionsProps,
  NotePageProviderProps,
  NotePageSlots,
  NoteProposalActionsProps,
  NoteSelectionActionsProps,
  NotesLibrarySelectionActionsProps,
  NotesLibrarySlots,
  NotesSlotBoundaryProps,
  NotesSlotBoundaryState,
} from './slots.js';
export {
  kvoxNoteTemplatesDestinationRoutes,
  kvoxNoteTemplatesDestinations,
  kvoxNotesDestinationRoutes,
  kvoxNotesDestinations,
} from './navigation.js';
export { kvoxNotesUserSettingsSections } from './settings.js';
export type { KvoxNotesUserSettingsSections } from './settings.js';
export { kvoxNotesRoutes } from './routes.js';
