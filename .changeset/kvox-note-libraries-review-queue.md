---
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-contract': minor
---

Add the cross-proposal Review Queue (`GET /api/graph/review-queue`) and the safe batch commit (`POST /api/graph/proposals/commit-batch`, #717). A pure safe policy never accepts a sensitive person fact, a closing, an ambiguous or merge row, a row below the new `graph.review.minConfidence` preference (default 0.7), or a stale proposal; rows left waiting move to a new draft. `ProposalBatchCommitService.commitSafe` is reusable by the upcoming `kg.autocommit` job.
