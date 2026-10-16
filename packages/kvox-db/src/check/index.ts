import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import { KVOX_LOCK_FILE, normaliseDefinition, readKvoxLock, readPlatformLock, sha256Hex, type LockedRawSqlIndex } from '../lock/index.js';
import {
  kvoxDbPackageRoot,
  listPackageFragments,
  readInventories,
  readManifest,
  type Inventories,
  type GeneratedColumnEntry,
  type KvoxManifest,
  type RawSqlIndexEntry,
  type TableObject,
} from '../manifest/index.js';
import { columnsOfDefinition, scanCreatedIndexes, splitSqlStatements, type CreatedIndex } from '../sql/index.js';
import { renderFragmentCopy } from '../sync/index.js';

/**
 * One finding of {@link checkKvoxInstall}.
 *
 * @stability experimental
 */
export interface KvoxCheckProblem {
  /** A stable code, for example `INSTALLED_MODIFIED` or `INDEX_MISSING`. */
  code: string;
  /** What is wrong and how to fix it. */
  message: string;
}

/**
 * The outcome of {@link checkKvoxInstall}.
 *
 * @stability experimental
 */
export interface KvoxCheckResult {
  /** True when there is no problem. */
  ok: boolean;
  /** Every problem found, in a stable order. */
  problems: KvoxCheckProblem[];
  /** Informational lines (counts of what was checked). */
  notes: string[];
}

/**
 * Options of {@link checkKvoxInstall}.
 *
 * @stability experimental
 */
export interface KvoxCheckOptions {
  /** The host app folder: the one that holds `prisma/`. */
  root: string;
  /** Also compare a live database with the inventories (only `SELECT`s on catalogs). */
  database?: boolean;
  /** The connection string for `database`; defaults to `process.env.DATABASE_URL`. */
  databaseUrl?: string;
  /** The package folder; defaults to the installed package. */
  packageDir?: string;
  /** A catalog already read (tests, or a host that connects some other way); skips the connection. */
  catalog?: DatabaseCatalog;
}

/**
 * Thrown for a usage error: `--database` without a connection string. The
 * command maps it to exit code 2.
 *
 * @stability experimental
 */
export class KvoxCheckUsageError extends Error {
  /** @param message - What the caller must provide. */
  constructor(message: string) {
    super(message);
    this.name = 'KvoxCheckUsageError';
  }
}

/**
 * An installed extension.
 *
 * @stability experimental
 */
export interface CatalogExtension {
  /** `pg_extension.extname`. */
  name: string;
  /** `pg_extension.extversion`. */
  version: string;
}

/**
 * What a live database holds, as far as the inventories ask.
 *
 * @stability experimental
 */
