/**
 * `@marinoscar/kvox-db`: the domain Prisma fragments, migrations and the
 * `kvox-db` command.
 *
 * @remarks
 * The package ships `schema/` (the domain fragments), `migrations/` (the domain
 * migrations with `manifest.json`), `raw-sql-indexes.json`, `extensions.json` and
 * `schema-objects.json`. The programmatic API below is what the `kvox-db`
 * command runs: `planKvoxSync` and `applyKvoxSync` install them into a host,
 * `checkKvoxInstall` proves the installed copies unchanged.
 *
 * @packageDocumentation
 */
export * from './bin/index.js';
export * from './check/index.js';
export * from './lock/index.js';
export * from './manifest/index.js';
export * from './promote/index.js';
export * from './sql/index.js';
export * from './sync/index.js';
