# @marinoscar/kvox-web

The React side of the KVox domain: pages, components and hooks built on MUI, exposed one subpath per slice. ESM with `sideEffects: false`; it loads in plain Node ESM as well as through a bundler.

## Purpose and scope

The web slices of the domain (transcripts, notes, graph, Ask and their settings pages), each split into a `headless` entry (hooks, services, no component) and a `ui` entry. It does not own the app's router, theme or settings registries; the app binds the package's descriptors into its own. It imports no `@marinoscar/platform-*` package (rule `host-neutral`, [PACKAGES.md](../../docs/PACKAGES.md#the-host-neutral-rule)).

Status: scaffold. The only slice is `core`, with a placeholder marker (`KVOX_WEB_CORE`); the domain slices arrive with Epic 7 as `./<slice>/headless` and `./<slice>/ui`.

- `@marinoscar/kvox-web/core`: the web host ports every packaged page will reuse. [README](src/core/README.md).

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-web@next
```

Install these in the app; the package never bundles its own copy (a second copy breaks hooks and theme context). Import slices by their subpath ([the rule](../../docs/PACKAGES.md#peer-dependencies-per-slice)).

Required by every slice (`core`):

| Package | Range |
|---|---|
| `@marinoscar/kvox-contract` | `>=0.0.0-0 \|\| >=0.1.0-0` (any release; the four packages ship together, see [the contract peer range](../../docs/PACKAGES.md#the-contract-peer-range)) |
| `react` | `^19.2.7` |
| `react-dom` | `^19.2.7` |

Optional peers, installed for the slices that need them (none does yet):

| Package | Range | Needed by |
|---|---|---|
| `@mui/material` | `^9.1.0` | reserved for the `/ui` entries (Epic 7) |
| `@mui/icons-material` | `^9.1.0` | reserved for the `/ui` entries |
| `react-router-dom` | `^7.17.0` | reserved for the page slices |
| `@marinoscar/platform-web` | `0.1.0-next.5` | no slice: host wiring in the app only |

The per-slice data is `packages/kvox-slice-peers.json`; `node scripts/kvox-packages/check-slice-peers.mjs --table` prints it.

## Quick start

```ts
import { KVOX_WEB_CORE } from '@marinoscar/kvox-web/core';
```

The host provider and how an app registers a packaged page arrive with Epic 7. See the [core README](src/core/README.md).

## Configuration

None at the package level.

## Extension-point catalog

None yet. The slots and registries of the page slices are listed here as they arrive.

## Data

None. The browser holds no data model; it reads and writes through the API.

## Permissions and settings

None yet. Packaged pages check no permission themselves: the app's route gate does.

## UI

None yet. The `ui` entries and their theme tokens arrive with Epic 7.

## Infra

None. The package ships no deployment configuration and reads no environment variable.

## Observability

None. No slice logs or measures anything in the browser yet.

## Security notes

Pages never hold an API key and never call an AI provider from the browser; they call the API through the app's transport, and authorization stays in the API.

## Conformance suite

None yet.

## Upgrade notes

None. This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from.

## Troubleshooting

`Invalid hook call` means two copies of React: run `node scripts/kvox-packages/check-single-instance.mjs` and align the ranges. `ERR_MODULE_NOT_FOUND` from Node means a relative import lost its `.js` extension.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
