---
"@marinoscar/kvox-ai": minor
---

`createKvoxAi(options)` implements `KvoxAiPort` over a host-supplied `KvoxAiRuntime` (#579): strict structured output with Zod re-validation, the truncation rule, the reasoning-effort clamp, the request timeout, the tool-call chat mapping, readiness and capabilities, and one translation of every failure to a `KvoxAiError`. `createDirectRuntime({ adapters, keys })` runs it over provider adapters with a key fetched per call (KVox Desktop). New entry `@marinoscar/kvox-ai/testing`: `createScriptedRuntime` and `describeKvoxAiConformance`.
