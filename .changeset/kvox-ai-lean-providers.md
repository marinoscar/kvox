---
"@marinoscar/kvox-ai": minor
"@marinoscar/kvox-eval": minor
---

`@marinoscar/kvox-ai` and `@marinoscar/kvox-eval` no longer require `@marinoscar/platform-api`: they depend on the lean `@marinoscar/platform-ai-providers` (provider adapters and the provider-agnostic AI core, no Nest runtime) as an exact-version peer, and `kvox-eval` gains an `openai` peer for its live runs (#578). `kvox-ai` exports `isAiError()`, which recognises the lean `AiError` and the web host's distinct `AiError` class, so error classification is unchanged in both editions.
