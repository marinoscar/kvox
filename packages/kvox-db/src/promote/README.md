# promote

Move a migration authored in the app into the package.

## Purpose and scope

`promoteKvoxMigration` takes a draft made with `prisma migrate dev --create-only`, refuses one that changes a table the domain does not own, copies it into `migrations/`, appends it to `manifest.json` and installs it under its original name.

Status: implemented (issue 5.3).

## Entry point

`@marinoscar/kvox-db`: `promoteKvoxMigration` and the option and result types.

## Peer dependencies

None. The slice imports Node built-ins only.

## Configuration

`KvoxPromoteOptions` (`root`, `localDir`, `id`, `slice`, `packageDir`).

## Extension-point catalog

None.
