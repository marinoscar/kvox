---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-web": minor
---

Find topics in past meetings (#666, epic #661). `@marinoscar/kvox-api`: the `kg.topics_promote` job (server-only, `{ maxRuntimeMs: 30m, maxAttempts: 3 }`) turns the free-text topics of a user's past Meeting entities into draft Topic proposals through the existing resolution pipeline and `ProposalWriter` (new `createDraft`), one proposal per Topic with a `DISCUSSED` row and the meeting's own citation per meeting; idempotent, never writes the graph. `POST|GET /api/graph/topics/promote` (`graph:write`) queue it and report it. `@marinoscar/kvox-contract/graph`: `topicsPromoteRequestResponseSchema`, `topicsPromoteStatusSchema`. `@marinoscar/kvox-web`: a "Past meetings" section with the "Find topics in past meetings" button on the Knowledge graph settings card, hidden without `graph:write` or while the host's `graphEnabled` is not true, with `useTopicsPromote` and the two client calls.
