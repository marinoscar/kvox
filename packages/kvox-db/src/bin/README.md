# bin

The `kvox-db` command: its argument handling, usage text and exit codes.

## Purpose and scope

The logic behind `bin/kvox-db.js`, written in TypeScript so it is typed and unit-tested. The bin file only wires it to the process streams. Subcommands: `sync`, `check` (with `--database`) and `promote`. Exit codes: 0 ok, 1 a failed check or a refusal, 2 a usage error or a missing `DATABASE_URL`.

Status: implemented (issue 5.3).

## Entry point

`@marinoscar/kvox-db` (the package root re-exports this slice): `runKvoxDb(argv, io, context)`, `kvoxDbUsage()`, `KVOX_DB_COMMANDS` and the `KvoxDbIo` and `KvoxDbContext` types.

## Peer dependencies

`prisma` (`^7.8.0`), required. The command also depends on `commander`, which is a dependency of the package, not a peer.

## Configuration

`--root <dir>` (the app folder, default the current directory) on every subcommand; `DATABASE_URL` for `check --database`. Flags per subcommand are in the package README ("Configuration").

## Extension-point catalog

None.
