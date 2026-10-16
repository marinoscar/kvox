import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// =============================================================================
// Every raw-SQL INSERT names `id` for a table whose uuid DEFAULT was dropped
// (issue #337)
// =============================================================================
//
// `20260831014110_drop_stale_uuid_defaults` removed the server-side
// `uuid_generate_v4()` default from twelve tables' `id` columns: Prisma
// generates those ids CLIENT-SIDE now, so nothing is lost — for statements
// Prisma writes. A hand-written `INSERT` that leaves the column out is a
// NOT NULL violation at runtime, and TypeScript cannot see it, because the
// SQL is a string.
//
// That is exactly how #337 survived: `CARRY_AUDIT_SQL` in the restore service
// (this app's own `db-backup/database-restore.service.ts` then; the platform's
// `@marinoscar/platform-api/db-backup` since #471) omitted `id` while `CARRY_RUN_SQL`,
// twenty lines above it, supplied it. `reinsertCatalog` never throws by
// design, so the failure was a `CRITICAL` log line on a restore that still
// reported success, and the record of the restore was missing from the only
// database anybody would open afterwards.
//
// THE TABLE LIST IS READ FROM THE MIGRATION, not copied out of it. A future
// migration that drops another id default is covered without touching this
// file — and the guard checks the migration still says what this test assumes,
// so a squashed or renamed migration fails loudly rather than passing
// vacuously.
//
// WHAT THIS DELIBERATELY DOES NOT DO: parse SQL. It is a scan for a specific
// shape — `INSERT INTO <affected table> (<columns>)` in the API's own source —
// and it asserts one thing about each hit: that `id` is among the columns it
// names. Comments are stripped first, because prose about a statement
// (`auth.service.ts` describes the first login as "runs `INSERT INTO users`")
// is not a statement. An INSERT whose table name is interpolated at runtime
// would slip past it; there are none, raw INSERTs in this codebase are rare by
// convention, and a scan that tried to be a parser would be the brittle thing
// worth skipping.
// =============================================================================

const API_ROOT = join(__dirname, '..', '..');
const MIGRATION_SQL = join(
  API_ROOT,
  'prisma',
  'migrations',
  '20260831014110_drop_stale_uuid_defaults',
  'migration.sql'
);

/** Tables the migration stripped the `id` default from. */
function tablesWithoutIdDefault(): string[] {
  const sql = readFileSync(MIGRATION_SQL, 'utf8');
  const pattern = /ALTER TABLE "([a-z_][a-z0-9_]*)" ALTER COLUMN "id" DROP DEFAULT/gi;

  return [...sql.matchAll(pattern)].map((match) => match[1]).sort();
}

/** Every `.ts` file under a directory, excluding the tests themselves. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(path);
    }
  }

  return files;
}

/**
 * Comments removed, so prose ABOUT an INSERT is not mistaken for one.
 *
 * The `[^:]` guard keeps `https://` intact — a naive `//` strip would cut a URL
 * in a string literal in half, and the tail of a URL is not SQL either way.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

interface RawInsert {
  file: string;
  table: string;
  /** The column list as written, or `null` when the statement names none. */
  columns: string[] | null;
}

/** The raw INSERTs into `tables` in one file's text (comments are stripped first). */
function insertsIn(file: string, source: string, tables: string[]): RawInsert[] {
  const found: RawInsert[] = [];
  const text = stripComments(source);
  const pattern = /insert\s+into\s+"?([a-z_][a-z0-9_]*)"?\s*/gi;

  for (const match of text.matchAll(pattern)) {
    if (!tables.includes(match[1])) continue;

    const rest = text.slice((match.index ?? 0) + match[0].length);
    const close = rest.indexOf(')');
    const columns =
      rest.startsWith('(') && close > 0
        ? rest
            .slice(1, close)
            .split(',')
            .map((column) => column.trim().replace(/"/g, ''))
        : null;

    found.push({ file, table: match[1], columns });
  }

  return found;
}

function rawInserts(tables: string[]): RawInsert[] {
  const found: RawInsert[] = [];

  for (const file of [...sourceFiles(join(API_ROOT, 'src')), join(API_ROOT, 'prisma', 'seed.ts')]) {
    found.push(
      ...insertsIn(file.slice(API_ROOT.length + 1), readFileSync(file, 'utf8'), tables)
    );
  }

  return found;
}

describe('raw-SQL INSERTs supply the id Prisma would have generated (#337)', () => {
  const tables = tablesWithoutIdDefault();

  it('reads the affected tables out of the migration itself', () => {
    // If this fails, the migration was renamed or squashed and the scan below
    // is checking nothing.
    expect(tables).toContain('audit_events');
    expect(tables.length).toBeGreaterThanOrEqual(12);
  });

  it('recognises the shape it is meant to be guarding', () => {
    // The restore carry-over's two statements used to be the only ones in the API;
    // they moved into the platform package with #471, so the app's own source holds
    // none today. The scan is proven on sample text instead: a failure here means it
    // no longer sees an INSERT, and the check below would pass while checking nothing.
    const sample = [
      '// INSERT INTO audit_events (never_scanned) -- a comment',
      'const sql = `INSERT INTO audit_events (id, action) VALUES ($1, $2)`;',
      'const bad = `INSERT INTO "database_backup_runs" (status) VALUES ($1)`;',
      'const other = `INSERT INTO unrelated_table (id) VALUES ($1)`;',
    ].join('\n');

    expect(insertsIn('sample.ts', sample, [...tables, 'database_backup_runs'])).toEqual([
      { file: 'sample.ts', table: 'audit_events', columns: ['id', 'action'] },
      { file: 'sample.ts', table: 'database_backup_runs', columns: ['status'] },
    ]);
  });

  it('names an id column in every one of them', () => {
    // A statement with no column list at all (`INSERT INTO t VALUES (...)`)
    // counts as an offender: it cannot be checked, and it is not a shape this
    // codebase needs.
    const offenders = rawInserts(tables)
      .filter((hit) => !(hit.columns ?? []).includes('id'))
      .map(
        (hit) =>
          `${hit.file}: INSERT INTO ${hit.table} ` +
          `(${hit.columns === null ? 'no column list' : hit.columns.join(', ')})`
      );

    expect(offenders).toEqual([]);
  });
});
