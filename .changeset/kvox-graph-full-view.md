---
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-web": minor
---

Graph overview for a full-graph explorer (#768): `GET /api/graph/overview` takes optional `types`, `from` and `to` filters (positions unchanged) and returns `typeCounts`; a commit, merge or merge reversal now queues one coalesced `kg.graph_layout` re-layout regardless of the 20 % threshold. `GraphOverviewService` takes `GraphOntologyService` as its third constructor argument.

Also: `edges=true` returns the induced live relations between the returned nodes (`edges`, `edgesTruncated`, capped at 20000), so the explorer can draw the whole graph.

Web: `/graph/explore` opens on the FULL graph (#768). A bare visit loads `GET /api/graph/overview?edges=true` and draws every node and edge at its stable snapshot position (static layout, colour by type, size by degree, labels only for the best-connected nodes), as a distinct mode with the server's 5,000-node / 20,000-edge cap instead of the explorer's 300; it no longer seeds from the five recently viewed entities. Focus (or a double-click) on a node opens the focused, expandable view seeded with it, and its new "Full graph" button goes back. The filters sit in one row under the toolbar (`ExplorerFilterBar`): search, the type chips with live counts from `typeCounts` (an empty type is disabled), and ONE Time control (`ExplorerTimeControl`: All time, Last 30 days, Last 90 days, Last year, Custom range) that replaces the TimeBar strip and the as-of slider on the page. In the full view the type filter and time range go to the server; in the focused view the range still sets `as_of` to its end when that is in the past, and nodes with no evidence in the window are now filtered off the canvas instead of dimmed. A "Building your graph map…" state with "Check again" covers a graph with no snapshot yet, a banner says when the snapshot was trimmed, and the focused view's default layout is chosen again on every rebuild. New: `useGraphFullView`, `fullViewBudgets`, an optional `labelSizeThreshold` budget, `ExplorerToolbar`'s `countLabel` and `ExplorerFilters`' `hideTypes`.
