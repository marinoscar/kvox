---
"@marinoscar/kvox-ai": minor
---

Copilot sign-in, runtime lifecycle and capability-based routing, so hosts carry no Copilot mechanics (#630). `@marinoscar/kvox-ai/copilot`: `adapter.signIn.start()/wait()` and `adapter.signOut()` over new `CopilotTransport.startSignIn/waitForSignIn/signOut` (the SDK's experimental account RPCs; no token crosses KVox code; the scriptable mock gains `scriptSignIn`), `prepareCopilotRuntime` (app-private directories, empty working directory, bundled runtime preferred, opt-in download only from allowed hosts with a SHA-256 check) and `COPILOT_EGRESS_HOSTS`. Package root: `routeKvoxTasks`, which sends tasks that need tool calling (`ask.respond`) or embeddings to a fallback provider and reports the rest as unavailable.