export interface DatabaseCatalog {
  /** `pg_extension`: name and version. */
  extensions: CatalogExtension[];
  /** `pg_indexes`: name and table. */
  indexes: TableObject[];
  /** `pg_trigger` (not internal): name and table. */
  triggers: TableObject[];
  /** `pg_proc`: function names in the current schema. */
  functions: string[];
  /** `pg_constraint` of type CHECK: name and table. */
  constraints: TableObject[];
  /** `information_schema.columns` with `is_generated = 'ALWAYS'`. */
  generatedColumns: GeneratedColumnEntry[];
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Compares a database catalog with the inventories: the extensions
 * (`extensions.json`), the raw-SQL indexes (`raw-sql-indexes.json`) and the
 * generated columns, CHECK constraints, function and triggers
 * (`schema-objects.json`). A missing extension is reported with the statement
 * a superuser must run; nothing is ever created here.
 *
 * @param catalog - From {@link readDatabaseCatalog}.
 * @param inventories - From {@link readInventories}.
 * @returns Every missing object, in inventory order.
 * @stability experimental
 */
export function checkDatabaseCatalog(catalog: DatabaseCatalog, inventories: Inventories): KvoxCheckProblem[] {
  const problems: KvoxCheckProblem[] = [];
  const extensions = new Map(catalog.extensions.map((extension) => [extension.name, extension.version]));
  for (const extension of inventories.extensions) {
    const version = extensions.get(extension.name);
    const needed = `required by ${extension.requiredBy.join(', ')}`;
    if (version === undefined) {
      problems.push({
        code: 'EXTENSION_MISSING',
        message: `extension ${extension.name} is not installed (${needed}). kvox-db never creates one; ask a database superuser to run: CREATE EXTENSION IF NOT EXISTS ${extension.name};`,
      });
    } else if (extension.minVersion !== undefined && compareVersions(version, extension.minVersion) < 0) {
      problems.push({
        code: 'EXTENSION_TOO_OLD',
        message: `extension ${extension.name} is ${version} but ${extension.minVersion} or newer is needed (${needed}); ask a superuser to run: ALTER EXTENSION ${extension.name} UPDATE;`,
      });
    }
  }
  const indexes = new Map(catalog.indexes.map((index) => [index.name, index.table]));
  for (const index of inventories.rawSqlIndexes) {
    const table = indexes.get(index.name);
    if (table === undefined) problems.push({ code: 'INDEX_MISSING', message: `${index.name}: not in pg_indexes (expected on ${index.table})` });
    else if (table !== index.table) problems.push({ code: 'INDEX_MISSING', message: `${index.name}: found on ${table}, expected on ${index.table}` });
  }
  const columns = new Set(catalog.generatedColumns.map((column) => `${column.table}.${column.column}`));
  for (const column of inventories.schemaObjects.generatedColumns) {
    if (!columns.has(`${column.table}.${column.column}`)) {
      problems.push({ code: 'GENERATED_COLUMN_MISSING', message: `${column.table}.${column.column}: not a GENERATED ALWAYS column (information_schema.columns.is_generated)` });
    }
  }
  const constraints = new Set(catalog.constraints.map((constraint) => `${constraint.table}.${constraint.name}`));
  for (const constraint of inventories.schemaObjects.checkConstraints) {
    if (!constraints.has(`${constraint.table}.${constraint.name}`)) problems.push({ code: 'CONSTRAINT_MISSING', message: `${constraint.name}: CHECK constraint missing on ${constraint.table}` });
  }
  const functions = new Set(catalog.functions);
  for (const fn of inventories.schemaObjects.functions) {
    if (!functions.has(fn.name)) problems.push({ code: 'FUNCTION_MISSING', message: `${fn.name}: function missing (pg_proc)` });
  }
  const triggers = new Set(catalog.triggers.map((trigger) => `${trigger.table}.${trigger.name}`));
  for (const trigger of inventories.schemaObjects.triggers) {
    if (!triggers.has(`${trigger.table}.${trigger.name}`)) problems.push({ code: 'TRIGGER_MISSING', message: `${trigger.name}: trigger missing on ${trigger.table} (pg_trigger)` });
  }
  return problems;
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Record<string, string>[] }>;
  end(): Promise<void>;
}

function loadPg(root: string): new (config: { connectionString: string }) => PgClient {
  // Resolved from the host first (any Prisma + pg app has it), then from this package: `pg` is not
  // a peer of the command, because the offline commands never need it.
  const fromHost = createRequire(join(resolve(root), 'noop.js'));
  try {
    return (fromHost('pg') as { Client: new (config: { connectionString: string }) => PgClient }).Client;
  } catch {
    try {
      return (createRequire(__filename)('pg') as { Client: new (config: { connectionString: string }) => PgClient }).Client;
    } catch {
      throw new KvoxCheckUsageError('check --database needs the `pg` package; install it in the app (npm install pg)');
    }
  }
}

