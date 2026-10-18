---
"@marinoscar/kvox-api": patch
---

Reviewing and committing a proposal no longer deadlocks a one-connection database (PGlite with a single connection, as the desktop host runs it) (#615). A segment span's origin transcript is resolved before the review transaction opens (new `SpanValidator.prepare(source, spans)`; `validate(tx, source, spans, context)` uses only `tx`), and the commit prefetches the port answers its evidence checks need (import-object ownership, transcripts shared with the owner) before its transaction: new `EvidenceValidator.prefetch` / `GraphWriteService.prefetchEvidence` return an `EvidenceAccess` that `assertReadable`, `viewableTranscriptIds`, the create inputs (`evidenceAccess`) and `addEvidence` accept optionally. An owned transcript never asks the sharing port; an id the access does not cover still goes to the port, so other callers are unchanged.
