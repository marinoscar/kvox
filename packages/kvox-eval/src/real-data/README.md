# real-data

The guard that keeps real meetings out of the repository.

## Purpose and scope

`assertOutsideRepo(path, { allowInside? })` resolves a path (symlinks included) and throws `RealDataPathError` (exit code 3, `REAL_DATA_REFUSAL`) when it is inside the git work tree; `allowInside` names the one git-ignored scratch directory a run over the SYNTHETIC set may still write to. `repositoryRoots`, `canonicalPath`, `isInside` and `nextRealFixtureId` are its parts. Exporting a real note as a skeleton reads the web app's tables and stays in `apps/api/scripts/kg-eval/real-data.ts`, which uses this guard.

Status: issue #580 (from `apps/api/scripts/kg-eval/real-data.ts`; #362 before it).

## Entry point

`@marinoscar/kvox-eval` (the package root re-exports this slice).

## Peer dependencies

None (Node built-ins and the `git` binary when present).

## Configuration

None.

## Extension-point catalog

None.
