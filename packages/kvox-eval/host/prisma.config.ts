import { defineConfig } from '@prisma/config';

// =============================================================================
// Prisma configuration of the headless Ask evaluation's host (issue #608)
// =============================================================================
//
// Used only by `scripts/prepare-host.mjs` at BUILD time, to generate the client
// in `generated/`. `prisma/schema/`, `prisma/migrations/` and `generated/` are
// GENERATED (the platform fragments of `@marinoscar/platform-db` plus the domain
// fragments and migrations of `@marinoscar/kvox-db`) and git-ignored; the
// package ships `prisma/migrations/` and `generated/`, never this file.
//
// Generating a client does not connect, so the URL is a placeholder: at run
// time the evaluation applies the migration files itself to an in-memory
// PGlite (`src/ask-run/host/db.ts`) and never runs the Prisma CLI.
// =============================================================================

export default defineConfig({
  schema: 'prisma/schema',
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/postgres',
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
