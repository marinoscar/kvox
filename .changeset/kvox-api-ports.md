---
"@marinoscar/kvox-api": minor
---

Publish the host ports of the domain: `@marinoscar/kvox-api/ports` (the interfaces and `Symbol.for` tokens `KVOX_AI`, `KVOX_OBJECT_STORE`, `KVOX_JOBS`, `KVOX_IDENTITY`, `KVOX_NOTIFY`, `KVOX_EVENTS`, `KVOX_PRISMA`, `KVOX_SETTINGS`, `KVOX_SECRETS` and `KVOX_AUDIT`), `@marinoscar/kvox-api/core` (`KvoxPortsModule.forRoot`, `@KvoxAuth()`, `CurrentKvoxPrincipal`, `KvoxAuthGuard`, and the helpers the API's slices shared across each other: the per-user AI throttle key, the token budget, the stream flusher and SSE helpers, the ETag helpers, `KvoxEventEmitterEvents`, the `Prisma` SQL helper) and `@marinoscar/kvox-api/testing` (an in-memory fake of every port, `createKvoxTestingModule` and `describeKvoxPortsConformance`, which works under Jest and Vitest).
