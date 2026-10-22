// The MUI half of the graph slice: the pages, the pieces other screens embed,
// the slot components for the transcript and note pages and the libraries, and
// the data the app spreads into its registries (the destination, the routes and
// the Knowledge graph card). The drawing libraries (sigma and its React
// bindings, `graphology` and its ForceAtlas2 layout) are optional peers of this
// entry only, and they load lazily: `GraphCanvas.tsx` is the one file that
// imports sigma, reached only through the explorer, the overview and the
// neighbourhood widget.

export { GraphIndexPage } from './pages/GraphIndexPage.js';
export type { GraphIndexLocationState } from './pages/GraphIndexPage.js';
export { GraphEntityPage, ENTITY_ASK_NEW, ENTITY_ASK_PARAM } from './pages/GraphEntityPage.js';
export type {
  GraphEntityAskButtonProps,
  GraphEntityAskPanelProps,
  GraphEntityPageProps,
  GraphEntityPageSlots,
} from './pages/GraphEntityPage.js';
export { GraphExplorerPage } from './pages/GraphExplorerPage.js';
export type { GraphExplorerNodeActionsProps, GraphExplorerPageProps, GraphExplorerPageSlots } from './pages/GraphExplorerPage.js';
export { GraphOverviewPage } from './pages/GraphOverviewPage.js';
export { GraphImportPage } from './pages/GraphImportPage.js';
export { GraphReviewPage, reviewTarget } from './pages/GraphReviewPage.js';
export type { ReviewTarget } from './pages/GraphReviewPage.js';
export { UserKnowledgeGraphPage } from './pages/UserKnowledgeGraphPage.js';

export { EvidenceChip, EvidenceChips } from './components/EvidenceChip.js';
export type { EvidenceChipProps } from './components/EvidenceChip.js';
export { EntityConnectionsList } from './components/EntityConnectionsList.js';
export type { EntityConnectionsListProps } from './components/EntityConnectionsList.js';
export { ENTITY_RELATION_EDITS, EntityRelationDialog } from './components/EntityRelationDialog.js';
export type { EntityRelationDialogProps, EntityRelationEditCopy } from './components/EntityRelationDialog.js';
export { NeighborhoodWidget } from './components/NeighborhoodWidget.js';
export type { NeighborhoodWidgetProps } from './components/NeighborhoodWidget.js';
export { SchemaForm } from './components/schema/SchemaForm.js';
export type { SchemaFormProps } from './components/schema/SchemaForm.js';
export { EntityTypeIcon } from './components/entityTypeIcon.js';
export { EntityListRow, entityPath } from './components/EntityListRow.js';
export type { EntityListRowProps } from './components/EntityListRow.js';
export { EntitySearchHits } from './components/EntitySearchHits.js';
export type { EntitySearchHitsProps } from './components/EntitySearchHits.js';
export { ProposalReviewSheet, REVIEW_SHEET_WIDTH } from './components/review/ProposalReviewSheet.js';
export type { ProposalReviewSheetProps } from './components/review/ProposalReviewSheet.js';

export { useGraphExplorer } from './hooks/useGraphExplorer.js';
export type { ExpandOnly, ExternalSliceMerge, UseGraphExplorerOptions, UseGraphExplorerResult } from './hooks/useGraphExplorer.js';

export {
  GraphNotePageProvider,
  GraphNoteHeaderActions,
  GraphNoteProposalActions,
  GraphNoteSelectionActions,
  graphNotePageSlots,
  graphNotesLibrarySlots,
  useGraphNoteAsideWidth,
} from './slots/GraphNoteSlots.js';
export type { GraphNotePageProviderProps } from './slots/GraphNoteSlots.js';
export { GraphSearchPrefix } from './slots/GraphSearchPrefix.js';
export type { GraphSearchPrefixProps } from './slots/GraphSearchPrefix.js';
export {
  GraphTranscriptSelectionActions,
  graphTranscriptPageSlots,
  graphTranscriptsLibrarySlots,
  useGraphSpeakerPeople,
} from './slots/GraphTranscriptSlots.js';

export {
  kvoxGraphDestinationRoutes,
  kvoxGraphDestinations,
  kvoxReviewDestinationRoutes,
  kvoxReviewDestinations,
} from './navigation.js';
export { kvoxGraphUserSettingsSections } from './settings.js';
export type { KvoxGraphUserSettingsSections } from './settings.js';
export { kvoxGraphRoutes } from './routes.js';

export type {
  ExplorerEdgeAttributes,
  ExplorerGraph,
  ExplorerNodeAttributes,
  ExplorerPalette,
  ExplorerState,
} from './components/explorer/explorerModel.js';
export type {
  GraphCanvasControls,
  GraphCanvasGraph,
  GraphCanvasProps,
  CameraSnapshot,
  NodeContextMenuEvent,
} from './components/explorer/GraphCanvas.js';
export type { CanvasLayout } from './components/explorer/layout/useCanvasLayout.js';
export type { ExplorerBudgets } from './components/explorer/shell/explorerBudgets.js';
export type { Insets } from './components/explorer/shell/canvasGestures.js';
export type { NeighborhoodCanvasProps } from './components/explorer/NeighborhoodCanvas.js';
export { GraphLegend, useLegendTypeFilter } from './components/explorer/GraphLegend.js';
export type { GraphLegendProps, LegendTypeFilter } from './components/explorer/GraphLegend.js';
export type { ExplorerMode } from './components/explorer/explorerEncoding.js';
export { legendModel } from './components/explorer/explorerModel.js';
export type { LegendModel, LegendRelation, LegendType } from './components/explorer/explorerModel.js';
