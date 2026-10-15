import { defineConfig } from '@prisma/config';

/**
 * Prisma configuration for v7+.
 *
 * The DATABASE_URL is constructed by scripts/prisma-env.js (and, for the
 * `platform db` commands, scripts/platform-env.js) from individual
 * environment variables (POSTGRES_HOST, POSTGRES_PORT, etc.) and injected
 * before the Prisma CLI is invoked.
 *
 * For runtime use, apps/api/src/config/configuration.ts does the same.
 *
 * `prisma/schema/` is the GENERATED folder: `npm run db:compose` composes the
 * platform fragments (@marinoscar/platform-db) with this app's own
 * `prisma/fragments/*.prisma`. Edit a fragment, never the folder. With a schema
 * folder, Prisma would look for migrations inside it, so the migrations path
 * must be explicit.
 *
 * SHADOW_DATABASE_URL names the empty database `platform db drift` replays the
 * history into (Prisma refuses `migrate diff --from-migrations` without one).
 */
export default defineConfig({
  schema: 'prisma/schema',
  datasource: {
    url: process.env.DATABASE_URL as string,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --project prisma/tsconfig.json prisma/seed.ts',
  },
});
