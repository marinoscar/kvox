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
export { NotesPage } from './pages/NotesPage.js';
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
