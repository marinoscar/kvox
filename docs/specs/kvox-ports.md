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
resolveTask(ctx, task, opts?): Promise<KvoxAiTarget>        // throws KvoxAiError not_configured | key_missing | capability; opts.requireKey false names the model without a key
generateText(ctx, req): AsyncIterable<KvoxTextEvent>        // delta*, then exactly one done
generateStructured<T>(ctx, req): Promise<{ value: T; usage }>
chat(ctx, req): AsyncIterable<KvoxChatEvent>                // delta | tool_call, then step_end, then exactly one done
embed(ctx, { inputs }): Promise<{ model; dimensions; vectors }>
countTokens(target, text): number
```

- A failure is always a `KvoxAiError` with an `errorClass`: `auth`, `refusal`, `rate_limit` (with `retryAfterMs`), `budget` (`KvoxAiBudgetError` carries `required` and `available`), `timeout`, `not_configured`, `key_missing`, `capability`, `other`. The graph slices (issue #496) added two classes, `truncated` (the answer hit the output ceiling; a caller may re-ask smaller) and `invalid_output` (the model's answer was not the requested JSON), and a `usage` field: a failed structured call is still billed, so the error carries what it consumed. The context takes an optional `jobId` so a usage row links to the queue job, `generateStructured` takes a strict `jsonSchema` (what the vendor is held to, beside the Zod `schema` the caller validates with) and `maxOutputTokens`.
- **A key never crosses the port.** The context carries a user id, an organization and a feature. The adapter resolves the user's own key on its side and drops it after the call. No event, error message or capability holds a key-shaped string (`sk-...`, `ghp_`, `gho_`, `github_pat_`); the web adapter scrubs messages as a backstop and the conformance suite scans everything it sees.
- `chat` is one model step. The caller owns the loop and sends the whole history each time. After a `tool_call` of a step, no text of that step is yielded (the web adapter drops it; the Ask handler holds and discards such text for the same reason). The `done` event carries an optional `finishReason` (`stop`, `length` when the output ceiling cut the step off, `content_filter` when the provider declined to finish it; absent means `stop`), which the Ask handler maps to `token_cap` and a `refusal` failure. The Ask slice (issue #497) drives its whole turn on `resolveTask`, `capabilities`, `countTokens` and this stream, so any adapter that passes the ports kit and `describeAskConformance` runs Ask.
- `KvoxAiFeature` names the call site (`notes.generate`, `notes.title`, `transcripts.name_check`, `search.embed`, `graph.extract`, `graph.adjudicate`, `graph.digest`, `graph.embed`, `ask.respond`). The web adapter maps them to the ids registered with the platform (`note_generate`, `note_retitle`, ...); those ids are persisted in usage rows and never renamed.
- `KvoxAiTarget.reasoningEffort` is `none | low | medium | high | xhigh`, the vocabulary of the token budget, which adds reasoning headroom to a finite answer cap.

### 3.2 KVOX_OBJECT_STORE

`initUpload`, `signParts`, `completeUpload`, `abortUpload`, `put`, `adopt`, `describe`, `setMetadata`, `openRead`, `head`, `signedDownloadUrl`, `delete`, `onUploaded`, `onAborted`.

- Every object has an owning module (`transcripts`, `notes`, `graph`). The web adapter stamps it in the `kvox_object_ownership` side table in the same transaction as the object row, through `KvoxManagedObjects` (the only code that reads `storage_objects`). `listManaged({ ownerId, managedBy, keyPrefix, limit })` answers the ids of the owner's objects stored by one module under a key prefix, ascending (the graph's purge sweeps the owner's uploaded import files with it).
- `put` and `openRead` move streams; a stream is never collected whole in the adapter. The web `put` counts bytes as they pass, uploads them, writes the row, and takes the bytes back if the row fails.
- `put` is idempotent on its key (a retry of a job that already stored and recorded the bytes answers the first object) and takes an optional display `name` and `metadata`. `adopt` records an object whose bytes a worker node already PUT at a key (idempotent on the key; it throws `KvoxObjectMissingError` when the bytes never landed). `describe(ids)` answers `{ id, name, mimeType, size, state, createdAt, updatedAt, ownerId?, managedBy?, metadata? }` (the uploader, the owning module and the stored data) for every id it knows in ONE call and leaves the unknown ones out of the map; a caller that reads many objects must not loop `head`. `setMetadata(id, metadata)` replaces the data stored with an object (the notes slice records an extraction result on the source document). `initUpload` takes the content types the owning module accepts (`allowedMimeTypes`) and returns `uploadId` and `totalParts` beside the first batch of parts.
- `delete` and `abortUpload` are idempotent. `head` answers `null` for a missing object. `onAborted` fires once for a cancelled upload, after the abort commits.
- `onUploaded` fires once per completed upload, but not necessarily inside `completeUpload`: the web edition registers one `ObjectProcessor` with the platform registry, which runs in the server-only `storage.object.process` job. A handler decides from `managedBy` whether the object is its own.

### 3.3 KVOX_JOBS

`enqueue(input)` returns `{ id, deduplicated }`; `enqueueWithin(tx, input)` is the same inside the caller's open transaction (so a row and its job commit together or not at all; `tx` is the client of the host's `$transaction` callback); `registerHandler(handler)`; `isRegistered(type)`; `onSettled(listener)`; `findActive(query)`; `tempPath(suffix?)`. `findLatest({ type, subjectType, subjectId? })` answers the most recent job as a snapshot (`status`, `createdAt`, `finishedAt`) or `null`, and `runNow(jobId)` asks the queue to run a pending job at once (`false` when it already settled); the graph overview uses both.

- `findActive({ types, subjectType?, subjectIds?, payloadKey?, payloadValues?, excludeJobId? })` lists the pending or running jobs that match: the way a handler or a sweep sees queue state (a transcript with no live poll job, a name check whose job is gone, a sweep already queued). `onSettled` reports every job that reaches `succeeded` or `failed` with its type, subject, payload and last error; a listener only decides whether work is due (queue rule 1). `tempPath` is a path in the job's scratch space, swept by the host.
- Two pending or running jobs with the same `type`, `subjectType` and `subjectId` collapse into one unless `skipDedup` is set (a job that re-enqueues itself, such as `transcription.poll`, must pass it).
- `KvoxJobHandler` has exactly the platform handler's fields: `type`, `label`, `profile` (`{ maxRuntimeMs, maxAttempts }` only; never a lease or heartbeat field), `nodeResultSchema` and `persistNodeResult` together, `deriveOutputKey` (where a node's output upload lands) and `nodeOffloadEnabled` (the runtime switch for offering the type to nodes), and `process`. `usesAi` and `throttleKey` (the ONE deployment-wide provider bucket the type draws on, as the three transcription types do) are read by the adapter only.
- A job `type` is permanent once jobs of it exist. The web adapter registers exactly the strings pinned by `apps/api/test/jobs/job-type-snapshot.spec.ts`.
- A handler defers a job with `KvoxRateLimitError(throttleKey, retryAfterMs)`. The web adapter turns it into the platform `RateLimitError`, the only thing the queue defers on, after registering the bucket. The error also answers the queue's `jobs.classifyRateLimit` self-classification (`KVOX_CLASSIFY_RATE_LIMIT`), so a handler registered with the platform queue directly defers on it too. The throttle key given at `enqueue` is recorded on the job row and registered per job immediately before the handler runs. For AI work the bucket is per user (`aiProviderThrottleKey(userId)`), never shared; the transcription provider's bucket is one shared key on purpose (`TRANSCRIPTION_THROTTLE_KEY`).
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

The host's client, seen through `KvoxPrismaClientLike` (`$queryRaw`, `$executeRaw`, `$transaction`). `$transaction` takes an interactive callback or an array of prepared queries, with optional `timeout` and `isolationLevel`. A slice never imports a generated client: it narrows the port with the delegates it uses (a row interface per table and loose-argument delegates with fixed result types, so the host's generated client stays assignable; `apps/api/test/kvox/prisma-shape.typecheck.ts` proves it) and builds SQL with the `Prisma` helper of `core` (`sql`, `raw`, `join`, `empty` from `@prisma/client-runtime-utils`, an optional peer loaded on first use). Both hosts run PostgreSQL, so slices keep `tsvector`, `tstzrange`, `pg_trgm` and `vector`. A generated client behind the port is out of scope (Epic 6). The transaction options also take `maxWait` (how long to wait for a connection from the pool).

### 3.8 KVOX_SETTINGS

`registerNamespace`, `readSystem` / `patchSystem` (versioned, `ifMatchVersion`) and `readUser` / `patchUser`, for the system `transcription` namespace and the per-user `graph` preferences. A third namespace is READ and never declared by a slice: the system `ai` namespace (`maxInputTokens`, `maxOutputTokens`, `maxDocumentBytes`, optional, `null` for the model's own limit), the deployment's AI spend caps that the notes, transcripts (name check) and graph slices feed into the token budget. The host declares it (in the web edition it is the platform AI slice's); a host that does not gets a 500 from `POST /api/notes` (`Unknown system settings namespace "ai"`). Found by the bare-host smoke app (issue #505, `examples/bare-host`). Reading `graphEnabled` (the connected-knowledge switch; `false` or absent makes every graph AI route answer 409 `graph_disabled` and no digest is queued) and `reasoningEffort` from the same namespace is the graph slices' (`GraphAiRunResolver`), so a host that installs the graph declares both beside the three caps (found while writing the Desktop guide, issue #506; the bare host declares all five and turns `graphEnabled` on in `seedRuntime`, issue #573). **Defaults semantics:** a namespace registered with `defaults: undefined` (the graph slice's per-user `graph` namespace: absent means the slice's own defaults) must read as `undefined` when unwritten and must not be schema-parsed; only a stored value is parsed (`parsedOrDefaults` in `examples/bare-host/src/ports/file-settings.ts`). A port that parses the defaults throws "expected object, received undefined". The ports conformance kit does not test this yet. `readSystem(name, { withUpdatedBy: true })` also returns `updatedAt` and `updatedBy` (who last changed the row), for an admin screen; the web adapter reads them from the `global` row only when asked, and a host that keeps no such record ignores the option. The web adapter's read is read-only: it never creates the settings row (a missing row reads as the defaults at version 0). The web adapter does not declare a namespace: the platform composes its settings request bodies and OpenAPI from registries that freeze when the application is created, so `registerNamespace` verifies the namespace is already registered (`app-registrations/settings.ts`) and throws a clear error otherwise.

### 3.9 KVOX_SECRETS

`registerPurpose`, `get`, `set`, `delete`, `status`. The web adapter stores secrets in the platform's encrypted credential store; a purpose is also its sub-key domain, so a purpose is never renamed. `set` takes an optional non-secret `label` stored beside the value (the credential listing shows it). `status` returns `{ configured, hint, updatedAt, updatedByUserId? }` and never material. A user's AI key is not here: it is per user and resolved by the AI port.

### 3.10 KVOX_AUDIT

`record(event)`. The web adapter writes `audit_events` through the platform sink, which takes scalar `meta`; a non-scalar value is stored as its JSON text.

### 3.11 KVOX_BRAND

Not a port to implement but a value a host provides through `KvoxPortsModule.forRoot({ brand })`: `{ appName, appSlug }`, the product name a slice prints where a document carries one (the PDF export footer) and the slug it builds names from. A slice injects it `@Optional()` and falls back to `DEFAULT_KVOX_BRAND`, so no slice names a product.

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

`describeKvoxPortsConformance(name, factory, { describe, it, expect })` (Jest or Vitest) registers one `it` per rule. The factory returns the ports under test plus hooks the suite cannot invent: `failNextWith(errorClass)`, `arrangeTextAfterToolCall()`, an anonymous and an authenticated execution context, `uploadParts(init, size)` for a store that checks its parts at `completeUpload`, the settings namespaces the host knows, a secrets purpose. A rule whose hook is absent is skipped; a port the factory omits fails its section unless named in `options.skip`.

The rules: AI errors are `KvoxAiError`s of a known class with no key in the message, `capabilities()` never throws, `generateText` and `chat` end with exactly one `done`, no text follows a tool call, `embed` returns one vector per input of the reported width; the object store round-trips bytes, takes a 6 MiB stream pulled in order, is idempotent on a key, describes the objects it holds (with their owner and owning module) and replaces their stored data, signs, deletes idempotently and fires `onUploaded` and `onAborted` once; jobs return `{ id, deduplicated }`, collapse a repeat, honour `skipDedup`, list their active jobs, report a settled job, hand out distinct temp paths, run a registered handler once per distinct job and report an unknown type unregistered; identity answers `null` without credentials, a `ReadonlySet` of permissions with them; `notify` returns at once; events deliver until unsubscribed and survive a throwing listener; settings and secrets round-trip and `status` never returns material.

It runs against the fakes (`packages/kvox-api/test/ports-conformance.spec.ts`) and against the web adapters (`apps/api/test/platform-kvox/ports-conformance.spec.ts`: the real adapters over the real platform registries and `createFakeJobQueue`, with in-memory stand-ins for the services behind them). The adapters' own rules (error translation, the AI-job refusal, rate-limit plumbing, object cleanup, the identity trap, the boot failure) are in `platform-kvox-adapters.spec.ts`, and `kvox-auth.integration.spec.ts` drives `@KvoxAuth` through the real guard stack (401 with no token, 403 for a Viewer without the permission, 200 otherwise, and a permissionless route that still gets a full principal).

## 6. Desktop mapping notes (the Copilot SDK adapter is documented, not built, here)

- `chat` maps to a Copilot session with the tool definitions registered; a session turn is one step, `step_end` marks it.
- `generateStructured` maps to a prompt plus JSON Schema validation with one repair retry inside the adapter; the port still returns a value validated against the caller's Zod schema or throws `KvoxAiError('other')`.
- If the SDK offers no embeddings, `capabilities().embeddings` is `null` and search answers with full-text only and the reason `embeddings_unavailable` (added to `SEMANTIC_REASONS` by the search slice, issue #494; a model whose vectors are not 1536 wide, the width of the index column, gets the same answer and a one-time warning). The search slice also needs a rule for which transcripts a user may see, which is not a port but an option of `SearchModule.forRoot` (`transcriptVisibility`); the Desktop default is the owner's own.
- Keys are the user's Copilot sign-in. They are never stored by a slice and never cross the port.
- `KVOX_OBJECT_STORE` maps to the local filesystem (the same ownership tag in a table), `KVOX_JOBS` to an in-process queue on a table with the same dedup and attempts rules, `KVOX_IDENTITY` to one local user, `KVOX_NOTIFY` to operating-system notifications, `KVOX_SECRETS` to the keychain, `KVOX_EVENTS` to `KvoxEventEmitterEvents`.
- The full walk-through, with a sketch of the Copilot adapter mapped method by method, is the [KVox Desktop guide](../guides/kvox-desktop.md).

### 6.1 What the bare host and the Desktop guide added (issues #505, #506)

The first host that is not the web edition ([examples/bare-host](../../examples/bare-host/README.md), the Desktop consumer guide [guides/kvox-desktop.md](../guides/kvox-desktop.md)) found these. Each is written where the next host reads it:

- **Four host tables, not three.** The domain references `users`, `organizations`, `storage_objects` and `jobs`. `transcripts.org_id` and `storage_objects.org_id` are NOT NULL, so the host adopts the default organization the platform migrations create and puts its id in the principal. `organizations` joined `KVOX_HOST_TABLES` in `@marinoscar/kvox-db`.
- **The `ai` system namespace** (section 3.8) and **three host duties no port states**: a global `ZodValidationPipe` (the transcription settings controller takes a `nestjs-zod` DTO), the upload-completion route (nothing else seals an upload: `POST /api/transcripts` answers with part URLs only), and a Fastify content-type parser for binary upload parts.
- **A job is a real `jobs` row.** `kg_proposals.job_id`, `ask_messages.job_id` and `kg_exports.job_id` reference it, and dedup is the platform's partial unique index `jobs_active_dedup_uniq_idx`, so a host queue is an in-process runner over that table (`examples/bare-host/src/ports/pg-table-jobs.ts`), not a memory queue. `transcription.poll` re-enqueues itself with `skipDedup`. What that runner leaves to the host: `maxRuntimeMs` enforcement, a back-off between attempts, and resetting a `running` row after a crash.
- **A rate limit reaches the queue in two steps.** An adapter throws `KvoxAiError('rate_limit', message, retryAfterMs)`; the slice's handler turns it into `KvoxRateLimitError` on the user's own throttle bucket, which the queue defers without spending an attempt. An adapter does not throw `KvoxRateLimitError` itself.
- **Object rows keep the owning module.** The web edition stores `managedBy` in the `kvox_object_ownership` side table; the bare host keeps it as a reserved key of `storage_objects.metadata`. Either is conformant.
- **Row-level security.** `storage_objects` is under forced RLS. A host that connects as a superuser bypasses it; a host that connects as an ordinary role sets `app.org_id` (or `app.rls_bypass`) per transaction.
- **Fixes in the packages the bare host forced:** `transcripts.org_id` was missing from the package's history (migration `20261016120000_transcripts_org_id`); the PDF exporters' declaration files named pdfkit (now `KvoxPdfDocument`); a provider registered through `extraProviders` resolved no settings block and failed every job.
- **PGlite is a supported embedded database.** The whole history applies; it needs `uuid_ossp` loaded beside `vector` and `pg_trgm`, a pool of one connection, and (over a socket) tolerance of one `Connection terminated unexpectedly` after an SQL error. See the [kvox-db README](../../packages/kvox-db/README.md#data).
- **Not exercised yet (ports).** The conformance kit `describeKvoxPortsConformance` runs against the fakes and the web adapters; the bare host runs it too, against its local object store, jobs, identity, settings and secrets (`examples/bare-host/test/ports-conformance.test.ts`), and `examples/bare-host/test/local-ports.test.ts` holds those ports to the rules the kit does not state.

#### Graph, graph-extraction, graph-rdf and Ask (issue #573, epic #574)

The bare host now mounts all four over the shared transcripts, notes and search modules (`examples/bare-host/src/app.module.ts`, test `test/graph-ask.e2e.test.ts`). It found these host duties; each names the file that implements it.

1. **The `ai` namespace declares `graphEnabled` and `reasoningEffort`**, beside `maxInputTokens`, `maxOutputTokens` and `maxDocumentBytes`. Absent or false, every graph AI route answers 409 `graph_disabled` and digests are never queued. `GraphAiRunResolver` reads `reasoningEffort` (the host uses `'none'`). The host turns `graphEnabled` on in `seedRuntime` (`src/bootstrap.ts`, `src/seed.ts`).
2. **Settings semantics for `defaults: undefined`** (section 3.8): `src/ports/file-settings.ts`.
3. **`@fastify/multipart` is the host's plugin.** `POST /api/graph/imports` and the notes document-source upload read `request.file()`. No slice registers it and none lists it as a peer (`packages/kvox-slice-peers.json`), so `check-slice-peers` cannot catch its absence (`src/bootstrap.ts`).
4. **The `kg.graph_layout` peers are required in practice**: `graphology`, `graphology-communities-louvain`, `graphology-layout`, `graphology-layout-forceatlas2`. Any `GET /api/graph/overview` on a non-empty graph schedules the layout job (`package.json`).
5. **RDF peers**: `n3`, `jsonld`, `rdf-validate-shacl`. SHACL validation runs in a child node process (`package.json`).
6. **Four enqueuers to tick** with `schedules: false` on transcripts, notes, graph and graph-rdf: `TranscriptsHousekeepingEnqueuer`, `NotesHousekeepingEnqueuer`, `KgMigrateEnqueuer` and `KgExportExpiryEnqueuer` (the last exists only while `export` is on). Resolve each with `app.get(T, { strict: false })`. `@nestjs/schedule` stays uninstalled (`src/housekeeping.ts`).
7. **`KVOX_AI` must answer structured output** under the schema names `kg_extraction`, `kg_adjudication`, `kg_item_adjudication` and `entity_digest`. An entity digest with no surviving citation fails the job. With `embeddings: null`, resolution works by name only and `kg.embed` jobs are no-ops (`src/fake-ai.ts`, `src/graph-scenario.ts`). The Ask loop needs `chat` with tool calling.
8. **`autoExtract: false`** keeps extraction on the explicit route `POST /api/graph/notes/:noteId/extract`. With it on, every ready note spends the user's AI quota.

Known package gaps (not host duties, open):

- `@fastify/multipart` is missing from the slice peers data (duty 3).

## 7. Out of scope

Moving any domain controller, service or handler into the package (Epic 6, which also switches each slice to inject ports); a generated Prisma client behind `KVOX_PRISMA`; the Copilot SDK adapter and any Desktop code.
