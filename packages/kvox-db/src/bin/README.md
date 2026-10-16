# bin

The `kvox-db` command: its argument handling, usage text and exit codes.

## Purpose and scope

The logic behind `bin/kvox-db.js`, written in TypeScript so it is typed and unit-tested. The bin file only wires it to the process streams.

Status: scaffold. No subcommand exists yet; `sync` and `check` arrive with issue 5.3.

## Entry point

`@marinoscar/kvox-db` (the package root re-exports this slice): `runKvoxDb(argv, io)`, `kvoxDbUsage()`, `KVOX_DB_COMMANDS` and the `KvoxDbIo` type.

## Peer dependencies

`prisma` (`^7.8.0`), required.

## Configuration

None.

## Extension-point catalog

None.
