# @marinoscar/kvox-contract

The wire contract of the KVox domain: Zod schemas, error codes and the ontology that the API, the web app and any other host share. Dual CommonJS and ESM, `sideEffects: false`, and free of any framework or Node built-in, so it loads in the browser too.

## Purpose and scope

The Zod request and response schemas of the domain slices (transcription, transcripts, search, notes, graph, Ask), the domain error codes, the ontology and the transcript export JSON schema. It holds no behaviour: no service, no controller, no component and no database access. Nothing in it imports another KVox package or a framework.

Status: scaffold. The package builds, is documented and publishes, but exports only its own name (`KVOX_CONTRACT_PACKAGE`). The schemas move in with issue 5.2 (Epic 5); the root export then grows, with subpaths per slice (`./transcription`, `./transcripts`, `./search`, `./notes`, `./graph`, `./ask`, `./ontology`, `./errors`).

- `@marinoscar/kvox-contract`: the package root, the only entry point today (`KVOX_CONTRACT_PACKAGE`).

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-contract@next
```

The package never bundles Zod, because a second copy breaks `instanceof ZodError` checks. Install it in the app ([the rule](../../docs/PACKAGES.md#peer-dependencies-per-slice)):

| Package | Range | Needed by |
|---|---|---|
| `zod` | `^4.4.3` | every slice (required) |

There are no optional peers. The per-slice data is `packages/kvox-slice-peers.json`; `node scripts/kvox-packages/check-slice-peers.mjs --table` prints it.

## Quick start

```ts
import { KVOX_CONTRACT_PACKAGE } from '@marinoscar/kvox-contract';
// CommonJS: const { KVOX_CONTRACT_PACKAGE } = require('@marinoscar/kvox-contract');
```

Keep the `.js` extension on every relative import inside the package; the ESM build fails at run time without it.

## Configuration

None. The package reads no environment variable and takes no option.

## Extension-point catalog

None. The contract exposes data shapes, not extension points; the slices that extend the platform live in `@marinoscar/kvox-api`.

## Data

None. It describes the shape of data on the wire; it stores nothing. The database side is `@marinoscar/kvox-db`.

## Permissions and settings

None yet. Permission strings stay where the API enforces them (`apps/api/src/app-registrations/permissions.ts`).

## UI

None. The package is framework-free; the pages are in `@marinoscar/kvox-web`.

## Infra

None. The package ships no deployment configuration.

## Observability

None. It logs and measures nothing.

## Security notes

The schemas are the first line of input validation for the API; they must stay strict (no `passthrough()` on a request body). The package carries no secret and imports no Node built-in.

## Conformance suite

None yet. The contract has no conformance suite; the ports of `@marinoscar/kvox-api/testing` come with issue 5.4.

## Upgrade notes

None. This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from.

## Troubleshooting

`ERR_MODULE_NOT_FOUND` from an ESM import of a relative path means the `.js` extension is missing in the source. `TS1479` from a CommonJS consumer means the `dist/cjs/package.json` stub is absent (`npm run build` writes it).

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
