import { createRequire } from 'node:module';

import { defineConfig } from '@prisma/config';

// The one implementation of "DATABASE_URL from POSTGRES_*" the Prisma side uses
// (scripts/prisma-env.js, held equal to src/common/database-url.ts by a spec).
// `createRequire` because that file is CommonJS and this one may be loaded as
// either kind of module.
const { constructDatabaseUrl } = createRequire(import.meta.url)('./scripts/prisma-env.js') as {
  constructDatabaseUrl: (env?: NodeJS.ProcessEnv) => string;
};

/**
 * Prisma configuration for v7+.
 *
 * The DATABASE_URL is constructed by scripts/prisma-env.js (and, for the
 * `platform db` commands, scripts/platform-env.js) from individual
 * environment variables (POSTGRES_HOST, POSTGRES_PORT, etc.) and injected
 * before the Prisma CLI is invoked. It is ALSO derived here, from the same
 * function, when DATABASE_URL is not set: the platform CLI's migration probe
 * (`deploy status`, install and update's verify) runs a bare
 * `npx prisma migrate status` inside the api container, which skips the
 * wrapper, and without this it reported the schema state as unknown. An
 * already-set DATABASE_URL still wins (`constructDatabaseUrl` returns it).
 *
 * For runtime use, apps/api/src/config/configuration.ts does the same.
 *
 * `prisma/schema/` is the GENERATED folder: `npm run db:compose` composes the
 * platform-db package fragments with this app's own
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
    url: constructDatabaseUrl(),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --project prisma/tsconfig.json prisma/seed.ts',
  },
});
