---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-web": minor
---

Manual relation edits (#586): `POST /api/graph/entities/:id/relations` sets a Person's manager (`REPORTS_TO`), employer (`WORKS_FOR`) or role (`HAS_ROLE`) by hand, closing the still-open edge of that type with the proposal commit's closing rule, and `DELETE /api/graph/entities/:id/relations/:relationId` retracts a wrong one. The relation is cited by the owner: a server-authored evidence row (`source.kind: 'manual'`, quote "Set by hand: …", the reserved `MANUAL_EVIDENCE_SOURCE_IRI` that `evidenceInputSchema` now refuses from any client), which Ask cites as a valid evidence citation labelled "Set by hand". The entity page offers "Set manager", "Set employer", "Add role" and Remove (`EntityRelationDialog`, `useEntityRelationEdits`), and a new `/graph/review` page (`GraphReviewPage`, `useGraphReviewQueue`) lists the proposals waiting for review. `@marinoscar/kvox-api/testing` gains the scenario-driven model hosts use in end-to-end tests (`createScenarioKvoxAi`, `scenarioStructuredAnswer`, `nextAskMove`, `KvoxScenarioMeeting`), moved from the bare host; `ruleForEffectiveRelation`, `isExclusiveTemporal` and `loadLiveTemporalEdges` are exported from the graph slice.
