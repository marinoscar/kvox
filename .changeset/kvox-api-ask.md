---
"@marinoscar/kvox-api": minor
---

Add `@marinoscar/kvox-api/ask` and `/ask/testing`: `AskModule.forRoot` (saved conversations, the `ask.respond` job that drives `KVOX_AI.chat` with the seven read-only graph tools, and the SSE view over the durable answer) over the host ports and the graph, notes and search slices, with `AskUserDataService` and `describeAskConformance`, `createScriptedChat`, an in-memory copy of the two Ask tables and the tool fakes in the testing entry. The turn's caps (`limits.maxSteps`, `maxCallsPerStep`, `softClockMs`) can only be lowered by a host, and `forRoot` throws for a value above today's. `core` gains `KvoxRowStreamPoller`, the poll loop the note and Ask streams now share (the notes slice re-exports the constants it used to define). The `KVOX_AI` chat `done` event gains an optional `finishReason` (`stop`, `length`, `content_filter`), and the graph slice's AI run resolver accepts the `ask.respond` task.