/**
 * Reads what {@link checkDatabaseCatalog} needs from a live database with
 * catalog `SELECT`s only.
 *
 * @param url - The connection string (`DATABASE_URL`).
 * @param root - The host app folder, where the `pg` package is resolved from.
 * @returns The catalog of the current schema.
 * @throws KvoxCheckUsageError when `pg` cannot be loaded.
 * @stability experimental
 */
export async function readDatabaseCatalog(url: string, root: string): Promise<DatabaseCatalog> {
  const Client = loadPg(root);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const rows = async (sql: string) => (await client.query(sql)).rows;
    const extensions = (await rows('SELECT extname, extversion FROM pg_extension')).map((row) => ({ name: row.extname!, version: row.extversion! }));
    const indexes = (await rows('SELECT indexname, tablename FROM pg_indexes WHERE schemaname = current_schema()')).map((row) => ({ name: row.indexname!, table: row.tablename! }));
    const triggers = (
      await rows(
        'SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = current_schema()',
      )
    ).map((row) => ({ name: row.tgname!, table: row.relname! }));
    const functions = (
      await rows('SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema()')
    ).map((row) => row.proname!);
    const constraints = (
      await rows(
        "SELECT k.conname, c.relname FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype = 'c' AND n.nspname = current_schema()",
      )
    ).map((row) => ({ name: row.conname!, table: row.relname! }));
    const generatedColumns = (
      await rows("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND is_generated = 'ALWAYS'")
    ).map((row) => ({ table: row.table_name!, column: row.column_name! }));
    return { extensions, indexes, triggers, functions, constraints, generatedColumns };
  } finally {
    await client.end();
  }
}

/**
 * An index declaration found in a fragment.
 *
 * @stability experimental
 */
export interface FragmentIndexDeclaration {
  /** The fragment label. */
  file: string;
  /** The 1-based line of the declaration. */
  line: number;
  /** The Prisma model name. */
  model: string;
  /** The database table (`@@map`, else the model name). */
  table: string;
  /** Which attribute declared it. */
  kind: '@@unique' | '@@index' | '@unique';
  /** The database columns, in order. */
  columns: string[];
  /** The `map:` or `name:` arguments, which name the index. */
  names: string[];
}

function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const c of text) {
    if (quote) {
      current += c;
      if (c === quote) quote = '';
    } else if (c === '"') {
      quote = c;
      current += c;
    } else if (c === '(' || c === '[') {
      depth += 1;
      current += c;
    } else if (c === ')' || c === ']') {
      depth -= 1;
      current += c;
    } else if (c === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * Reads the index declarations (`@@unique`, `@@index`, `@unique`) of every
 * `model` in a fragment, with field names translated to database columns
 * through `@map` and the table through `@@map`.
 *
 * @param file - A label for messages.
 * @param text - The fragment text.
 * @returns One entry per declaration.
 * @stability experimental
 */
export function scanFragmentIndexes(file: string, text: string): FragmentIndexDeclaration[] {
  const found: FragmentIndexDeclaration[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let model: { name: string; body: { text: string; line: number }[] } | undefined;
  const flush = () => {
    if (!model) return;
    const columnOf = new Map<string, string>();
    let table = model.name;
    for (const { text: line } of model.body) {
      const t = line.trim();
      const tableMap = /^@@map\(\s*"([^"]+)"\s*\)/.exec(t);
      if (tableMap) table = tableMap[1]!;
      const field = /^([A-Za-z_]\w*)\s+[A-Za-z_]\w*(?:\([^)]*\))?(?:\[\])?\??(\s.*)?$/.exec(t);
      if (field && !t.startsWith('@@') && !t.startsWith('//')) columnOf.set(field[1]!, /@map\(\s*"([^"]+)"\s*\)/.exec(field[2] ?? '')?.[1] ?? field[1]!);
    }
    const toColumn = (name: string) => columnOf.get(name) ?? name;
    for (const { text: line, line: lineNo } of model.body) {
      const t = line.trim();
      const block = /^@@(unique|index)\s*\((.*)\)\s*(?:\/\/.*)?$/.exec(t);
      if (block) {
        const args = splitArguments(block[2]!);
        const list = /^\[(.*)\]$/s.exec(args[0] ?? '');
        if (!list) continue;
        const columns = splitArguments(list[1]!).map((element) => toColumn(element.replace(/\(.*$/s, '').trim()));
        const names = args.slice(1).flatMap((arg) => {
          const m = /^(?:map|name)\s*:\s*"([^"]+)"$/.exec(arg.trim());
          return m ? [m[1]!] : [];
        });
        found.push({ file, line: lineNo, model: model.name, table, kind: block[1] === 'unique' ? '@@unique' : '@@index', columns, names });
        continue;
      }
      const field = /^([A-Za-z_]\w*)\s+[A-Za-z_]\w*(?:\([^)]*\))?(?:\[\])?\??(\s.*)?$/.exec(t);
      if (field && !t.startsWith('//') && /(^|\s)@unique\b/.test(field[2] ?? '')) {
        const given = /@unique\([^)]*map\s*:\s*"([^"]+)"/.exec(field[2] ?? '');
        found.push({ file, line: lineNo, model: model.name, table, kind: '@unique', columns: [toColumn(field[1]!)], names: given ? [given[1]!] : [] });
      }
    }
    model = undefined;
  };
  lines.forEach((text, i) => {
    if (!model) {
      const header = /^model\s+([A-Za-z_]\w*)\s*\{\s*$/.exec(text);
      if (header) model = { name: header[1]!, body: [] };
    } else if (text === '}') {
      flush();
    } else {
      model.body.push({ text, line: i + 1 });
    }
  });
  return found;
}

