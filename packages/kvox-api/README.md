# @marinoscar/kvox-api

The NestJS side of the KVox domain: the host ports a slice needs, their in-memory fakes and, from Epic 6, the domain slices. CommonJS, built with `tsc` and decorator metadata.

## Purpose and scope

The domain's server code in slices, one subpath per slice, so a second host (KVox Desktop) can install it without the web edition. A slice imports only `@marinoscar/kvox-api/ports` and `@marinoscar/kvox-contract`, never `@marinoscar/platform-*`: the web edition binds the platform to the ports in the app (`apps/api/src/platform-kvox/`), which keeps the package host-neutral (rule `host-neutral`, [PACKAGES.md](../../docs/PACKAGES.md#the-host-neutral-rule)).

Status: ports, core and testing are in place (issue 5.4); the domain slices follow with Epic 6 (`./transcription`, `./search`, `./transcripts`, `./notes`, `./graph`, `./graph-extraction`, `./graph-rdf`, `./ask`). Every declaration is `@stability experimental`.

- `@marinoscar/kvox-api/ports`: the ten host ports (AI, object store, jobs, identity, notify, events, Prisma, settings, secrets, audit) and their injection tokens. [README](src/ports/README.md).
- `@marinoscar/kvox-api/core`: `KvoxPortsModule`, `@KvoxAuth()`, and the helpers the domain slices share (throttle key, token budget, stream flusher and SSE helpers, ETags, the `Prisma` SQL helper). [README](src/core/README.md).
- `@marinoscar/kvox-api/testing`: in-memory fakes of the ports and `describeKvoxPortsConformance`. [README](src/testing/README.md).

The web edition binds every port to a platform slice in `apps/api/src/platform-kvox/`; the contract in prose, with the Desktop mapping notes, is [docs/specs/kvox-ports.md](../../docs/specs/kvox-ports.md).

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-api@next
```

Install these in the app; the package never bundles its own copy (a second copy of Nest breaks dependency injection). Import slices by their subpath. Which peers you need depends on the slices you import ([the rule](../../docs/PACKAGES.md#peer-dependencies-per-slice)).

Required by every slice (`ports`, `core`):

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
| `@nestjs/swagger` | `^11.2.5` | `core`: the bearer-auth marker of `KvoxAuth` (loaded on first use); the controller slices (Epic 6) |
| `@nestjs/event-emitter` | `^3.0.1` | `core`: `KvoxPortsModule` shares Nest's `EventEmitter2` as the default `KVOX_EVENTS` (loaded on first use); listeners |
| `@nestjs/schedule` | `^6.1.0` | reserved for housekeeping tasks |
| `nestjs-zod` | `^5.4.0` | reserved for the controller slices |
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

## Configuration

`KvoxPortsModule.forRoot({ ports })` is the one entry: eight required port bindings (`ai`, `objectStore`, `jobs`, `identity`, `notify`, `prisma`, `settings`, `secrets`), two optional (`events`, `audit`) and the `imports` the bound classes need. A missing required binding is a start-up error naming the port. The package reads no environment variable.

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

## Data

None. The package declares no table; the schema is `@marinoscar/kvox-db`'s and slices see rows through structural types.

## Permissions and settings

The package declares no permission string and no settings key. `KvoxAuth` checks the strings a route names against the principal the host returns; the host declares them (`apps/api/src/app-registrations/permissions.ts`). The settings port carries the host's namespaces (`transcription`, `graph`); the web adapter verifies a namespace is already in the platform registry rather than declaring one late.

## UI

None. The pages are in `@marinoscar/kvox-web`.

## Infra

None. The package ships no deployment configuration and reads no environment variable.

## Observability

None in the package: it emits no log line of its own beyond a warning when an event listener fails. The web adapters wrap every promise-returning call in the platform `@Trace()` so spans keep their names (`PlatformKvoxJobsAdapter.enqueue`); the streaming AI methods are not wrapped, because the platform AI slice already traces each round trip.

## Security notes

A slice never reads a provider key itself: AI and secrets go through ports the host binds. **A key never crosses the AI port**: the context carries a user id, and the adapter resolves the key and drops it; the conformance suite asserts no event, error message or capability holds a key-shaped string. `KvoxAuthGuard` takes permissions only from the normalised principal, never from a raw user object, and answers 401 with no principal and 403 for a missing permission; per-resource access stays the service's 404-not-403 rule. `notify` is detached and never throws. `status` of a secret never returns material. The package carries no secret.

## Conformance suite

`describeKvoxPortsConformance(name, factory, { describe, it, expect })` from `@marinoscar/kvox-api/testing` is the executable proof a binding is correct, under Jest or Vitest. It checks, per port: AI errors are `KvoxAiError`s of a known class and carry no key, a text stream or chat step ends with exactly one `done`, no text follows a tool call, embeddings are one vector per input at the reported width; the object store round-trips bytes, takes a 6 MiB stream, signs, deletes idempotently and fires `onUploaded` once; jobs dedup, honour `skipDedup`, run a registered handler and report an unknown type unregistered; identity answers `null` without credentials and a `ReadonlySet` of permissions with them; `notify` returns at once; settings and secrets round-trip and `status` never returns material. The in-memory fakes pass it (`test/ports-conformance.spec.ts`) and so do the web adapters (`apps/api/test/platform-kvox/ports-conformance.spec.ts`). A Desktop author runs it against their own adapters.

## Upgrade notes

None. This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from. In the API the moved helpers keep their old import paths as re-exports (`notes/job-types.ts`, `notes/generation/{stream-flusher,note-stream}.ts`, `ai-port/ai-token-budget.ts`, `transcripts/transcripts.controller.ts`); new code imports `@marinoscar/kvox-api/core`.

## Troubleshooting

`Nest can't resolve dependencies` with two Nest copies in `node_modules`: run `node scripts/kvox-packages/check-single-instance.mjs` and align the ranges.

`KvoxPortsModule.forRoot: no binding for port KVOX_JOBS (ports.jobs)`: a required port is unbound; add it to `ports`.

`Building raw SQL needs the optional peer dependency @prisma/client-runtime-utils`: install it next to `@prisma/client`.

A job handler refused with "server-only": an AI handler declared `nodeResultSchema`; AI work spends the user's own key and stays on the server.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
