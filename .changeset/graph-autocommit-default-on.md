---
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-contract': minor
'@marinoscar/kvox-db': minor
'@marinoscar/kvox-web': minor
---

Commit the confident rows of every note's graph proposal automatically, by default (#779). The auto-commit job now runs for every note, not only notes of a note library, and applies the same safe policy as the Review Queue: ambiguous or possible-duplicate matches, closings, low-confidence rows and sensitive person facts still wait for a person. A new graph preference, `review.autoCommitSafeRows` ("Commit confident rows automatically", on by default, no backfill needed), controls it; a note library's own auto-commit setting, when set to on or off, overrides the preference for that library's notes. The library setting is now three-way: `autoCommit` is `null` (follow the preference), `true` or `false`, in the contract, the API and the library page. The domain migration makes the column nullable and turns the old never-chosen `false` into `null`. The note page gains a "Re-run extraction" action, which replaces an earlier open draft once the new one is ready.
