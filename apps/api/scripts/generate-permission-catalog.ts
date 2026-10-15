/**
 * Generate prisma/catalog/permissions.json (issue #465, epic #462).
 *
 * The seed (prisma/seed.ts) runs from `prisma/` and the production image
 * carries `prisma/` but not `src/`, so it cannot import the permission
 * registries. It reads this committed, generated snapshot instead:
 * `seedPlatform(prisma, platformSeedInputFrom(readSeedSnapshot('prisma/catalog'), env))`.
 *
 * The catalog is whatever the registries hold after the app's registrations
 * ran: the platform roles and permission sets plus KVox's own org-scoped
 * domain permissions (src/app-registrations). Add a permission by registering
 * it there and re-running this script, never by editing the JSON.
 *
 *   npm run catalog:permissions            write the file
 *   npm run catalog:permissions -- --check exit 1 when the file is stale
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Side effect: fills the role and permission registries (platform + KVox).
import '../src/app-registrations/registrations';
import { buildPermissionCatalog } from '@marinoscar/platform-api/core';

const CATALOG_PATH = join(__dirname, '..', 'prisma', 'catalog', 'permissions.json');

export function renderPermissionCatalog(): string {
  return `${JSON.stringify(buildPermissionCatalog(), null, 2)}\n`;
}

function main(): void {
  const rendered = renderPermissionCatalog();

  if (process.argv.includes('--check')) {
    let current: string | undefined;
    try {
      current = readFileSync(CATALOG_PATH, 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== rendered) {
      console.error(
        'prisma/catalog/permissions.json is stale. Run `npm run catalog:permissions` and commit the result.',
      );
      process.exit(1);
    }
    console.log('prisma/catalog/permissions.json is up to date');
    return;
  }

  mkdirSync(dirname(CATALOG_PATH), { recursive: true });
  writeFileSync(CATALOG_PATH, rendered);
  console.log(`wrote ${CATALOG_PATH}`);
}

if (require.main === module) {
  main();
}
