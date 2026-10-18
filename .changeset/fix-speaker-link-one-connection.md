---
"@marinoscar/kvox-api": patch
---

`kg.speaker_link` no longer deadlocks a one-connection database (PGlite with a single connection, as the desktop host runs it) (#612): the job resolves the owner's effective schema and `graph:write` permission before it opens its transaction, and `SpeakerLinkReconciler.reconcile(tx, input, context)` uses only `tx` (the context comes from the new `resolveContext(actorUserId)`).
