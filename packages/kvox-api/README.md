# @marinoscar/kvox-api

The NestJS side of the KVox domain: the host ports a slice needs, their in-memory fakes and, from Epic 6, the domain slices. CommonJS, built with `tsc` and decorator metadata.

## Purpose and scope

The domain's server code in slices, one subpath per slice, so a second host (KVox Desktop) can install it without the web edition. A slice imports only `@marinoscar/kvox-api/ports` and `@marinoscar/kvox-contract`, never `@marinoscar/platform-*`: the web edition binds the platform to the ports in the app (`apps/api/src/platform-kvox/`), which keeps the package host-neutral (rule `host-neutral`, [PACKAGES.md](../../docs/PACKAGES.md#the-host-neutral-rule)).

Status: scaffold. Each slice below exports one placeholder marker; the ports and fakes arrive with issue 5.4 and the domain slices with Epic 6 (`./transcription`, `./search`, `./transcripts`, `./notes`, `./graph`, `./graph-extraction`, `./graph-rdf`, `./ask`).

- `@marinoscar/kvox-api/ports`: the host ports (AI, object store, jobs, identity, notify, events, Prisma, settings, secrets, audit) and their injection tokens. [README](src/ports/README.md).
- `@marinoscar/kvox-api/core`: the helpers the domain slices share. [README](src/core/README.md).
- `@marinoscar/kvox-api/testing`: in-memory fakes of the ports and the ports conformance suite. [README](src/testing/README.md).

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

Optional peers, installed for the slices that need them (none does yet):

| Package | Range | Needed by |
|---|---|---|
| `@nestjs/swagger` | `^11.2.5` | reserved for the controller slices (Epic 6) |
| `@nestjs/event-emitter` | `^3.0.1` | reserved for the event port adapter and listeners |
| `@nestjs/schedule` | `^6.1.0` | reserved for housekeeping tasks |
| `nestjs-zod` | `^5.4.0` | reserved for the controller slices |
| `@prisma/client-runtime-utils` | `^7.8.0` | reserved for the slices that type Prisma rows structurally |
| `@marinoscar/platform-api` | `0.1.0-next.5` | no slice: host wiring only (`apps/api/src/platform-kvox`) |

The per-slice data is `packages/kvox-slice-peers.json`; `node scripts/kvox-packages/check-slice-peers.mjs --table` prints it.

## Quick start

```ts
import { KVOX_API_PORTS } from '@marinoscar/kvox-api/ports';
```

The ports and how a host binds them are documented with issue 5.4. See the [ports README](src/ports/README.md).

## Configuration

None at the package level. Slices take their options through `forRoot` once they exist.

## Extension-point catalog

None yet. The ports of issue 5.4 are the extension points; each one will be listed here and in the [ports README](src/ports/README.md#extension-point-catalog).

## Data

None. The package declares no table; the schema is `@marinoscar/kvox-db`'s and slices see rows through structural types.

## Permissions and settings

None yet. Permission strings are declared by the app (`apps/api/src/app-registrations/permissions.ts`).

## UI

None. The pages are in `@marinoscar/kvox-web`.

## Infra

None. The package ships no deployment configuration and reads no environment variable.

## Observability

None yet.

## Security notes

A slice never reads a provider key itself: AI and secrets go through ports the host binds. No access answers 404, never 403. The package carries no secret.

## Conformance suite

None yet. `describeKvoxPortsConformance` ships with the `testing` slice in issue 5.4.

## Upgrade notes

None. This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from.

## Troubleshooting

`Nest can't resolve dependencies` with two Nest copies in `node_modules`: run `node scripts/kvox-packages/check-single-instance.mjs` and align the ranges.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
