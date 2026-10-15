import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  platformSeedInputFrom,
  readSeedSnapshot,
  seedPlatform,
  type SeedPrisma,
} from '@marinoscar/platform-db/seed';

import { seedApp } from './seed-app';

// =============================================================================
// Database seed (issue #465, epic #462)
// =============================================================================
//
// Two idempotent steps, in this order:
//
//   1. `seedPlatform`: the roles, permissions and default grants, the `global`
//      system settings row, the initial administrator's allowlist row
//      (INITIAL_ADMIN_EMAIL) and the default organization. Its input comes from
//      the two committed catalogs in `prisma/catalog/`, generated from the
//      registries by `npm run catalog:permissions` and `npm run catalog:settings`.
//      The seed never imports `src/`: the production image carries `prisma/`
//      but not `src/`.
//   2. `seedApp`: KVox's own rows (the built-in note templates), `seed-app.ts`.
//
// Neither step deletes anything or overwrites a value an administrator edited.
// This script stays Nest-free so it runs under ts-node.

// Prisma 7 requires a driver adapter; PrismaClient can no longer be
// instantiated with no options. The seed script is invoked as a standalone
// ts-node process (see prisma.config.ts: migrations.seed), not through Nest's
// DI container. Every Prisma CLI invocation in this project (npm run
// prisma:*) guarantees DATABASE_URL is set via scripts/prisma-env.js.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Run this script via `npm run prisma:seed` ' +
      '(or export DATABASE_URL) so Prisma can connect to the database.',
  );
}

const adapter = new PrismaPg(databaseUrl);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Starting database seed...\n');

  const input = platformSeedInputFrom(
    readSeedSnapshot(join(__dirname, 'catalog')),
    process.env,
  );
  const summary = await seedPlatform(prisma as unknown as SeedPrisma, input, {
    info: (msg) => console.log(msg),
  });
  console.log(
    `✓ Platform seed: ${summary.roles} roles, ${summary.permissions} permissions, ` +
      `${summary.rolePermissions} grants` +
      (summary.skippedGrants.length > 0
        ? `, ${summary.skippedGrants.length} skipped (${summary.skippedGrants.join(', ')})`
        : ''),
  );

  await seedApp(prisma);

  console.log('\n✓ Database seeding completed successfully');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
