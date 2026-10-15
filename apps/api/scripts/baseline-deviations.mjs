#!/usr/bin/env node
/**
 * baseline-deviations.mjs - TEMPORARY tooling for the platform baseline (#463).
 *
 * `platform db baseline --through 14` diffs the platform history up to 0014
 * against the live database (B3) and prints every statement the database has
 * that the platform history does not, as `BLOCKING:` lines. For KVox that is
 * (a) every domain object the 22 app-only migrations created, and (b) the four
 * columns KVox added to two platform tables. Pasting 260 statements into
 * `platform.lock` by hand would be an unverifiable act of faith, so this script
 * reads a SAVED dry-run report and proves each statement before it will turn
 * it into a `deviations` entry:
 *
 *   - the four deviation columns (`storage_objects.managed_by`, `part_size`,
 *     `allowed_emails.reminder_count`, `last_reminder_at`) are the ONLY thing
 *     that may touch a platform table; each must also be added by one of the
 *     app-only migrations;
 *   - every other statement must target a table or enum type that an app-only
 *     migration CREATEs (a KVox domain object). A foreign key FROM a domain
 *     table TO a platform table is fine (it alters the domain table);
 *   - anything else - an index, column, constraint or drop on a platform table
 *     that is not one of the four columns - is a REAL difference between the
 *     live database and the platform history. The script exits 1 and prints it.
 *     Stop and report it; never declare it.
 *
 * Usage:
 *   node scripts/baseline-deviations.mjs <report.txt> [--migrations <dir>]
 *                                        [--lock <platform.lock> --write]
 *
 *   <report.txt>   saved output of `npm run db:baseline -- --through 14`
 *   --migrations   prisma/migrations directory (default: prisma/migrations,
 *                  relative to the apps/api directory this script lives in)
 *   --lock/--write merge the three entries into the lock's `deviations`
 *                  (entries with the same id are replaced; other keys and
 *                  entries are kept). Without --write the entries are printed
 *                  as JSON and nothing is written.
 *
 * Exit codes: 0 all statements proven, 1 a statement was refused, 2 usage error.
 *
 * Removed together with the deviations: #465 (reminder columns) and #469
 * (`managed_by`, `part_size`).
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** The only columns a platform table may differ by, and the deviation that owns each. */
export const DEVIATION_COLUMNS = {
  storage_objects: {
    id: 'kvox:storage-managed-by-part-size',
    columns: ['managed_by', 'part_size'],
  },
  allowed_emails: {
    id: 'kvox:allowlist-reminders',
    columns: ['reminder_count', 'last_reminder_at'],
  },
};

export const DOMAIN_ID = 'kvox:domain-schema';

const REASONS = {
  'kvox:storage-managed-by-part-size':
    'KVox-only columns storage_objects.managed_by and storage_objects.part_size (migration 20260914120000_add_storage_part_size_and_managed_by). Temporary: #469 moves managed_by to kvox_object_ownership and drops part_size.',
  'kvox:allowlist-reminders':
    'KVox-only columns allowed_emails.reminder_count and allowed_emails.last_reminder_at (migration 20260918120000_add_allowlist_reminder_tracking). Temporary: #465 moves them to kvox_allowlist_reminders.',
  [DOMAIN_ID]:
    'KVox domain tables created by app-only migrations; not a change to a platform table.',
};

/** Same normalisation the baseline applies before comparing a statement to `expectDiff`. */
export function normaliseStatement(statement) {
  return statement.replace(/"public"\./g, '').replace(/\s+/g, ' ').trim();
}

/** The `BLOCKING:` statements of a saved dry-run report, in report order. */
export function parseBlockingStatements(report) {
  return report
    .split(/\r?\n/)
    .filter((l) => /^\s*BLOCKING:\s/.test(l))
    .map((l) => normaliseStatement(l.replace(/^\s*BLOCKING:\s*/, '')));
}

