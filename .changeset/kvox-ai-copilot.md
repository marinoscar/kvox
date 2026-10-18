---
"@marinoscar/kvox-ai": minor
---

GitHub Copilot provider adapter for KVox Desktop (#581, Phase 2). New entry `@marinoscar/kvox-ai/copilot`: `createCopilotAdapter` (an `AiProviderAdapter`, opt-in: it throws unless `optIn === true`; notes and graph extraction only, `toolCalling` false, no embeddings), `createSdkCopilotTransport`, `createCopilotMockTransport` and the fallback model catalog. The entry is not re-exported by the root. New optional peer `@github/copilot-sdk` (`^1.0.22`), loaded lazily by the real transport only. Shared by every adapter: a prompted structured-output path (`structuredOutputMode: 'prompted'` per model puts the schema in the prompt and makes one repair), per-model `toolCalling` in `capabilities()`, and `wrapRecordingAdapter` in `@marinoscar/kvox-ai/testing`. `scrub` also covers `ghu_`, `ghs_` and `ghr_` tokens.
