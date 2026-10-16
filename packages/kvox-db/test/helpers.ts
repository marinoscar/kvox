import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The fixture host app: a prisma/ folder with the three host models and two host migrations. */
export const FIXTURE_HOST = resolve(__dirname, 'fixtures', 'host-app');

/** The package folder under test. */
export const PACKAGE_DIR = resolve(__dirname, '..');

const created: string[] = [];

/** Copies the fixture host app to a fresh temp folder and returns it. */
export function freshHost(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kvox-db-host-'));
  cpSync(FIXTURE_HOST, dir, { recursive: true });
  created.push(dir);
  return dir;
}

/** Copies the package's data (schema, migrations, inventories, package.json) to a temp folder. */
export function freshPackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kvox-db-pkg-'));
  for (const name of ['schema', 'migrations', 'raw-sql-indexes.json', 'extensions.json', 'schema-objects.json', 'package.json']) {
    cpSync(join(PACKAGE_DIR, name), join(dir, name), { recursive: true });
  }
  created.push(dir);
  return dir;
}

/** Removes every folder the helpers made. Call from `afterEach`/`afterAll`. */
export function cleanup(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
