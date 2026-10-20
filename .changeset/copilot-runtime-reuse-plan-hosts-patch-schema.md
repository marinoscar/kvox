---
"@marinoscar/kvox-ai": patch
"@marinoscar/kvox-contract": patch
---

Copilot fixes found in KVox Desktop (#646). `@marinoscar/kvox-ai/copilot`: `prepareCopilotRuntime` takes `installed` (the pin of an earlier download) and reuses that install with no network, so a host that starts without `download` no longer reports a downloaded runtime as missing; `COPILOT_EGRESS_HOSTS` adds the per-plan API hosts the runtime reads from the account's `endpoints.api` (`api.individual`, `api.business`, `api.enterprise` `.githubcopilot.com`), without which the model listing and every call were refused. `@marinoscar/kvox-contract/copilot`: `CopilotSettingsPatchSchema` (strict, every field optional, no defaults), because `CopilotSettingsSchema.partial()` still applies the defaults under Zod 4 and turned a `{ model }` patch into "Copilot off, no consent".
