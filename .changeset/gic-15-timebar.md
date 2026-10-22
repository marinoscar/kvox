---
'@marinoscar/kvox-contract': minor
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-web': minor
---

TimeBar (GIC-15, #676): `GET /api/graph/activity?ids&bucket&from&to` returns evidence counts per week or month for up to 300 readable nodes and the relations among them, stacked by entity type, with a series per node (the citation is dated by its transcript's `recorded_at` or note's `created_at`, falling back to its own creation time; readable rows only, sensitive person facts excluded; an unreadable id is a 404, more than 300 ids a 400, a slow query the 3 s `graph_query_timeout`). `@marinoscar/kvox-contract` gains `graphActivityQuerySchema`, `graphActivityResponseSchema` (and their types, `GRAPH_ACTIVITY_MAX_IDS`); `@marinoscar/kvox-api` gains `GraphActivityService`; `@marinoscar/kvox-web` gains `getGraphActivity()`, `useGraphActivity()` and the explorer `TimeBar`: a stacked SVG histogram in the shell's `timeBar` slot with a brush (the range is `?from=&to=`, the graph is shown as of its end and nodes with no evidence in it are dimmed), two-way highlighting, Play, wheel and pinch zoom with automatic month/week switching, keyboard handles (`role="slider"`) and a "Set range" date-field sheet. It replaces the as-of slider on the canvas (the list view keeps it as the fallback); the inspector's Timeline tab gains "Show in TimeBar".
