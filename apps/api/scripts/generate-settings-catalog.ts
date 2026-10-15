/**
 * Generate prisma/catalog/system-settings-defaults.json (issue #465, epic #462).
 *
 * The `global` system_settings row is seeded from this committed snapshot of
 * the composed namespace defaults, for the same reason the permission catalog
 * exists: the seed runs without `src/`. The row is written once and never
 * overwritten (seedPlatform), so an existing deployment keeps what an
 * administrator edited.
 *
 * Since #466 this renders the platform registry's composed defaults
 * (`renderSystemSettingsCatalog` from `@marinoscar/platform-api/settings`) over
 * the namespaces `src/settings/registry` registers.
 *
 *   npm run catalog:settings            write the file
 *   npm run catalog:settings -- --check exit 1 when the file is stale
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// MUST stay first: registers the settings namespaces the composers read.
import '../src/kvox.manifest';
import { renderSystemSettingsCatalog } from '@marinoscar/platform-api/settings';

const CATALOG_PATH = join(
  __dirname,
  '..',
  'prisma',
  'catalog',
  'system-settings-defaults.json',
);

export function renderSettingsCatalog(): string {
  return renderSystemSettingsCatalog();
}

function main(): void {
  const rendered = renderSettingsCatalog();

  if (process.argv.includes('--check')) {
    let current: string | undefined;
    try {
      current = readFileSync(CATALOG_PATH, 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== rendered) {
      console.error(
        'prisma/catalog/system-settings-defaults.json is stale. Run `npm run catalog:settings` and commit the result.',
      );
      process.exit(1);
    }
    console.log('prisma/catalog/system-settings-defaults.json is up to date');
    return;
  }

  mkdirSync(dirname(CATALOG_PATH), { recursive: true });
  writeFileSync(CATALOG_PATH, rendered);
  console.log(`wrote ${CATALOG_PATH}`);
}

if (require.main === module) {
  main();
}