/**
 * The raw-SQL index tripwire, as a pure function: it fails when a fragment
 * declares `@@unique`, `@@index` or `@unique` under the name of a listed index,
 * or `@@unique` / `@unique` on the table and key columns of a listed unique
 * index (Prisma would build a full unique index there, not the partial one). The inventory indexes are intentional schema
 * drift; never "fix" one with a declaration.
 *
 * @param fragments - The fragments, as `{ file, text }`.
 * @param indexes - The inventory (`raw-sql-indexes.json`).
 * @returns One `FRAGMENT_DECLARES_RAW_INDEX` problem per offending declaration.
 * @stability experimental
 */
export function checkFragmentDeclarations(
  fragments: readonly { file: string; text: string }[],
  indexes: readonly RawSqlIndexEntry[],
): KvoxCheckProblem[] {
  const problems: KvoxCheckProblem[] = [];
  for (const fragment of fragments) {
    for (const declared of scanFragmentIndexes(fragment.file, fragment.text)) {
      for (const index of indexes) {
        const sameName = declared.names.includes(index.name);
        // Same table and key columns counts only for a uniqueness declaration against a unique raw index:
        // that is the "fix" the tripwire exists to stop (Prisma would build a full unique index, not the
        // partial one). A plain @@index on the same columns is a separate, legitimate b-tree (for example
        // kg_relations.from_speaker_id next to kg_relations_speaker_link_uniq_idx).
        const keyColumns = sameName || declared.kind === '@@index' || !/^CREATE\s+UNIQUE\b/i.test(index.definition) ? null : columnsOfDefinition(index.definition);
        const sameKey =
          !sameName &&
          declared.table === index.table &&
          keyColumns !== null &&
          keyColumns.length === declared.columns.length &&
          keyColumns.every((column, i) => column === declared.columns[i]);
        if (sameName || sameKey) {
          problems.push({
            code: 'FRAGMENT_DECLARES_RAW_INDEX',
            message: `${fragment.file}:${declared.line}: ${declared.model} declares ${declared.kind} on (${declared.columns.join(', ')}) which is the raw-SQL index ${index.name}; remove it (intentional drift, see README "Data")`,
          });
        }
      }
    }
  }
  return problems;
}

