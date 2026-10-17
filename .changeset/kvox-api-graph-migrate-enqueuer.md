---
"@marinoscar/kvox-api": minor
---

Export `KgMigrateEnqueuer` and `KG_MIGRATE_OWNERS_PER_TICK` from `@marinoscar/kvox-api/graph` (`@stability experimental`) and add the enqueuer to the exports of `GraphModule`. A host that sets `schedules: false` (KVox Desktop) can now drive the `kg.migrate` scheduler tick on its own timer by resolving the class from the container and calling `enqueue()`, the way it already calls the transcripts, notes and export-expiry enqueuers.
