---
"@marinoscar/kvox-ai": minor
"@marinoscar/kvox-eval": minor
"@marinoscar/kvox-api": patch
---

Harness parity (#580). `@marinoscar/kvox-ai/testing` gains request recorders: `createRecordingRuntime` (every runtime round trip, without user, org, job or signal), `createRecordingAdapter` (a scripted provider adapter for `createDirectRuntime` that records what it receives) and `normalizeRecordedValue` (ids, timestamps and request ids numbered by first appearance, nothing dropped). `@marinoscar/kvox-eval/parity` drives notes generation, `kg.extract`, adjudication and three Ask questions through the real package code over any `KvoxAiPort` and ships the request snapshots (`parity/requests.*.json`) every host binding must reproduce; `kg` also exports `runExtraction` and `fixtureToInput`. `@marinoscar/kvox-api/notes` exports `budgetFromTarget` and the `AiTokenCaps` type.
