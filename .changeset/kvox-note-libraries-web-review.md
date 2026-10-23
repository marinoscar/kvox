---
'@marinoscar/kvox-web': minor
---

Add the Review Queue and a knowledge-first Home (#721, epic #708). `/graph/review-queue` (`GraphReviewQueuePage`, `graph:read`) lists draft proposals grouped by library and import batch with safe and waiting row counts, explains the safe policy ("What is safe?"), and commits a group's safe rows in one action for `graph:write` (`useReviewQueue`, `useCommitBatch`, client `getReviewQueue`/`commitBatch`, helpers `summarizeCommitBatch`, `reviewGroupLabel`, `waitReasonCopy`); the Review page links to it and the Review destination owns it. The graph preferences gain `review.minConfidence` (default 0.7), editable under "Batch review" in the Knowledge graph settings. Home gains the sections `ask`, `reviewQueue`, `libraries`, `graphStats` and `recentImports` and the preset `KVOX_KNOWLEDGE_HOME_SECTIONS`, which `kvoxHomeRoutes` now draws; `KVOX_HOME_SECTIONS` is unchanged.
