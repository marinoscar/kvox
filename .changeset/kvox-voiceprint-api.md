---
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-contract': minor
---

Speaker voiceprints API (#826): `GET /api/graph/speaker-suggestions`, `POST .../:id/accept` and `.../:id/dismiss`, `GET|DELETE /api/graph/entities/:id/voiceprint`, `DELETE /api/graph/voiceprints` and `GET /api/graph/voiceprints/summary`. Turning `graph.voiceprints.enabled` on queues the new server-only `kg.voiceprint_backfill` job, which learns voices from speakers already linked to Persons. The resolved graph preferences gain a `voiceprints` section. The contract gains the wire schemas of these routes.
