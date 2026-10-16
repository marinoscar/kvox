# @marinoscar/kvox-db

The database side of the KVox domain: the Prisma schema fragments, the SQL migrations and the `kvox-db` command that installs them into an app. CommonJS.

## Purpose and scope

The domain Prisma fragments, the domain migrations with a lock file, the raw-SQL index and extension inventory, and the `kvox-db` command (`sync` copies them into an app, `check` proves the copies byte-identical to the package). It does not own the platform tables; those are `@marinoscar/platform-db`'s.

Status: scaffold. Today the package holds only the `kvox-db` bin, which prints its usage, and the placeholder root export. The fragments, migrations, `raw-sql-indexes.json` and `extensions.json` move in with issue 5.3 (Epic 5); the `files` list already names their folders.

- `@marinoscar/kvox-db`: the package root, which re-exports the `bin` slice (`runKvoxDb`, `kvoxDbUsage`). [README](src/bin/README.md).

## Install and peer dependencies

```bash
npm install --save-dev @marinoscar/kvox-db@next
```

| Package | Range | Needed by |
|---|---|---|
| `prisma` | `^7.8.0` | `bin` (required) |

The command runs with `npx kvox-db` or from an npm script. The per-slice data is `packages/kvox-slice-peers.json`.

## Quick start

```bash
npx kvox-db --help
```

`kvox-db sync` and `kvox-db check` arrive with issue 5.3; until then the command lists no subcommand and an unknown one exits with code 2.

## Configuration

None yet. `sync` and `check` will take the app's Prisma folder as an option.

## Extension-point catalog

None.

## Data

None yet. The fragments (`schema/`), migrations (`migrations/`), `raw-sql-indexes.json` and `extensions.json` ship with issue 5.3. Raw-SQL indexes stay in `migration.sql` and are never added to a fragment.

## Permissions and settings

None.

## UI

None.

## Infra

None. The package creates no database role or extension; the bootstrap superuser does.

## Observability

None.

## Security notes

The command writes only inside the app folder it is pointed at and never reads credentials. It must never run against a database: it copies files.

## Conformance suite

None yet. `kvox-db check` is the executable proof that the installed copies match the package.

## Upgrade notes

None. This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from.

## Troubleshooting

`Cannot find module '../dist/bin/index.js'` means the package was not built; run `npm run build -w @marinoscar/kvox-db`.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
