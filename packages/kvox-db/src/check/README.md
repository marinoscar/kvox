# check

Prove the installed copies match the package; check a live database.

## Purpose and scope

`checkKvoxInstall` compares the package with its manifest, every fragment copy and installed migration byte for byte, `kvox.lock` with the folder and `platform.lock` with the inventory; with `database` it also reads catalogs (`pg_extension`, `pg_indexes`, `pg_trigger`, `pg_proc`, `pg_constraint`, `information_schema.columns`) with `SELECT`s only. It also holds the fragments to the raw-SQL index tripwire.

Status: implemented (issue 5.3).

## Entry point

`@marinoscar/kvox-db`: `checkKvoxInstall`, `checkPackage`, `checkDatabaseCatalog`, `checkFragmentDeclarations`, `readDatabaseCatalog`, `scanFragmentIndexes`, `KvoxCheckUsageError` and the option and result types.

## Peer dependencies

None declared. `pg` is resolved at run time from the app (then from this package) only for `database`, so the offline checks need nothing; it is not a peer of the package.

## Configuration

`KvoxCheckOptions` (`root`, `database`, `databaseUrl`, `packageDir`, `catalog`); `DATABASE_URL` is the default connection string.

## Extension-point catalog

None.

### Desktop

Desktop runs `kvox-db check` and `kvox-db check --database` after every migration. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#database).
