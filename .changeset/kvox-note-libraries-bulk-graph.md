---
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-contract': minor
---

Bulk graph extraction and opt-in auto-commit for note libraries (#716, #718; ADR-0007). Library imports queue `kg.extract` at the new `KG_EXTRACT_BULK_PRIORITY` (50) and stamp `note_library_files.extracted_version` when a draft lands. New server-only job `kg.library_reconcile` (queued by `GraphReconcileEnqueuer` and on `kvox.notes.import_batch_settled`) re-queues library notes the graph has not read at their current version. New route `POST /api/graph/import-batches/:batchId/retry-extractions`. New event `kvox.graph.proposal_drafted` and server-only job `kg.autocommit`, which commits the safe rows of a draft when the library's `auto_commit` is on. The contract adds `NOTE_IMPORT_BATCH_SETTLED_EVENT` and `retryExtractionsResponseSchema`.