/** The `app-only: <dir>` directories of a saved dry-run report. */
export function parseAppOnlyDirectories(report) {
  return report
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*app-only:\s+(\S+)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const IDENT = '"?([A-Za-z_][A-Za-z0-9_]*)"?';

/**
 * What the app-only migrations create and which platform columns they add.
 *
 * @param {Array<[string, string]>} migrations `[directory, sql]` of the app-only migrations.
 */
export function collectAppObjects(migrations) {
  const tables = new Set();
  const types = new Set();
  const addedColumns = new Set(); // `table.column`
  for (const [, rawSql] of migrations) {
    const sql = stripSqlComments(rawSql);
    for (const m of sql.matchAll(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"?public"?\\.)?${IDENT}`, 'gi'))) {
      tables.add(m[1]);
    }
    for (const m of sql.matchAll(new RegExp(`CREATE\\s+TYPE\\s+(?:"?public"?\\.)?${IDENT}`, 'gi'))) {
      types.add(m[1]);
    }
    for (const stmt of sql.split(';')) {
      const alter = stmt.match(new RegExp(`^\\s*ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:"?public"?\\.)?${IDENT}\\s+([\\s\\S]*)$`, 'i'));
      if (!alter) continue;
      for (const col of alter[2].matchAll(new RegExp(`ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, 'gi'))) {
        addedColumns.add(`${alter[1]}.${col[1]}`);
      }
    }
  }
  return { tables, types, addedColumns };
}

/**
 * The object a statement is about: the table or type it creates or alters, or
 * the table an index is built on. `null` when the statement is not one of the
 * shapes `prisma migrate diff` prints for an added object.
 */
export function statementTarget(statement) {
  const patterns = [
    [new RegExp(`^CREATE TYPE ${IDENT}\\b`, 'i'), 'type'],
    [new RegExp(`^CREATE TABLE ${IDENT}\\b`, 'i'), 'table'],
    [new RegExp(`^ALTER TABLE ${IDENT}\\b`, 'i'), 'table'],
    [new RegExp(`^CREATE (?:UNIQUE )?INDEX ${IDENT} ON ${IDENT}\\b`, 'i'), 'index'],
  ];
  for (const [re, kind] of patterns) {
    const m = statement.match(re);
    if (m) return { kind, name: kind === 'index' ? m[2] : m[1] };
  }
  return null;
}

/** The deviation a statement belongs to when it is exactly `ALTER TABLE t ADD COLUMN ...[, ADD COLUMN ...]` over allowed columns; else null. */
function matchDeviationColumns(statement, target, addedColumns) {
  const spec = DEVIATION_COLUMNS[target.name];
  if (!spec || target.kind !== 'table' || !/^ALTER TABLE /i.test(statement)) return null;
  const body = statement
    .replace(new RegExp(`^ALTER TABLE ${IDENT}\\s+`, 'i'), '')
    .replace(/;$/, '');
  // Split the clauses. A column type never contains a comma at depth 0
  // (TIMESTAMPTZ(6) has no comma), so splitting on `, ADD COLUMN` is exact.
  const clauses = body.split(/,\s*(?=ADD COLUMN\b)/i);
  const columns = [];
  for (const clause of clauses) {
    const m = clause.match(new RegExp(`^ADD COLUMN ${IDENT}\\s`, 'i'));
    if (!m) return null;
    if (!spec.columns.includes(m[1])) return null;
    if (!addedColumns.has(`${target.name}.${m[1]}`)) return null;
    columns.push(m[1]);
  }
  return columns.length > 0 ? spec.id : null;
}

/**
 * Classifies every statement.
 *
 * @returns `{ entries, refused }`: `entries` maps deviation id to its statements;
 *   `refused` lists `{ statement, why }` for every statement that is not proven.
 */
