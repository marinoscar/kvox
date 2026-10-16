import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { KvoxLockError, serializeJson } from '../lock/index.js';

/**
 * The host tables a domain migration may reference by foreign key. A host
 * (the web app, KVox Desktop, the bare host) must provide all three before the
 * first domain migration runs.
 *
 * @stability experimental
 */
export const KVOX_HOST_TABLES = ['users', 'storage_objects', 'jobs'] as const;

/**
 * The host models the composed schema must declare, in the same order as
 * {@link KVOX_HOST_TABLES}.
 *
 * @stability experimental
 */
export const KVOX_HOST_MODELS = ['User', 'StorageObject', 'Job'] as const;

/**
 * One domain migration in `migrations/manifest.json`.
 *
 * @stability experimental
 */
export interface ManifestEntry {
  /** The directory name, `<timestamp>_<slug>`; it is also the name an app that already ran it keeps. */
  id: string;
  /** The domain slice that owns it: `transcripts`, `notes`, `search`, `graph` or `ask`. */
  slice: string;
  /** SHA-256 of `migration.sql`, comments included. */
  sha256: string;
  /** The host tables its foreign keys reference. */
  requiresHostTables: string[];
}

/**
 * The parsed `migrations/manifest.json`.
 *
 * @stability experimental
 */
export interface KvoxManifest {
  /** The manifest format version; a reader refuses another value. */
  manifestVersion: 1;
  /** Every migration, in the order they run (ids sort). */
  migrations: ManifestEntry[];
}

/**
 * A raw-SQL object an index inventory records.
 *
 * @stability experimental
 */
export interface RawSqlIndexEntry {
  /** The index name. */
  name: string;
  /** The table it is on. */
  table: string;
  /** `pg_indexes.indexdef` of the index, the text `platform db drift` asserts against. */
  definition: string;
}

/**
 * A PostgreSQL extension the domain needs.
 *
 * @stability experimental
 */
export interface ExtensionEntry {
  /** The extension name as `pg_extension.extname` reports it. */
  name: string;
  /** The oldest version the domain works with, when one matters. */
  minVersion?: string;
  /** The domain slices that need it. */
  requiredBy: string[];
}

/**
 * A named object on a table (a CHECK constraint).
 *
 * @stability experimental
 */
export interface TableObject {
  /** The object name. */
  name: string;
  /** The table it belongs to. */
  table: string;
}

/**
 * A `GENERATED ALWAYS ... STORED` column.
 *
 * @stability experimental
 */
export interface GeneratedColumnEntry {
  /** The table. */
  table: string;
  /** The column. */
  column: string;
}

/**
 * A function a migration creates.
 *
 * @stability experimental
 */
export interface FunctionEntry {
  /** The function name as `pg_proc.proname` reports it. */
  name: string;
  /** The migration that creates it. */
  definedIn?: string;
}

/**
 * A trigger a migration creates.
 *
 * @stability experimental
 */
export interface TriggerEntry {
  /** The trigger name as `pg_trigger.tgname` reports it. */
  name: string;
  /** The table it is on. */
  table: string;
  /** The function it runs. */
  function: string;
}

/**
 * Objects Prisma cannot express that `kvox-db check --database` looks for in
 * `schema-objects.json`.
 *
 * @stability experimental
 */
export interface SchemaObjects {
  /** CHECK constraints by name and table. */
  checkConstraints: TableObject[];
  /** Functions by name; `definedIn` names the migration that creates it. */
  functions: FunctionEntry[];
  /** `GENERATED ALWAYS ... STORED` columns. */
  generatedColumns: GeneratedColumnEntry[];
  /** Triggers by name, their table and the function they run. */
  triggers: TriggerEntry[];
}

/**
 * The package root: the folder holding `schema/`, `migrations/` and the
 * inventories. `src/manifest` and `dist/manifest` are both two levels below it.
 *
 * @returns An absolute path.
 * @stability experimental
 */
export function kvoxDbPackageRoot(): string {
  return resolve(__dirname, '..', '..');
}

/**
 * The installed package's version.
 *
 * @param packageDir - The package folder; defaults to {@link kvoxDbPackageRoot}.
 * @returns The `version` field of its `package.json`.
 * @stability experimental
 */
export function kvoxDbVersion(packageDir: string = kvoxDbPackageRoot()): string {
  const raw = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: string };
  return raw.version ?? '0.0.0';
}

const MIGRATION_ID = /^\d{14}_[a-z0-9][a-z0-9_]*$/;

/**
 * Parses and validates the text of `migrations/manifest.json`.
 *
 * @param text - The file contents.
 * @param source - A label for error messages, usually the path.
 * @returns The manifest.
 * @throws KvoxLockError when the JSON or its shape is invalid.
 * @stability experimental
 */
