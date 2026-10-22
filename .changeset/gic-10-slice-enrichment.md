---
'@marinoscar/kvox-contract': minor
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-web': patch
---

Graph slice enrichment (GIC-10, #671): `GraphNode` gains optional `mentionCount` and `lastSeenAt`, `GraphEdge` gains optional `evidenceCount` and `lastEvidenceAt` (a virtual item edge carries its item's). They are computed for the final page of rows only, from readable statuses, and never count evidence of a sensitive fact. Older fixtures without the fields still parse.
