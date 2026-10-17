# sql

A small SQL reader for migration text.

## Purpose and scope

Splits migration SQL into statements (comments, quotes and dollar-quoted function bodies respected) and reads the indexes it creates and the tables it touches. It is a reader for the shapes Prisma and the domain migrations use, not a SQL parser; it exists so `check` can hold the raw-SQL inventory to the migrations and `promote` can refuse a migration that touches a table the domain does not own.

Status: implemented (issue 5.3).

## Entry point

`@marinoscar/kvox-db`: `splitSqlStatements`, `scanCreatedIndexes`, `scanTouchedTables`, `columnsOfDefinition` and their result types.

## Peer dependencies

None. The slice imports Node built-ins only.

## Configuration

None.

## Extension-point catalog

None.

### Desktop

The raw-SQL inventory is what `kvox-db check --database` proves on PGlite and on a bundled PostgreSQL. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#database).