/**
 * Checks the package's own consistency, offline: every manifest hash equals its
 * file, every migration directory is listed, the inventory matches what the
 * migrations create (partial, expression, GIN, GiST, HNSW and trigram indexes),
 * no fragment redeclares a listed index, and every `schema-objects.json` name
 * appears in a migration.
 *
 * @param packageDir - The package folder.
 * @returns Every problem found; empty when the package is consistent.
 * @stability experimental
 */
export function checkPackage(packageDir: string): KvoxCheckProblem[] {
  const problems: KvoxCheckProblem[] = [];
  const migrationsDir = join(packageDir, 'migrations');
  const manifest = readManifest(migrationsDir);
  const inventories = readInventories(packageDir);
  const sqlById = new Map<string, string>();
  const listedIds = new Set(manifest.migrations.map((entry) => entry.id));
  for (const entry of manifest.migrations) {
    const file = join(migrationsDir, entry.id, 'migration.sql');
    if (!existsSync(file)) {
      problems.push({ code: 'PACKAGE_MIGRATION_MISSING', message: `migrations/${entry.id}/migration.sql does not exist` });
      continue;
    }
    const bytes = readFileSync(file);
    if (sha256Hex(bytes) !== entry.sha256) {
      problems.push({ code: 'PACKAGE_MIGRATION_MODIFIED', message: `migrations/${entry.id}/migration.sql differs from manifest.json (sha256 ${sha256Hex(bytes).slice(0, 12)} vs ${entry.sha256.slice(0, 12)}); a published migration is never edited` });
    }
    sqlById.set(entry.id, bytes.toString('utf8'));
  }
  for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !listedIds.has(entry.name)) {
      problems.push({ code: 'PACKAGE_MIGRATION_UNLISTED', message: `migrations/${entry.name} has no entry in manifest.json` });
    }
  }
  const ids = manifest.migrations.map((entry) => entry.id);
  if (ids.some((id, i) => i > 0 && id <= ids[i - 1]!)) {
    problems.push({ code: 'MANIFEST_ORDER', message: 'manifest.json migrations must be in ascending id order' });
  }

  // Indexes that survive the whole history, in statement order.
  const live = new Map<string, CreatedIndex>();
  for (const entry of manifest.migrations) {
    const sql = sqlById.get(entry.id);
    if (sql === undefined) continue;
    for (const statement of splitSqlStatements(sql)) {
      const created = scanCreatedIndexes([statement])[0];
      if (created) {
        live.set(created.name, created);
        continue;
      }
      const drop = /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(.+)$/is.exec(statement);
      if (drop) {
        for (const target of drop[1]!.split(',')) live.delete(target.trim().replace(/^"|"$/g, '').replace(/^public\./, ''));
        continue;
      }
      const rename = /^ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?("?[\w$.]+"?)\s+RENAME\s+TO\s+("?[\w$]+"?)$/i.exec(statement);
      if (rename) {
        const from = rename[1]!.replace(/^"|"$/g, '').replace(/^public\./, '');
        const to = rename[2]!.replace(/^"|"$/g, '');
        const found = live.get(from);
        if (found) {
          live.delete(from);
          live.set(to, { ...found, name: to });
        }
      }
    }
  }
  const listed = new Map(inventories.rawSqlIndexes.map((index) => [index.name, index]));
  for (const index of live.values()) {
    const special = index.partial || index.columns === null || index.method !== 'btree';
    if (special && !listed.has(index.name)) {
      problems.push({ code: 'UNLISTED_RAW_INDEX', message: `${index.name}: a migration creates a partial, expression or ${index.method} index on ${index.table} that raw-sql-indexes.json does not list; add it with its pg_indexes definition` });
    }
  }
  for (const index of inventories.rawSqlIndexes) {
    const actual = live.get(index.name);
    if (!actual) problems.push({ code: 'LISTED_INDEX_NOT_FOUND', message: `${index.name}: listed in raw-sql-indexes.json but no migration leaves an index of that name` });
    else if (actual.table !== index.table) problems.push({ code: 'LISTED_INDEX_MISMATCH', message: `${index.name}: the migrations say table ${actual.table}, the inventory says ${index.table}` });
  }

  const schemaDir = join(packageDir, 'schema');
  const fragments = listPackageFragments(schemaDir).map((name) => ({ file: `schema/${name}`, text: readFileSync(join(schemaDir, name), 'utf8') }));
  problems.push(...checkFragmentDeclarations(fragments, inventories.rawSqlIndexes));

  const allSql = [...sqlById.values()].join('\n');
  const names = [
    ...inventories.schemaObjects.checkConstraints.map((o) => o.name),
    ...inventories.schemaObjects.functions.map((o) => o.name),
    ...inventories.schemaObjects.triggers.map((o) => o.name),
    ...inventories.schemaObjects.generatedColumns.map((o) => o.column),
  ];
  for (const name of names) {
    if (!allSql.includes(name)) problems.push({ code: 'SCHEMA_OBJECT_NOT_IN_MIGRATIONS', message: `${name}: listed in schema-objects.json but no migration mentions it` });
  }
  return problems;
}

