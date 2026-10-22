---
'@marinoscar/kvox-contract': minor
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-web': minor
---

Graph paths (GIC-12, #673): `GET /api/graph/paths?from&to&k&maxHops&types&relationTypes&as_of` returns the top k distinct, evidence-weighted paths between two of the caller's nodes plus the slice they cover. A bidirectional BFS in SQL with the neighbourhood's readable and as-of predicates, a 2,000-row cap per level, the 3 s `graph_query_timeout`, items as endpoints only, sensitive person facts never reachable, and a hub penalty in the score. `@marinoscar/kvox-contract` gains `graphPathsQuerySchema`, `graphPathSchema`, `graphPathsResponseSchema` (and their types); `@marinoscar/kvox-api` gains `GraphPathsService`; `@marinoscar/kvox-web` gains `getGraphPaths()`.
