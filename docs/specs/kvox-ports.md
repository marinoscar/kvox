# The host ports of the domain packages

Status: implemented (issue #490, epic #486). Source of truth for the code: `packages/kvox-api/src/ports/` (interfaces and tokens), `src/core/` (the module and the shared helpers), `src/testing/` (fakes and the conformance suite), and the web edition's adapters in `apps/api/src/platform-kvox/`. Per-slice reference: [ports](../../packages/kvox-api/src/ports/README.md), [core](../../packages/kvox-api/src/core/README.md), [testing](../../packages/kvox-api/src/testing/README.md). Package standard: [PACKAGES.md](../PACKAGES.md).

## 1. Why ports

The domain (transcription, transcripts, search, notes, the graph, Ask) is being packaged as `@marinoscar/kvox-api` slices so a second host, the Desktop edition, can install it: offline, an embedded PostgreSQL, the GitHub Copilot SDK for AI, no platform. A count of the imports from outside each domain folder, taken before the platform adoption, showed ten kinds of need: the database, request identity, jobs, AI, storage, notifications, settings, secrets, events and audit. A packaged slice must not import any platform package, so each need became a port: an interface and an injection token in `@marinoscar/kvox-api/ports`, bound by the host.

The web edition binds each port to a platform slice in `apps/api/src/platform-kvox/` (the only place that names `@marinoscar/platform-*` for these ports). The rule is executable: `npm run check:kvox-slice-peers` fails with `[host-neutral]` when a file under the package imports the platform.

## 2. Tokens and binding

A token is `Symbol.for('@marinoscar/kvox/<NAME>')`. The description string is permanent: two copies of the package agree on a token only when the strings match.

| Token | Port | Required |
|---|---|---|
| `KVOX_AI` | `KvoxAiPort` | yes |
| `KVOX_OBJECT_STORE` | `KvoxObjectStorePort` | yes |
| `KVOX_JOBS` | `KvoxJobsPort` | yes |
| `KVOX_IDENTITY` | `KvoxIdentityPort` | yes |
| `KVOX_NOTIFY` | `KvoxNotifyPort` | yes |
| `KVOX_PRISMA` | `KvoxPrismaClientLike` | yes |
| `KVOX_SETTINGS` | `KvoxSettingsPort` | yes |
| `KVOX_SECRETS` | `KvoxSecretsPort` | yes |
| `KVOX_EVENTS` | `KvoxEventsPort` | no (default: in-process emitter) |
| `KVOX_AUDIT` | `KvoxAuditPort` | no (default: no-op) |

`KvoxPortsModule.forRoot({ ports })` (in `core`, because its default `KVOX_EVENTS` is a `core` class and `ports` may not import `core`) is global. Each entry is a Nest custom provider without the token: `useClass`, `useExisting`, `useValue` or `useFactory`. It throws when called, so at start-up, naming every required port left unbound (`no binding for ports KVOX_JOBS (ports.jobs), KVOX_SECRETS (ports.secrets)`). The web edition's call is `apps/api/src/platform-kvox/platform-kvox.module.ts`, imported by `AppModule` before every domain module; a test builds the module with a binding removed and asserts the message.

The existing app token `KVOX_AI` in `apps/api/src/ai-port/kvox-ai.ts` is a different symbol (`Symbol.for('<app slug>/KVOX_AI')`) for a different, wider interface: the app's `KvoxAi` facade. The port adapter wraps that facade, so the app's own services keep injecting the facade and the packaged slices inject the port.

## 3. The ports

### 3.1 KVOX_AI

```ts
capabilities(ctx): Promise<KvoxAiCapabilities>             // never throws
resolveTask(ctx, task, opts?): Promise<KvoxAiTarget>        // throws KvoxAiError not_configured | key_missing | capability
generateText(ctx, req): AsyncIterable<KvoxTextEvent>        // delta*, then exactly one done
generateStructured<T>(ctx, req): Promise<{ value: T; usage }>
chat(ctx, req): AsyncIterable<KvoxChatEvent>                // delta | tool_call, then step_end, then exactly one done
embed(ctx, { inputs }): Promise<{ model; dimensions; vectors }>
countTokens(target, text): number
```

- A failure is always a `KvoxAiError` with an `errorClass`: `auth`, `refusal`, `rate_limit` (with `retryAfterMs`), `budget` (`KvoxAiBudgetError` carries `required` and `available`), `timeout`, `not_configured`, `key_missing`, `capability`, `other`.
- **A key never crosses the port.** The context carries a user id, an organization and a feature. The adapter resolves the user's own key on its side and drops it after the call. No event, error message or capability holds a key-shaped string (`sk-...`, `ghp_`, `gho_`, `github_pat_`); the web adapter scrubs messages as a backstop and the conformance suite scans everything it sees.
- `chat` is one model step. The caller owns the loop and sends the whole history each time. After a `tool_call` of a step, no text of that step is yielded (the web adapter drops it; the Ask handler holds and discards such text for the same reason).
- `KvoxAiFeature` names the call site (`notes.generate`, `notes.title`, `transcripts.name_check`, `search.embed`, `graph.extract`, `graph.adjudicate`, `graph.digest`, `graph.embed`, `ask.respond`). The web adapter maps them to the ids registered with the platform (`note_generate`, `note_retitle`, ...); those ids are persisted in usage rows and never renamed.
- `KvoxAiTarget.reasoningEffort` is `none | low | medium | high | xhigh`, the vocabulary of the token budget, which adds reasoning headroom to a finite answer cap.

### 3.2 KVOX_OBJECT_STORE

`initUpload`, `signParts`, `completeUpload`, `abortUpload`, `put`, `openRead`, `head`, `signedDownloadUrl`, `delete`, `onUploaded`.

- Every object has an owning module (`transcripts`, `notes`, `graph`). The web adapter stamps it in the `kvox_object_ownership` side table in the same transaction as the object row, through `KvoxManagedObjects` (the only code that reads `storage_objects`).
- `put` and `openRead` move streams; a stream is never collected whole in the adapter. The web `put` counts bytes as they pass, uploads them, writes the row, and takes the bytes back if the row fails.
- `delete` and `abortUpload` are idempotent. `head` answers `null` for a missing object.
- `onUploaded` fires once per completed upload, but not necessarily inside `completeUpload`: the web edition registers one `ObjectProcessor` with the platform registry, which runs in the server-only `storage.object.process` job. A handler decides from `managedBy` whether the object is its own.

### 3.3 KVOX_JOBS

`enqueue(input)` returns `{ id, deduplicated }`; `registerHandler(handler)`; `isRegistered(type)`.

- Two pending or running jobs with the same `type`, `subjectType` and `subjectId` collapse into one unless `skipDedup` is set (a job that re-enqueues itself, such as `transcription.poll`, must pass it).
- `KvoxJobHandler` has exactly the platform handler's fields: `type`, `label`, `profile` (`{ maxRuntimeMs, maxAttempts }` only; never a lease or heartbeat field), `nodeResultSchema` and `persistNodeResult` together, and `process`. `usesAi` is read by the adapter only.
- A job `type` is permanent once jobs of it exist. The web adapter registers exactly the strings pinned by `apps/api/test/jobs/job-type-snapshot.spec.ts`.
- A handler defers a job with `KvoxRateLimitError(throttleKey, retryAfterMs)`. The web adapter turns it into the platform `RateLimitError`, the only thing the queue defers on, after registering the bucket. The error also answers the queue's `jobs.classifyRateLimit` self-classification (`KVOX_CLASSIFY_RATE_LIMIT`), so a handler registered with the platform queue directly (the transcript handlers, until they move into the package) defers on it too. The throttle key given at `enqueue` is recorded on the job row and registered per job immediately before the handler runs. For AI work the bucket is per user (`aiProviderThrottleKey(userId)`), never shared; the transcription provider's bucket is one shared key on purpose (`TRANSCRIPTION_THROTTLE_KEY`).
- **AI handlers stay server-only.** A handler that calls a model and also declares `nodeResultSchema` is refused at registration (`note.generate`, `note.retitle`, `transcript.name_check`, `search.index`, `ask.respond`, `kg.extract`, `kg.resolve`, `kg.embed`, `kg.entity_digest`, `kg.import`, or any handler with `usesAi`).
- The web adapter passes the default organization's id on every enqueue (single-organization mode).

### 3.4 KVOX_IDENTITY

`authenticate(context)` returns a `KvoxPrincipal` (`userId`, `orgId`, `roles`, `permissions: ReadonlySet<string>`) or `null`; `hasPermission(userId, permission)` reads fresh.

**The permissionless-route trap.** The platform's `PermissionsGuard` attaches its normalised user only on a route that declares a permission. Code that reads that field gives a route with `@Auth()` and no permission an empty principal, silently. The port therefore returns a normalised principal or `null`, and the web adapter derives roles and permissions itself, from `request.principal` (set by `JwtAuthGuard`) falling back to `toRequestUser(request.user)`, the two sources the platform guard consults. `KvoxAuthGuard` reads permissions only from the principal.

`@KvoxAuth(...permissions)` guards a route (401 with no principal, 403 for a missing permission, naming it); `@CurrentKvoxPrincipal()` reads the principal. A service keeps its own 404-not-403 rule for per-resource access. A credential the platform refuses with a 403 (a worker-node token on a domain route) is not turned into a 401: the exception propagates.

### 3.5 KVOX_NOTIFY

`registerEvents(defs)` declares events, idempotent per key; `notify(eventKey, userId, data)` is detached: it returns before delivery and never throws. Call it after the triggering write commits, never inside a transaction. Event keys, channel ids and template names are persisted. The web adapter skips a known key and refuses a new key after the platform registry freezes, so events are declared at import time (`apps/api/src/notifications-registry/`).

### 3.6 KVOX_EVENTS

`emit(name, payload)` and `subscribe(name, handler)` for in-process domain events after commit (`graph.changed`, `transcript.speakers_identified`). The web adapter publishes on the host core's event bus. With the `postgres` bus adapter an event reaches every replica, so a listener must be idempotent and only decide whether work is due and enqueue it (queue rule 1); names are lower-case and dotted, payloads JSON.

### 3.7 KVOX_PRISMA

The host's client, seen through `KvoxPrismaClientLike` (`$queryRaw`, `$executeRaw`, `$transaction`). A slice never imports a generated client: it narrows the port with the delegates it uses and builds SQL with the `Prisma` helper of `core` (`sql`, `raw`, `join`, `empty` from `@prisma/client-runtime-utils`, an optional peer loaded on first use). Both hosts run PostgreSQL, so slices keep `tsvector`, `tstzrange`, `pg_trgm` and `vector`. A generated client behind the port is out of scope (Epic 6).

### 3.8 KVOX_SETTINGS

`registerNamespace`, `readSystem` / `patchSystem` (versioned, `ifMatchVersion`) and `readUser` / `patchUser`, for the system `transcription` namespace and the per-user `graph` preferences. `readSystem(name, { withUpdatedBy: true })` also returns `updatedAt` and `updatedBy` (who last changed the row), for an admin screen; the web adapter reads them from the `global` row only when asked, and a host that keeps no such record ignores the option. The web adapter's read is read-only: it never creates the settings row (a missing row reads as the defaults at version 0). The web adapter does not declare a namespace: the platform composes its settings request bodies and OpenAPI from registries that freeze when the application is created, so `registerNamespace` verifies the namespace is already registered (`app-registrations/settings.ts`) and throws a clear error otherwise.

### 3.9 KVOX_SECRETS

`registerPurpose`, `get`, `set`, `delete`, `status`. The web adapter stores secrets in the platform's encrypted credential store; a purpose is also its sub-key domain, so a purpose is never renamed. `set` takes an optional non-secret `label` stored beside the value (the credential listing shows it). `status` returns `{ configured, hint, updatedAt, updatedByUserId? }` and never material. A user's AI key is not here: it is per user and resolved by the AI port.

### 3.10 KVOX_AUDIT

`record(event)`. The web adapter writes `audit_events` through the platform sink, which takes scalar `meta`; a non-scalar value is stored as its JSON text.

## 4. The `core` helpers and the cycles they cut

| Helper | Was | Now |
|---|---|---|
| `aiProviderThrottleKey`, `TRANSCRIPTION_THROTTLE_KEY` | `notes/job-types.ts`, `transcripts/job-types.ts` | `core/ai/throttle.ts`; both files re-export |
| `computeTokenBudget`, `outputTokensForPrompt`, `budgetRefusalMessage`, `assertWithinBudget` | `ai-port/ai-token-budget.ts` (moved out of notes in #459) | `core/ai/token-budget.ts` throwing `KvoxAiBudgetError`; the app file re-exports and keeps its `assertWithinBudget` throwing `AiBudgetError` |
| `StreamFlusher` | `notes/generation/stream-flusher.ts` | `core/stream/stream-flusher.ts`; the file re-exports |
| `NoteStreamCursor`, `resolveStreamOffset`, `parseLastEventId`, frame builders | `notes/generation/note-stream.ts` | `core/stream/sse-stream.ts` (`KvoxStreamCursor`, with `NoteStreamCursor` as a deprecated alias); the file re-exports under the old names |
| `versionETag`, `matchesETag` | `transcripts/transcripts.controller.ts` | `core/http/etag.ts`; the controller re-exports |

The importers in `transcripts`, `search`, `graph` and `ask` now import `@marinoscar/kvox-api/core`, so none of them imports the notes slice or the transcripts controller for these helpers. Behaviour is unchanged: the moved code and its comments are byte-for-byte, and the original specs still run through the re-exports. Cycles that remain (`notes` importing `GraphExtractionModule`, graph importing the note access service) belong to Epic 6.

## 5. The conformance suite

`describeKvoxPortsConformance(name, factory, { describe, it, expect })` (Jest or Vitest) registers one `it` per rule. The factory returns the ports under test plus hooks the suite cannot invent: `failNextWith(errorClass)`, `arrangeTextAfterToolCall()`, an anonymous and an authenticated execution context, the settings namespaces the host knows, a secrets purpose. A rule whose hook is absent is skipped; a port the factory omits fails its section unless named in `options.skip`.

The rules: AI errors are `KvoxAiError`s of a known class with no key in the message, `capabilities()` never throws, `generateText` and `chat` end with exactly one `done`, no text follows a tool call, `embed` returns one vector per input of the reported width; the object store round-trips bytes, takes a 6 MiB stream pulled in order, signs, deletes idempotently and fires `onUploaded` once; jobs return `{ id, deduplicated }`, collapse a repeat, honour `skipDedup`, run a registered handler once per distinct job and report an unknown type unregistered; identity answers `null` without credentials, a `ReadonlySet` of permissions with them; `notify` returns at once; events deliver until unsubscribed and survive a throwing listener; settings and secrets round-trip and `status` never returns material.

It runs against the fakes (`packages/kvox-api/test/ports-conformance.spec.ts`) and against the web adapters (`apps/api/test/platform-kvox/ports-conformance.spec.ts`: the real adapters over the real platform registries and `createFakeJobQueue`, with in-memory stand-ins for the services behind them). The adapters' own rules (error translation, the AI-job refusal, rate-limit plumbing, object cleanup, the identity trap, the boot failure) are in `platform-kvox-adapters.spec.ts`, and `kvox-auth.integration.spec.ts` drives `@KvoxAuth` through the real guard stack (401 with no token, 403 for a Viewer without the permission, 200 otherwise, and a permissionless route that still gets a full principal).

## 6. Desktop mapping notes (the Copilot SDK adapter is documented, not built, here)

- `chat` maps to a Copilot session with the tool definitions registered; a session turn is one step, `step_end` marks it.
- `generateStructured` maps to a prompt plus JSON Schema validation with one repair retry inside the adapter; the port still returns a value validated against the caller's Zod schema or throws `KvoxAiError('other')`.
- If the SDK offers no embeddings, `capabilities().embeddings` is `null` and search answers with full-text only (`SEMANTIC_REASONS` already models that degradation).
- Keys are the user's Copilot sign-in. They are never stored by a slice and never cross the port.
- `KVOX_OBJECT_STORE` maps to the local filesystem (the same ownership tag in a table), `KVOX_JOBS` to an in-process queue on a table with the same dedup and attempts rules, `KVOX_IDENTITY` to one local user, `KVOX_NOTIFY` to operating-system notifications, `KVOX_SECRETS` to the keychain, `KVOX_EVENTS` to `KvoxEventEmitterEvents`.

## 7. Out of scope

Moving any domain controller, service or handler into the package (Epic 6, which also switches each slice to inject ports); a generated Prisma client behind `KVOX_PRISMA`; the Copilot SDK adapter and any Desktop code.
