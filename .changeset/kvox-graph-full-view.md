---
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-contract": minor
---

Graph overview for a full-graph explorer (#768): `GET /api/graph/overview` takes optional `types`, `from` and `to` filters (positions unchanged) and returns `typeCounts`; a commit, merge or merge reversal now queues one coalesced `kg.graph_layout` re-layout regardless of the 20 % threshold. `GraphOverviewService` takes `GraphOntologyService` as its third constructor argument.

Also: `edges=true` returns the induced live relations between the returned nodes (`edges`, `edgesTruncated`, capped at 20000), so the explorer can draw the whole graph.
