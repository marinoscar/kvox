# sync

Install the domain fragments and migrations into a host app.

## Purpose and scope

`planKvoxSync` decides what to write (fragment copies with the GENERATED header, migration directories under `original`, `stable` or (deprecated) `after-host` names, `kvox.lock`, the `platform.lock` merge) and refuses what would break a rule; `applyKvoxSync` writes it and never overwrites an installed migration.

Status: implemented (issue 5.3).

## Entry point

`@marinoscar/kvox-db`: `planKvoxSync`, `applyKvoxSync`, `renderFragmentCopy`, `stableName`, `afterHostNames` (deprecated), `findMissingHostModels`, `KvoxSyncError`, `FRAGMENT_GENERATED_LINE` and the option and plan types.

## Peer dependencies

None. The slice imports Node built-ins only.

## Configuration

`KvoxSyncOptions` (`root`, `fragmentsDir`, `migrationsDir`, `names`, `dryRun`, `packageDir`, `platformSchemaDir`); the command's flags map one to one.

## Extension-point catalog

None.

### Desktop

Desktop runs `platform db sync --timestamp 2024-01-01T00:00:00Z`, then `kvox-db sync --names stable` on a database with no domain history. `stable` names are a pure function of the package migration id. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#database).
