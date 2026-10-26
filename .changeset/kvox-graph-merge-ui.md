---
"@marinoscar/kvox-web": minor
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-contract": minor
---

Merge graph entities from the UI, with undo, and show every alias (#765).

- `@marinoscar/kvox-api`: `GET /api/graph/entities/:id/merges` lists the entities merged into an entity, newest first, each with `reversible`. `GET /api/graph/entities/:id` answers 200 for a merged tombstone (`reviewStatus: 'merged'`, `mergedIntoId` set to the survivor, zero counts) instead of 404, so a client can redirect.
- `@marinoscar/kvox-contract`: `listEntityMergesResponseSchema`; `graphEntityDetailSchema.reviewStatus` adds `'merged'` and the optional `mergedIntoId`.
- `@marinoscar/kvox-web`: the headless client functions `mergeEntity`, `reverseMerge`, `recordDistinctPair` and `listEntityMerges`, and the hooks `useEntityMerges` and `useEntityMergeActions` (with `mergeErrorMessage`). The entity page's menu offers "Merge into…" for every type to a `graph:write` viewer: search the same type, preview both side by side, choose which name to keep, then merge; the page opens the survivor and offers Undo. A tombstone's URL redirects to its survivor, a "Merged from" section lists merges with Undo, and the header shows every alias under "Also known as" with a "+n" that expands; a writer clicking a name opens the edit dialog.