function checkInstalled(root: string, packageDir: string, manifest: KvoxManifest, inventories: Inventories): { problems: KvoxCheckProblem[]; notes: string[] } {
  const problems: KvoxCheckProblem[] = [];
  const notes: string[] = [];
  const prismaDir = join(resolve(root), 'prisma');
  const schemaDir = join(packageDir, 'schema');

  const names = listPackageFragments(schemaDir);
  for (const name of names) {
    const installed = join(prismaDir, 'fragments', name);
    if (!existsSync(installed)) {
      problems.push({ code: 'FRAGMENT_MISSING', message: `prisma/fragments/${name} is not installed; run kvox-db sync` });
      continue;
    }
    const expected = renderFragmentCopy(name, readFileSync(join(schemaDir, name), 'utf8'));
    if (readFileSync(installed, 'utf8').replace(/\r\n/g, '\n') !== expected) {
      problems.push({ code: 'FRAGMENT_MODIFIED', message: `prisma/fragments/${name} differs from the package copy; it is generated, never edit it (run kvox-db sync to restore it; do not run prisma format on it)` });
    }
  }
  const fragmentsDir = join(prismaDir, 'fragments');
  if (existsSync(fragmentsDir)) {
    for (const name of readdirSync(fragmentsDir).sort()) {
      if (/^kvox\..*\.prisma$/.test(name) && !names.includes(name)) {
        problems.push({ code: 'FRAGMENT_STALE', message: `prisma/fragments/${name} has no source in the package; run kvox-db sync to remove it` });
      }
    }
  }

  const platform = readPlatformLock(join(prismaDir, 'platform.lock'));
  if (platform === undefined) {
    notes.push('prisma/platform.lock not found; raw-SQL index merge not checked');
  } else {
    const entries = (Array.isArray(platform.rawSqlIndexes) ? platform.rawSqlIndexes : []) as LockedRawSqlIndex[];
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    for (const index of inventories.rawSqlIndexes) {
      const entry = byName.get(index.name);
      if (entry === undefined) problems.push({ code: 'PLATFORM_LOCK_INDEX_MISSING', message: `${index.name}: not in platform.lock rawSqlIndexes; run kvox-db sync` });
      else if (normaliseDefinition(entry.definition) !== normaliseDefinition(index.definition)) {
        problems.push({ code: 'PLATFORM_LOCK_INDEX_DIFFERS', message: `${index.name}: platform.lock holds another definition than the package` });
      }
    }
  }
  const lock = readKvoxLock(join(prismaDir, KVOX_LOCK_FILE));
  if (lock === undefined) {
    problems.push({ code: 'LOCK_MISSING', message: `prisma/${KVOX_LOCK_FILE} not found; run kvox-db sync` });
    return { problems, notes };
  }
  const byId = new Map(manifest.migrations.map((entry) => [`kvox:${entry.id}`, entry]));
  const locked = new Set<string>();
  for (const entry of lock.migrations) {
    locked.add(entry.originId);
    const file = join(prismaDir, 'migrations', entry.installedDir, 'migration.sql');
    if (!existsSync(file)) {
      problems.push({ code: 'LOCK_ENTRY_MISSING', message: `${entry.originId}: kvox.lock says it is installed as ${entry.installedDir} but ${file} does not exist` });
      continue;
    }
    const hash = sha256Hex(readFileSync(file));
    if (hash !== entry.sha256) {
      problems.push({ code: 'INSTALLED_MODIFIED', message: `prisma/migrations/${entry.installedDir}/migration.sql differs from kvox.lock (sha256 ${hash.slice(0, 12)} vs ${entry.sha256.slice(0, 12)}); an installed migration is never edited, comments included` });
    }
    const source = byId.get(entry.originId);
    if (source === undefined) {
      problems.push({ code: 'LOCK_ENTRY_UNKNOWN', message: `${entry.originId}: recorded in kvox.lock but the package does not list it` });
    } else if (source.sha256 !== entry.sha256) {
      problems.push({ code: 'LOCK_DIFFERS_FROM_PACKAGE', message: `${entry.originId}: kvox.lock records ${entry.sha256.slice(0, 12)} but the package migration is ${source.sha256.slice(0, 12)}` });
    }
  }
  for (const entry of manifest.migrations) {
    if (!locked.has(`kvox:${entry.id}`)) problems.push({ code: 'NOT_INSTALLED', message: `kvox:${entry.id} is in the package but not in kvox.lock; run kvox-db sync` });
  }

  notes.push(`${lock.migrations.length} installed migration(s), ${names.length} fragment(s) checked`);
  return { problems, notes };
}

