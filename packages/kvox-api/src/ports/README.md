# ports

The host ports of `@marinoscar/kvox-api`: the interfaces and injection tokens through which a domain slice reaches everything outside the domain.

## Purpose and scope

One port per outside responsibility. A slice depends on these and on nothing of a host, so the web edition (the platform, bound in `apps/api/src/platform-kvox/`) and Desktop (local adapters) both bind them. This slice imports no `@marinoscar/platform-*` package, and no Nest runtime code: `ExecutionContext` is a type-only import. The tokens are `Symbol.for('@marinoscar/kvox/<NAME>')`; the description strings are permanent, because two copies of the package agree on a token only if they match.

Status: experimental. Every declaration is `@stability experimental` until the first stable release.

Binding the ports is `KvoxPortsModule.forRoot({ ports })` from [`@marinoscar/kvox-api/core`](../core/README.md#purpose-and-scope); the in-memory fakes and the conformance kit that proves a binding are in [`@marinoscar/kvox-api/testing`](../testing/README.md#purpose-and-scope). The contract in prose, with the Copilot SDK mapping notes: [docs/specs/kvox-ports.md](../../../../docs/specs/kvox-ports.md).

### KVOX_AI

`capabilities` (never throws), `resolveTask`, streamed `generateText`, `generateStructured`, tool-calling `chat`, `embed`, `countTokens`. A failure is always a `KvoxAiError` with a known `errorClass` (`auth`, `refusal`, `rate_limit`, `budget`, `timeout`, `not_configured`, `key_missing`, `capability`, `other`); `KvoxAiBudgetError` carries both token counts. A text stream ends with exactly one `done`; a chat step ends with `step_end` then one `done`, and yields no text after a `tool_call` of the same step. **A key never crosses this port**: the context carries a user id, the adapter resolves the key on its own side, and no event, error message or capability holds a key-shaped string.

### KVOX_OBJECT_STORE

Resumable upload (`initUpload`, `signParts`, `completeUpload`, `abortUpload`), `put` of a stream or buffer, `openRead`, `head`, `signedDownloadUrl`, `delete`, and the `onUploaded` hook. A stream is never buffered whole. `delete` and `abortUpload` are idempotent. Every object has an owning module (`transcripts`, `notes`, `graph`). `onUploaded` handlers fire once per completed upload, possibly later and on another process.

### KVOX_JOBS

`enqueue` returns `{ id, deduplicated }`; two pending or running jobs of the same `type` and subject collapse unless `skipDedup`. `registerHandler` takes a `KvoxJobHandler` with exactly the platform handler's fields (`type`, `profile` with `maxRuntimeMs` and `maxAttempts` only, `nodeResultSchema` and `persistNodeResult`). A handler throws `KvoxRateLimitError` with a per-user throttle key to defer a job (the transcription provider's key is the deployment's one shared bucket); the error also answers a queue's `jobs.classifyRateLimit` question itself, for handlers a host registers without this port. A job `type` string is permanent. AI handlers stay server-only.

### KVOX_IDENTITY

`authenticate(context)` returns a normalised `KvoxPrincipal` (user id, organization, roles, a `ReadonlySet` of permissions) or `null`; `hasPermission` reads fresh. A slice never reads permissions off a raw user object.

### KVOX_NOTIFY

`registerEvents` declares events (idempotent per key); `notify` is detached, returns at once and never throws. Call it after the triggering write commits, never inside a transaction. Event keys and template names are persisted.

### KVOX_EVENTS

`emit` and `subscribe` for in-process domain events after commit. Optional: the default is an in-process emitter.

### KVOX_PRISMA

The host's Prisma client, seen through `KvoxPrismaClientLike`. A slice narrows it with the delegates it uses and builds raw SQL with the `Prisma` helper of `core`.

### KVOX_SETTINGS

`registerNamespace`, `readSystem` / `patchSystem` (versioned, `If-Match` aware; `readSystem(name, { withUpdatedBy: true })` also returns who last changed the row and when, for an admin screen) and `readUser` / `patchUser` for the namespaces the domain owns. Never a secret. The slices also READ one system namespace they do not declare: `ai` (`maxInputTokens`, `maxOutputTokens`, `maxDocumentBytes`, each optional and `null` for "the model's own limit"), the deployment's AI spend caps, which the notes, transcripts (name check) and graph slices pass through the token budget. The host declares it (the web edition's is the platform AI slice's); a host that does not makes `POST /api/notes` fail with `Unknown system settings namespace "ai"`.

### KVOX_SECRETS

`registerPurpose`, `get`, `set` (with an optional non-secret `label`), `delete`, and `status`, which never returns material (it may name who last changed the secret). A purpose is also its encryption domain: never rename one.

### KVOX_AUDIT

`record` for settings changes and destructive actions. Optional: the default records nothing.

## Entry point

`@marinoscar/kvox-api/ports`. The slice depends on no other slice.

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common` (a type import), `rxjs` and `zod`, all required.

## Configuration

None. A host binds each token with `KvoxPortsModule.forRoot`.

## Extension-point catalog

Every token and its port interface are `@extensionPoint`s: a host implements the interface and binds it to the token. `KvoxPrismaClientLike` is the structural shape of the host's client; `KvoxJobHandler` is what a slice registers with `KVOX_JOBS`.

| Token | Port interface | Web adapter (`apps/api/src/platform-kvox/`) | Desktop |
|---|---|---|---|
| `KVOX_AI` | `KvoxAiPort` | `createKvoxAi` of `@marinoscar/kvox-ai` (`ai/web-kvox-ai.ts`) over `PlatformAiRuntime` (platform `AiService.forUser`) | `createKvoxAi` over `createDirectRuntime`, with the Copilot SDK as an `AiProviderAdapter`; no embeddings means `capabilities().embeddings` is `null` |
| `KVOX_OBJECT_STORE` | `KvoxObjectStorePort` | `object-store/platform-kvox-object-store.adapter.ts` over `KvoxManagedObjects`, `ObjectsService`, `ObjectProcessorRegistry` | local filesystem |
| `KVOX_JOBS` | `KvoxJobsPort`, `KvoxJobHandler` | `jobs/platform-kvox-jobs.adapter.ts` over `JobsService`, `JobHandlerRegistry`, the provider throttle | in-process queue on a table |
| `KVOX_IDENTITY` | `KvoxIdentityPort` | `identity/platform-kvox-identity.adapter.ts` over `JwtAuthGuard` | one local user |
| `KVOX_NOTIFY` | `KvoxNotifyPort` | `notify/platform-kvox-notify.adapter.ts` over `NotificationsService` | operating-system notifications |
| `KVOX_EVENTS` | `KvoxEventsPort` | `events/platform-kvox-events.adapter.ts` over the host core `EVENT_BUS` | `KvoxEventEmitterEvents` over `EventEmitter2` |
| `KVOX_PRISMA` | `KvoxPrismaClientLike` | `useExisting: PrismaService` | the Desktop client on embedded PostgreSQL |
| `KVOX_SETTINGS` | `KvoxSettingsPort` | `settings/platform-kvox-settings.adapter.ts` over the platform settings registries | a local JSON file or table |
| `KVOX_SECRETS` | `KvoxSecretsPort` | `secrets/platform-kvox-secrets.adapter.ts` over `CredentialsService` | the operating-system keychain |
| `KVOX_AUDIT` | `KvoxAuditPort` | `audit/platform-kvox-audit.adapter.ts` over the platform `AUDIT_SINK` | a local log |

### Desktop

Desktop implements every port here. The guide gives each interface with its rules, the bare-host reference class and the Desktop recommendation (the keychain for `KVOX_SECRETS`, operating-system notifications for `KVOX_NOTIFY`, one local user for `KVOX_IDENTITY`). See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#ports-to-implement).