export function classify(statements, appObjects) {
  const entries = Object.fromEntries(
    [...Object.values(DEVIATION_COLUMNS).map((d) => d.id), DOMAIN_ID].map((id) => [id, []]),
  );
  const refused = [];
  for (const statement of statements) {
    const target = statementTarget(statement);
    if (!target) {
      refused.push({ statement, why: 'not a statement shape that creates or alters a KVox domain object' });
      continue;
    }
    // 1. A platform table may differ by exactly the four columns.
    if (DEVIATION_COLUMNS[target.name]) {
      const id = matchDeviationColumns(statement, target, appObjects.addedColumns);
      if (id) entries[id].push(statement);
      else {
        refused.push({
          statement,
          why: `touches platform table "${target.name}" and is not an ADD COLUMN of ${DEVIATION_COLUMNS[target.name].columns.join(' / ')} added by an app-only migration`,
        });
      }
      continue;
    }
    // 2. Everything else must belong to a table or type an app-only migration creates.
    const known = target.kind === 'type' ? appObjects.types.has(target.name) : appObjects.tables.has(target.name);
    if (!known) {
      refused.push({
        statement,
        why: `"${target.name}" is not a table or type created by an app-only migration, so this is a platform object: a real difference`,
      });
      continue;
    }
    // A domain statement that ALSO carries a platform-table change cannot hide
    // here: ADD COLUMN/DROP on a domain table is domain, and a foreign key to
    // a platform table is still an alteration of the domain table.
    entries[DOMAIN_ID].push(statement);
  }
  return { entries, refused };
}

/** The `deviations` entries, in the order the issue lists them. Empty entries are omitted. */
export function buildDeviations(entries) {
  const order = ['kvox:storage-managed-by-part-size', 'kvox:allowlist-reminders', DOMAIN_ID];
  return order
    .filter((id) => entries[id].length > 0)
    .map((id) => ({ id, reason: REASONS[id], expectDiff: entries[id] }));
}

function readMigrations(migrationsDir, dirs) {
  return dirs.map((d) => {
    const file = join(migrationsDir, d, 'migration.sql');
    if (!existsSync(file)) throw new Error(`app-only migration ${d} has no migration.sql in ${migrationsDir}`);
    return [d, readFileSync(file, 'utf8')];
  });
}

function parseArgs(argv) {
  const args = { report: null, migrations: null, lock: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--migrations') args.migrations = argv[++i];
    else if (a === '--lock') args.lock = argv[++i];
    else if (a === '--write') args.write = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!args.report) args.report = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!args.report) throw new Error('missing <report.txt>');
  if (args.write && !args.lock) throw new Error('--write needs --lock <platform.lock>');
  return args;
}

export function main(argv, out = process.stdout, err = process.stderr) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err.write(`baseline-deviations: ${e.message}\n`);
    err.write('Usage: node scripts/baseline-deviations.mjs <report.txt> [--migrations <dir>] [--lock <platform.lock> --write]\n');
    return 2;
  }
  const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const migrationsDir = resolve(args.migrations ?? join(apiDir, 'prisma', 'migrations'));
  const report = readFileSync(args.report, 'utf8');
  const statements = parseBlockingStatements(report);
  const appOnly = parseAppOnlyDirectories(report);
  if (appOnly.length === 0) {
    err.write('baseline-deviations: the report lists no "app-only:" directories; save the output of a dry run (db:baseline -- --through 14)\n');
    return 2;
  }
  if (statements.length === 0) {
    err.write('baseline-deviations: the report has no BLOCKING statements; nothing to declare\n');
    return 2;
  }
  const appObjects = collectAppObjects(readMigrations(migrationsDir, appOnly));
  const { entries, refused } = classify(statements, appObjects);

  if (refused.length > 0) {
    err.write(`baseline-deviations: REFUSED ${refused.length} statement(s). They are real differences between the database and the platform history; do not declare them. Report them on the issue.\n`);
    for (const r of refused) err.write(`  - ${r.why}\n      ${r.statement}\n`);
    return 1;
  }

  const deviations = buildDeviations(entries);
  const counts = deviations.map((d) => `${d.id}: ${d.expectDiff.length}`).join(', ');
  err.write(`baseline-deviations: ${statements.length} statement(s) proven (${counts})\n`);

  if (args.write) {
    const { parseLock, serializeLock } = require('@marinoscar/platform-db');
    const lockFile = resolve(args.lock);
    const lock = parseLock(readFileSync(lockFile, 'utf8'), lockFile);
    const ids = new Set(deviations.map((d) => d.id));
    lock.deviations = [...(lock.deviations ?? []).filter((d) => !ids.has(d.id)), ...deviations];
    writeFileSync(lockFile, serializeLock(lock));
    err.write(`baseline-deviations: wrote ${deviations.length} deviation(s) to ${lockFile}\n`);
  } else {
    out.write(`${JSON.stringify(deviations, null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
