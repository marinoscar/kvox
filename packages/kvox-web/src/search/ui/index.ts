// The MUI half of the search slice: the results view the library screens embed,
// the snippet and the keyword-only notice it is made of, the Search Indexing
// page, and the data the app spreads into its registries (the settings card and
// the route).

export { SearchResultsView } from './SearchResultsView.js';
export type { SearchResultsViewProps } from './SearchResultsView.js';
export { parseSnippetHtml, SearchSnippet, unescapeSnippetText } from './SearchSnippet.js';
export type { SearchSnippetProps, SnippetPart } from './SearchSnippet.js';
export { SemanticSearchNotice } from './SemanticSearchNotice.js';
export type { SemanticSearchNoticeProps } from './SemanticSearchNotice.js';
export { UserSearchIndexPage } from './UserSearchIndexPage.js';
export { kvoxSearchRoutes } from './routes.js';
export { kvoxSearchUserSettingsSections } from './settings.js';
export type { KvoxSearchUserSettingsSections } from './settings.js';
