# @marinoscar/kvox-api

The NestJS side of the KVox domain: the host ports a slice needs, their in-memory fakes and the domain slices (transcription so far). CommonJS, built with `tsc` and decorator metadata.

## Purpose and scope

The domain's server code in slices, one subpath per slice, so a second host (KVox Desktop) can install it without the web edition. A slice imports only `@marinoscar/kvox-api/ports` and `@marinoscar/kvox-contract`, never `@marinoscar/platform-*`: the web edition binds the platform to the ports in the app (`apps/api/src/platform-kvox/`), which keeps the package host-neutral (rule `host-neutral`, [PACKAGES.md](../../docs/PACKAGES.md#the-host-neutral-rule)).

Status: ports, core and testing are in place (issue 5.4) and `transcription` is the first domain slice (issue #492, epic #491); the others follow (`./search`, `./transcripts`, `./notes`, `./graph`, `./graph-extraction`, `./graph-rdf`, `./ask`). Every declaration is `@stability experimental`.

- `@marinoscar/kvox-api/ports`: the ten host ports (AI, object store, jobs, identity, notify, events, Prisma, settings, secrets, audit) and their injection tokens. [README](src/ports/README.md).
- `@marinoscar/kvox-api/core`: `KvoxPortsModule`, `@KvoxAuth()` and `@KvoxAuthFromOptions()`, and the helpers the domain slices share (throttle key, token budget, stream flusher and SSE helpers, ETags, the `Prisma` SQL helper). [README](src/core/README.md).
- `@marinoscar/kvox-api/testing`: in-memory fakes of the ports and `describeKvoxPortsConformance`. [README](src/testing/README.md).
- `@marinoscar/kvox-api/transcription`: `TranscriptionModule.forRoot`, the provider contract and registry, the AssemblyAI provider, the settings and capability services and controllers. [README](src/transcription/README.md).
- `@marinoscar/kvox-api/transcription/testing`: `describeTranscriptionProviderConformance` and `createFakeTranscriptionProvider`. [README](src/transcription/README.md#conformance-suite).

The web edition binds every port to a platform slice in `apps/api/src/platform-kvox/`; the contract in prose, with the Desktop mapping notes, is [docs/specs/kvox-ports.md](../../docs/specs/kvox-ports.md).

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-api@next
```

Install these in the app; the package never bundles its own copy (a second copy of Nest breaks dependency injection). Import slices by their subpath. Which peers you need depends on the slices you import ([the rule](../../docs/PACKAGES.md#peer-dependencies-per-slice)).

Required by every slice (`ports`, `core`, `transcription`):

| Package | Range |
|---|---|
| `@marinoscar/kvox-contract` | `>=0.0.0-0 \|\| >=0.1.0-0` (any release; the four packages ship together, see [the contract peer range](../../docs/PACKAGES.md#the-contract-peer-range)) |
| `@nestjs/common` | `^11.1.12` |
| `@nestjs/core` | `^11.1.12` |
| `reflect-metadata` | `^0.2.2` |
| `rxjs` | `^7.8.1` |
| `zod` | `^4.4.3` |

Optional peers, installed for the features that need them. The three marked "loaded on first use" are required lazily, so importing `core` never needs them:

| Package | Range | Needed by |
|---|---|---|
| `@nestjs/swagger` | `^11.2.5` | `core`: the default bearer-auth marker `documentKvoxAuth` applies (loaded on first use); `transcription`: the controllers' OpenAPI decorators (required by that slice) |
| `@nestjs/event-emitter` | `^3.0.1` | `core`: `KvoxPortsModule` shares Nest's `EventEmitter2` as the default `KVOX_EVENTS` (loaded on first use); listeners |
| `@nestjs/schedule` | `^6.1.0` | reserved for housekeeping tasks (the transcripts slice) |
| `nestjs-zod` | `^5.4.0` | `transcription`: the DTO classes (required by that slice) |
| `@prisma/client-runtime-utils` | `^7.8.0` | `core`: the `Prisma.sql`, `raw` and `join` helpers (loaded on first use) |
| `@marinoscar/platform-api` | `0.1.0-next.5` | no slice: host wiring only (`apps/api/src/platform-kvox`) |

The per-slice data is `packages/kvox-slice-peers.json`; `node scripts/kvox-packages/check-slice-peers.mjs --table` prints it.

## Quick start

A host binds the ports once; a slice then injects a token and imports nothing of the host.

```ts
import { KvoxPortsModule } from '@marinoscar/kvox-api/core';

@Module({
  imports: [
    KvoxPortsModule.forRoot({
      ports: {
        ai: { useClass: MyAiAdapter },
        objectStore: { useClass: MyObjectStoreAdapter },
        jobs: { useClass: MyJobsAdapter },
        identity: { useClass: MyIdentityAdapter },
        notify: { useClass: MyNotifyAdapter },
        prisma: { useExisting: PrismaService },
        settings: { useClass: MySettingsAdapter },
        secrets: { useClass: MySecretsAdapter },
      },
    }),
  ],
})
export class AppModule {}
```

A route is protected with `KvoxAuth('transcripts:read')` and reads the caller with `CurrentKvoxPrincipal()`. A test builds a module of fakes with `createKvoxTestingModule` from `@marinoscar/kvox-api/testing`. See the [ports README](src/ports/README.md).

A slice is one more import, configured once:

```ts
import { TranscriptionModule } from '@marinoscar/kvox-api/transcription';

const TranscriptionConfig = TranscriptionModule.forRoot({
  providers: { assemblyai: true },
  permissions: { settingsRead: 'system_settings:read', settingsWrite: 'system_settings:write', configRead: 'transcripts:read' },
});
```

See the [transcription README](src/transcription/README.md#quick-start).

## Configuration

`KvoxPortsModule.forRoot({ ports })` is the one entry for the ports; each slice has its own `forRoot` (`TranscriptionModule.forRoot({ providers, extraProviders, permissions })`, see its [configuration](src/transcription/README.md#configuration)). `KvoxPortsModule.forRoot` takes eight required port bindings (`ai`, `objectStore`, `jobs`, `identity`, `notify`, `prisma`, `settings`, `secrets`), two optional (`events`, `audit`) and the `imports` the bound classes need. A missing required binding is a start-up error naming the port. The package reads no environment variable.

## Extension-point catalog

What a host implements, binds or registers. The per-port table (web adapter path and Desktop mapping) is in the [ports README](src/ports/README.md#extension-point-catalog).

| Symbol | Slice | What it is |
|---|---|---|
| `KVOX_AI`, `KvoxAiPort` | ports | Model calls: streamed text, structured output, tool-calling chat, embeddings, capabilities. |
| `KVOX_OBJECT_STORE`, `KvoxObjectStorePort` | ports | Resumable upload, put, read, signed URL, delete, upload-completed hook. |
| `KVOX_JOBS`, `KvoxJobsPort`, `KvoxJobHandler` | ports | Enqueue with dedup, handler registration; what a slice registers. |
| `KVOX_IDENTITY`, `KvoxIdentityPort` | ports | Authenticate a request into a normalised principal. |
| `KVOX_NOTIFY`, `KvoxNotifyPort` | ports | Declare notification events and raise them, detached. |
| `KVOX_EVENTS`, `KvoxEventsPort` | ports | In-process domain events (optional). |
| `KVOX_PRISMA`, `KvoxPrismaClientLike` | ports | The host's Prisma client, seen structurally. |
| `KVOX_SETTINGS`, `KvoxSettingsPort` | ports | Versioned system namespaces and per-user namespaces. |
| `KVOX_SECRETS`, `KvoxSecretsPort` | ports | Provider keys the domain owns; `status` never returns material. |
| `KVOX_AUDIT`, `KvoxAuditPort` | ports | Audit rows (optional). |
| `KvoxPortsModule`, `KvoxPortBindings` | core | The global module a host calls `forRoot` on to bind the ports. |
| `KVOX_AUTH_PERMISSIONS` | core | The token under which a slice module provides its option-name to permission-string map; `KvoxAuthFromOptions` routes resolve through it. |
| `setKvoxAuthDocumenter` | core | The hook a host uses to describe an authenticated route in its API document; `documentKvoxAuth` applies it. |
| `TranscriptionModuleOptions.extraProviders`, `TranscriptionProvider` | transcription | Register another speech-to-text provider; it must pass the conformance kit. |
| `describeTranscriptionProviderConformance`, `TranscriptionConformanceOptions.scenarios` | transcription/testing | The provider conformance kit and the failing upstreams its author wires in. |

## Data

None. The package declares no table; the schema is `@marinoscar/kvox-db`'s and slices see rows through structural types.

## Permissions and settings

The package declares no permission string. `KvoxAuth` checks the strings a route names against the principal the host returns, and `KvoxAuthFromOptions` takes them from the slice's options; the host declares them (`apps/api/src/app-registrations/permissions.ts`, and `kvox-permissions.ts` for a slice's own set). The transcription slice enforces three: `system_settings:read` and `system_settings:write` (the admin settings routes) and `transcripts:read` (the capability probe), the defaults of its `permissions` option. Settings: the `transcription` system namespace (declared by the slice through the settings port) and the `graph` user namespace; the web adapter verifies a namespace is already in the platform registry rather than declaring one late. Secrets: the `transcription` purpose, one secret per provider id.

## UI

None. The pages are in `@marinoscar/kvox-web`.

## Infra

None. The package ships no deployment configuration and reads no environment variable.

## Observability

None in the package: it emits no log line of its own beyond a warning when an event listener fails. The web adapters wrap every promise-returning call in the platform `@Trace()` so spans keep their names (`PlatformKvoxJobsAdapter.enqueue`); the streaming AI methods are not wrapped, because the platform AI slice already traces each round trip.

## Security notes

A slice never reads a provider key itself: AI and secrets go through ports the host binds (the transcription slice reads its provider key through `KVOX_SECRETS.get` only at the moment of a provider call and never logs, returns or audits it). **A key never crosses the AI port**: the context carries a user id, and the adapter resolves the key and drops it; the conformance suite asserts no event, error message or capability holds a key-shaped string. `KvoxAuthGuard` takes permissions only from the normalised principal, never from a raw user object, and answers 401 with no principal and 403 for a missing permission; per-resource access stays the service's 404-not-403 rule. `notify` is detached and never throws. `status` of a secret never returns material. The package carries no secret.

## Conformance suite

`describeKvoxPortsConformance(name, factory, { describe, it, expect })` from `@marinoscar/kvox-api/testing` is the executable proof a binding is correct, under Jest or Vitest. It checks, per port: AI errors are `KvoxAiError`s of a known class and carry no key, a text stream or chat step ends with exactly one `done`, no text follows a tool call, embeddings are one vector per input at the reported width; the object store round-trips bytes, takes a 6 MiB stream, signs, deletes idempotently and fires `onUploaded` once; jobs dedup, honour `skipDedup`, run a registered handler and report an unknown type unregistered; identity answers `null` without credentials and a `ReadonlySet` of permissions with them; `notify` returns at once; settings and secrets round-trip and `status` never returns material. The in-memory fakes pass it (`test/ports-conformance.spec.ts`) and so do the web adapters (`apps/api/test/platform-kvox/ports-conformance.spec.ts`). A Desktop author runs it against their own adapters. Each slice adds its own suite under its `/testing` entry: `describeTranscriptionProviderConformance` holds a transcription provider to the contract (identity, capabilities, a form without secrets, a context that never serialises its key, and, per failing upstream the author supplies, 401 to `ProviderAuthError`, 429 to `RateLimitError`, a rejected input to `ProviderInputError`). The tests run in two Jest projects, `unit` (`npm run test:run -w @marinoscar/kvox-api`) and `db` against a real PostgreSQL with pgvector (`npm run test:host:prepare -w @marinoscar/kvox-api`, then `npm run test:db -w @marinoscar/kvox-api`); the test host is described in `test/host/README.md`.

## Upgrade notes

This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from. Within the repository: `KvoxAuth` and `KvoxAuthFromOptions` no longer attach an OpenAPI marker themselves, the owning module's `forRoot` does (`documentKvoxAuth`), so a controller used outside a slice module is not documented as authenticated until `documentKvoxAuth` is called for it; the settings, secrets and rate-limit ports gained optional members only. In the API the moved helpers keep their old import paths as re-exports (`notes/job-types.ts`, `notes/generation/{stream-flusher,note-stream}.ts`, `ai-port/ai-token-budget.ts`, `transcripts/transcripts.controller.ts`); new code imports `@marinoscar/kvox-api/core`.

## Troubleshooting

`Nest can't resolve dependencies` with two Nest copies in `node_modules`: run `node scripts/kvox-packages/check-single-instance.mjs` and align the ranges.

`KvoxPortsModule.forRoot: no binding for port KVOX_JOBS (ports.jobs)`: a required port is unbound; add it to `ports`.

`Building raw SQL needs the optional peer dependency @prisma/client-runtime-utils`: install it next to `@prisma/client`.

`No permission is configured for the option "settingsRead"` (a 500 on a `KvoxAuthFromOptions` route): the module that owns the controller does not provide `KVOX_AUTH_PERMISSIONS`; use the slice's `forRoot`.

`Cannot find module './generated/client.js'` in a `*.db.spec.ts`: run `npm run test:host:prepare -w @marinoscar/kvox-api` first; it needs no database.

A job handler refused with "server-only": an AI handler declared `nodeResultSchema`; AI work spends the user's own key and stays on the server.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