export function parseManifest(text: string, source = 'manifest.json'): KvoxManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new KvoxLockError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const manifest = raw as Partial<KvoxManifest> | null;
  if (manifest === null || typeof manifest !== 'object' || manifest.manifestVersion !== 1) {
    throw new KvoxLockError(`${source}: manifestVersion must be 1`);
  }
  if (!Array.isArray(manifest.migrations)) throw new KvoxLockError(`${source}: migrations must be an array`);
  const seen = new Set<string>();
  manifest.migrations.forEach((entry, index) => {
    const e = entry as Partial<ManifestEntry>;
    const where = `${source}: migrations[${index}]`;
    if (typeof e?.id !== 'string' || !MIGRATION_ID.test(e.id)) throw new KvoxLockError(`${where}.id must look like 20260914130000_add_thing`);
    if (seen.has(e.id)) throw new KvoxLockError(`${where}.id ${e.id} is listed twice`);
    seen.add(e.id);
    if (typeof e.slice !== 'string' || e.slice === '') throw new KvoxLockError(`${where}.slice must be a non-empty string`);
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) throw new KvoxLockError(`${where}.sha256 must be 64 lowercase hex characters`);
    if (
      !Array.isArray(e.requiresHostTables) ||
      !e.requiresHostTables.every((table) => (KVOX_HOST_TABLES as readonly string[]).includes(table as string))
    ) {
      throw new KvoxLockError(`${where}.requiresHostTables must list only ${KVOX_HOST_TABLES.join(', ')}`);
    }
  });
  return { manifestVersion: 1, migrations: manifest.migrations as ManifestEntry[] };
}

/**
 * Serialises a manifest for writing (see {@link serializeJson}).
 *
 * @param manifest - The manifest.
 * @returns The file contents.
 * @stability experimental
 */
export function serializeManifest(manifest: KvoxManifest): string {
  return serializeJson(manifest);
}

/**
 * Reads `migrations/manifest.json` of a package folder.
 *
 * @param migrationsDir - The package's `migrations` folder.
 * @returns The manifest.
 * @throws KvoxLockError when the file is missing or invalid.
 * @stability experimental
 */
export function readManifest(migrationsDir: string): KvoxManifest {
  const file = join(migrationsDir, 'manifest.json');
  if (!existsSync(file)) throw new KvoxLockError(`${file} not found`);
  return parseManifest(readFileSync(file, 'utf8'), file);
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (error) {
    throw new KvoxLockError(`${file} could not be read: ${(error as Error).message}`);
  }
}

/**
 * The inventories of a package folder.
 *
 * @stability experimental
 */
export interface Inventories {
  /** `raw-sql-indexes.json`. */
  rawSqlIndexes: RawSqlIndexEntry[];
  /** `extensions.json`. */
  extensions: ExtensionEntry[];
  /** `schema-objects.json`. */
  schemaObjects: SchemaObjects;
}

/**
 * Reads `raw-sql-indexes.json`, `extensions.json` and `schema-objects.json`.
 *
 * @param packageDir - The package folder.
 * @returns The three inventories.
 * @throws KvoxLockError when one is missing or malformed.
 * @stability experimental
 */
export function readInventories(packageDir: string): Inventories {
  const rawSqlIndexes = readJson<RawSqlIndexEntry[]>(join(packageDir, 'raw-sql-indexes.json'));
  const extensions = readJson<ExtensionEntry[]>(join(packageDir, 'extensions.json'));
  const schemaObjects = readJson<SchemaObjects>(join(packageDir, 'schema-objects.json'));
  if (!Array.isArray(rawSqlIndexes) || !rawSqlIndexes.every((e) => e && typeof e.name === 'string' && typeof e.table === 'string' && typeof e.definition === 'string')) {
    throw new KvoxLockError('raw-sql-indexes.json must be an array of { name, table, definition }');
  }
  if (!Array.isArray(extensions) || !extensions.every((e) => e && typeof e.name === 'string' && Array.isArray(e.requiredBy))) {
    throw new KvoxLockError('extensions.json must be an array of { name, minVersion?, requiredBy }');
  }
  if (
    !schemaObjects ||
    !Array.isArray(schemaObjects.checkConstraints) ||
    !Array.isArray(schemaObjects.functions) ||
    !Array.isArray(schemaObjects.generatedColumns) ||
    !Array.isArray(schemaObjects.triggers)
  ) {
    throw new KvoxLockError('schema-objects.json must hold checkConstraints, functions, generatedColumns and triggers');
  }
  return { rawSqlIndexes, extensions, schemaObjects };
}

const INVENTORIES = readInventories(kvoxDbPackageRoot());

/**
 * The domain's raw-SQL indexes (partial, GiST, HNSW, trigram and generated-vector
 * GIN indexes): intentional schema drift that exists only in `migration.sql`
 * and is never declared in a fragment. Hosts merge it into `platform.lock`
 * `rawSqlIndexes` so `platform db drift` keeps asserting it.
 *
 * @stability experimental
 */
export const KVOX_RAW_SQL_INDEXES: readonly RawSqlIndexEntry[] = Object.freeze(
  INVENTORIES.rawSqlIndexes.map((entry) => Object.freeze({ ...entry })),
);

/**
 * The PostgreSQL extensions any host of the domain must provide. The command
 * never creates them: a missing one is reported with the statement to run as a
 * superuser.
 *
 * @stability experimental
 */
export const KVOX_EXTENSIONS: readonly ExtensionEntry[] = Object.freeze(
  INVENTORIES.extensions.map((entry) => Object.freeze({ ...entry })),
);

/**
 * The fragment files of a package's `schema` folder (`kvox.<slice>.prisma`).
 *
 * @param schemaDir - The package's `schema` folder.
 * @returns File names, sorted.
 * @stability experimental
 */
export function listPackageFragments(schemaDir: string): string[] {
  if (!existsSync(schemaDir)) return [];
  return readdirSync(schemaDir)
    .filter((name) => /^kvox\.[a-z0-9-]+\.prisma$/.test(name))
    .sort();
}
