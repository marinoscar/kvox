---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-api": minor
---

Possible duplicates (#766). `@marinoscar/kvox-api`: `GET /api/graph/duplicates` (`graph:read`; `type`, `limit`) lists pairs of the caller's live entities that probably are one thing, from a bounded name pass (whole-word containment, initials such as "OAC" for "Org Alpha Consulting", shared name or alias, `pg_trgm` similarity of 0.6 or more; same type only, distinct pairs excluded) and from the open `resolution` proposals, each with `reasons`, a deterministic `score` and its source. `POST /api/graph/duplicates/scan` (`graph:write`) queues `kg.resolve` with reason `manual` and joins a run already in flight (`alreadyRunning`). The pure name signals live in `resolution/duplicate-names.ts`. `@marinoscar/kvox-contract/graph`: `listDuplicatesQuerySchema`, `listDuplicatesResponseSchema`, `duplicatesScanResponseSchema`, `DUPLICATE_REASONS`, `DUPLICATE_SOURCES`.
