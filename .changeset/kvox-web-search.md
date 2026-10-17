---
"@marinoscar/kvox-web": minor
---

Add `@marinoscar/kvox-web/search/headless` and `/search/ui`. The search slice moves the clients of `GET /api/search`, `GET /api/search/index-status` and `POST /api/search/index`, the `useSearch` and `useSearchIndex` hooks, `SearchResultsView`, `SearchSnippet`, `SemanticSearchNotice` and the Search Indexing page into the package, over `KvoxWebHost` only, with the page's card (`kvoxSearchUserSettingsSections`, no permission by design) and route (`kvoxSearchRoutes`) as data. `SemanticSearchNotice` explains the new `embeddings_unavailable` reason (a host without a usable embeddings model), and a test fails when the contract gains a reason without copy.
