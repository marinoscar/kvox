# sync

Install the domain fragments and migrations into a host app.

## Purpose and scope

`planKvoxSync` decides what to write (fragment copies with the GENERATED header, migration directories under `original` or `after-host` names, `kvox.lock`, the `platform.lock` merge) and refuses what would break a rule; `applyKvoxSync` writes it and never overwrites an installed migration.

Status: implemented (issue 5.3).

## Entry point

`@marinoscar/kvox-db`: `planKvoxSync`, `applyKvoxSync`, `renderFragmentCopy`, `afterHostNames`, `findMissingHostModels`, `KvoxSyncError`, `FRAGMENT_GENERATED_LINE` and the option and plan types.

## Peer dependencies

None. The slice imports Node built-ins only.

## Configuration

`KvoxSyncOptions` (`root`, `fragmentsDir`, `migrationsDir`, `names`, `dryRun`, `packageDir`, `platformSchemaDir`); the command's flags map one to one.

## Extension-point catalog

None.