/**
 * Checks that an app's installed copies still match the package: the package
 * against its own manifest, every fragment copy and migration byte-for-byte,
 * `kvox.lock` against the folder, and `platform.lock` against the inventory.
 * With `database`, also checks a live database for the extensions, raw-SQL
 * indexes, generated columns, CHECK constraints, function and triggers.
 * Reads files and runs catalog `SELECT`s only; never creates anything.
 *
 * @param opts - See {@link KvoxCheckOptions}.
 * @returns The problems found (none means ok).
 * @throws KvoxCheckUsageError when `database` is set and no connection string is available.
 * @throws KvoxLockError when a lock, the manifest or an inventory is malformed.
 * @stability experimental
 */
export async function checkKvoxInstall(opts: KvoxCheckOptions): Promise<KvoxCheckResult> {
  const packageDir = resolve(opts.packageDir ?? kvoxDbPackageRoot());
  const manifest = readManifest(join(packageDir, 'migrations'));
  const inventories = readInventories(packageDir);
  const problems = checkPackage(packageDir);
  const installed = checkInstalled(opts.root, packageDir, manifest, inventories);
  problems.push(...installed.problems);
  const notes = [...installed.notes];
  if (opts.database === true) {
    const url = opts.databaseUrl ?? process.env.DATABASE_URL;
    if (opts.catalog === undefined && (url === undefined || url === '')) {
      throw new KvoxCheckUsageError('check --database: DATABASE_URL is not set (the api scripts build it from POSTGRES_*)');
    }
    const catalog = opts.catalog ?? (await readDatabaseCatalog(url!, opts.root));
    problems.push(...checkDatabaseCatalog(catalog, inventories));
    notes.push(`database: ${inventories.extensions.length} extension(s), ${inventories.rawSqlIndexes.length} index(es), ${inventories.schemaObjects.triggers.length} trigger(s) compared`);
  }
  return { ok: problems.length === 0, problems, notes };
}
