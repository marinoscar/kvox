# @marinoscar/kvox-contract

The wire contract of the KVox domain: the Zod schemas of every request and response, the domain error codes, the ontology and the transcript export JSON schema that the API, the web app and any other host share. Dual CommonJS and ESM, `sideEffects: false`, and free of any framework or Node built-in, so it loads in the browser too.

## Purpose and scope

The package holds the shape of the domain's HTTP traffic and nothing that behaves: no service, no controller, no component and no database access. The API wraps the schemas in `createZodDto` classes, the web types its responses with them, and a second host (KVox Desktop) gets the same contract by installing one package. It does not hold the platform's shapes (they come from `@marinoscar/platform-contract`), policy numbers such as token budgets, or anything server-only.

Status: experimental. The schemas moved out of the API's DTO files in issue 5.2 (marinoscar/kvox#488) with no change to a field name or a value; the API's DTO files re-export them under their old names.

Entry points (a slice README per folder):

- `@marinoscar/kvox-contract`: the package root; exports only `KVOX_CONTRACT_PACKAGE`.
- `@marinoscar/kvox-contract/transcription`: transcription settings and keyterm limits ([slice README](src/transcription/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/transcripts`: transcripts, editing operations, exports, shares and name checks ([slice README](src/transcripts/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/search`: search queries, results and index status ([slice README](src/search/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/notes`: notes, templates, source documents and exports ([slice README](src/notes/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/graph`: entities, proposals, extraction, read model, export and import ([slice README](src/graph/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/ask`: Ask conversations and messages ([slice README](src/ask/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/copilot`: the GitHub Copilot opt-in setting, status and sign-in challenge, with `COPILOT_CONSENT_VERSION` ([slice README](src/copilot/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/ontology`: the ontology as code ([slice README](src/ontology/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/errors`: the error and reason catalogue ([slice README](src/errors/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/brand`: the identity values, colour tokens, logo geometry and `brandMarkSvg()` shared by the web theme and the document exporters ([slice README](src/brand/README.md#purpose-and-scope)).
- `@marinoscar/kvox-contract/schemas/transcript-export.v1.json`: the public JSON Schema of the transcript export document (a data file, not code).

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
import { createNoteSchema } from '@marinoscar/kvox-contract/notes';
import { KVOX_ERROR_CODES, isKvoxErrorCode } from '@marinoscar/kvox-contract/errors';
// CommonJS: const { createNoteSchema } = require('@marinoscar/kvox-contract/notes');

const body = createNoteSchema.parse(input);
if (isKvoxErrorCode(reason)) console.log(KVOX_ERROR_CODES[reason].status);
```

In the API, import the DTO classes from the module's `dto/` file as before; the schemas behind them are the ones above. The export schema is a plain file: `require.resolve('@marinoscar/kvox-contract/schemas/transcript-export.v1.json')`.

Keep the `.js` extension on every relative import inside the package; the ESM build fails at run time without it.

## Configuration

None. The package reads no environment variable and takes no option.

## Extension-point catalog

None. The contract exposes data shapes, not extension points; the slices that extend the platform live in `@marinoscar/kvox-api`.

## Data

None. It describes the shape of data on the wire; it stores nothing. The database side is `@marinoscar/kvox-db`. It ships one data file, `schemas/transcript-export.v1.schema.json` (`$id` `https://kvox.dev/schemas/kvox.transcript/v1`, permanent); `docs/specs/transcript-export.v1.schema.json` is a byte-identical copy that a test guards.

## Permissions and settings

None. Permission strings stay where the API enforces them (`apps/api/src/app-registrations/permissions.ts`). The `transcription` slice describes the settings namespace of that name; the keys are persisted and never renamed.

## UI

None. The package is framework-free; the pages are in `@marinoscar/kvox-web`.

## Infra

None. The package ships no deployment configuration. An image that installs it must build it (`npm run build --workspace=@marinoscar/kvox-contract`) because `.dockerignore` drops every `dist/`; both application Dockerfiles do.

## Observability

None. It logs and measures nothing.

## Security notes

The schemas are the first line of input validation for the API; they must stay strict (no `passthrough()` on a request body). The package carries no secret, no server-only constant and imports no Node built-in. A `sensitive` PersonFact never leaves the deployment: nothing here may add a field that exports one.

## Conformance suite

The package's own Vitest suite (`npm run test:run --workspace=@marinoscar/kvox-contract`): the seven ontology suites, the error catalogue (every per-slice reason is in `KVOX_ERROR_CODES`, no code twice) and the byte-identity of the two export-schema copies. The API adds the Prisma-enum parity spec (`apps/api/test/contract/contract-parity.spec.ts`) and the `@app/shared/ontology` re-export identity spec.

## Upgrade notes

None. This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from. Inside the repository, `@app/shared/ontology` is now a re-export of `@marinoscar/kvox-contract/ontology`; no import changed.

## Troubleshooting

`ERR_MODULE_NOT_FOUND` from an ESM import of a relative path means the `.js` extension is missing in the source. `TS1479` from a CommonJS consumer means the `dist/cjs/package.json` stub is absent (`npm run build` writes it). `Cannot find module '@marinoscar/kvox-contract/...'` in the API or web means the package was not built: run `npm run build --workspace=@marinoscar/kvox-contract` (CI and the Dockerfiles do it after `npm ci`).

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
- [Ontology spec](../../docs/specs/ontology.md): section 17 on versioning

### Desktop

Desktop's main process and renderer share this wire contract; install the same version in both (the four packages are one `fixed` group). See [the KVox Desktop guide](../../docs/guides/kvox-desktop.md#who-this-is-for-and-what-you-get).
