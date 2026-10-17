# search

The search UI of `@marinoscar/kvox-web`: the ranked results view the library screens embed, the keyword-only notice, and the Search Indexing settings page.

## Purpose and scope

Library search (`GET /api/search`) and per-user semantic indexing (`GET /api/search/index-status`, `POST /api/search/index`). The slice holds the two API clients, the `useSearch` hook (debounce, a request token plus `AbortSignal` against the search race, cursor paging, a quiet restart on a stale cursor), the `useSearchIndex` hook (status, request, a poll that runs only while documents are pending), the plain-language strings for indexing outcomes, `SearchResultsView`, `SearchSnippet`, `SemanticSearchNotice`, the Search Indexing page at `/settings/search-index`, and that page's card and route as data. The slice never renders a library screen: the transcripts and notes libraries own those and embed `SearchResultsView`. The Home search box belongs to the app.

Status: filled (Epic 7, issue 7.3).

## Entry point

- `@marinoscar/kvox-web/search/headless`: `search`, `isStaleCursorError`, `getSearchIndexStatus`, `requestSearchIndex` (each takes the host first), `useSearch`, `useSearchIndex`, `describeIndexReason`, `describeUnavailableReason`, `countNeedingIndex`, `hasPendingIndexing` and the wire types (`SearchResult`, `SearchSnippet`, `SearchType`, `SemanticReason`, `SearchResponse`, `SearchIndexStatus`).
- `@marinoscar/kvox-web/search/ui`: `SearchResultsView`, `SearchSnippet`, `SemanticSearchNotice`, `UserSearchIndexPage`, `kvoxSearchUserSettingsSections` and `kvoxSearchRoutes`.

The slice depends on `core`. The app spreads `kvoxSearchUserSettingsSections.account` into the `Account` group of its user settings registry (directly after `AI Provider`) and renders `kvoxSearchRoutes` where its literal route used to be.

## Peer dependencies

`@marinoscar/kvox-contract`, `react` and `react-dom` for the headless entry; `ui` adds `@mui/material`, `@mui/icons-material` and `react-router-dom`, optional peers of the package.

## Configuration

None. The hooks and the page read their host (`useKvoxHost`). `SearchResultsView` takes `type`, `query`, `search` (the whole `useSearch` result), `dense`, `onOpen(result)` and an optional `unappliedStatusFilter`; a library screen passes them through and navigates on `onOpen`.

## Extension-point catalog

- `kvoxSearchUserSettingsSections`: one card, `{ title: 'Search Indexing', path: '/settings/search-index' }` with NO `permission`, by design. `search-index.controller.ts` gates both routes on `@Auth()` alone: the resource is the caller's own content and the caller's own AI provider account. A card's permission must equal what the controller enforces, so none is declared.
- `kvoxSearchRoutes`: one ungated route on the same path. The page's real gate is a capability (does the deployment embed, has the user saved a key), which the page checks itself.
- `SemanticSearchNotice` copy: every value of `SEMANTIC_REASONS` in `@marinoscar/kvox-contract/search` has a sentence, the newest being `embeddings_unavailable` ("Search by meaning isn't available on this installation. Results match your words exactly."). Upgrade note: when the contract gains a reason, add its copy to `SEARCH_ONLY_REASON_TEXT` (a search-only reason) or to the indexing lookup in `search-index-client.ts` (an indexing outcome); `test/search/semantic-reasons-copy.test.tsx` fails until you do, and an unknown reason otherwise renders as `Indexing reported: <token>`.
