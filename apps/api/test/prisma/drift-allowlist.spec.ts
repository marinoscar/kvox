import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * prisma/drift-allowlist.json is the ONLY place `npm run db:drift:kvox` excuses
 * a statement that `platform db drift` prints (#463). Every entry is a debt or
 * a documented limit of Prisma's schema language, so it has to say why and when
 * it goes away. This spec pins that, and runs the filter script on saved
 * drift output (`--from-file`, no database) to prove it excuses only what the
 * allowlist names.
 */

const API_DIR = resolve(__dirname, '..', '..');
const ALLOWLIST = join(API_DIR, 'prisma', 'drift-allowlist.json');
const SCRIPT = join(API_DIR, 'scripts', 'db-drift-kvox.mjs');

interface Entry {
  statement: string;
  reason: string;
  removeIn: string;
}

function loadEntries(): Entry[] {
  const parsed = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.entries;
}

describe('prisma/drift-allowlist.json', () => {
  const entries = loadEntries();

  it('is not empty', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries.map((e) => [e.statement, e] as const))('%s has a statement, a reason and a removeIn', (_s, e) => {
    expect(typeof e.statement).toBe('string');
    expect(e.statement.trim()).not.toBe('');
    expect(typeof e.reason).toBe('string');
    expect(e.reason.trim()).not.toBe('');
    // An issue number, or `permanent` for what Prisma's schema language can
    // never declare (GIN / GiST / HNSW indexes, generated tsvector columns).
    expect(typeof e.removeIn).toBe('string');
    expect(e.removeIn).toMatch(/^(#\d+|permanent)$/);
  });

  it('lists each statement once', () => {
    const normalised = entries.map((e) => e.statement.replace(/\s+/g, ' ').trim());
    expect(new Set(normalised).size).toBe(normalised.length);
  });

  it('names the issue that removes each temporary deviation, and no #465 entry survives', () => {
    const byStatement = (needle: string) => entries.find((e) => e.statement.includes(needle));
    // #465 moved the allowlist reminder bookkeeping to kvox_allowlist_reminders
    // and dropped the two allowed_emails columns, so the entry is gone for good.
    expect(byStatement('"allowed_emails"')).toBeUndefined();
    expect(entries.filter((e) => e.removeIn === '#465')).toEqual([]);
    // The one remaining temporary deviation, with the issue that moves it.
    expect(byStatement('"storage_objects" DROP COLUMN')?.removeIn).toBe('#469');
    for (const col of ['managed_by', 'part_size']) {
      expect(byStatement('"storage_objects" DROP COLUMN')?.statement).toContain(col);
    }
  });

  it('never excuses a DROP of anything but an index, a deviation column or a generation expression', () => {
    for (const e of entries) {
      expect(e.statement).toMatch(
        /^(DROP INDEX "[a-z_0-9]+";|ALTER TABLE "storage_objects" DROP COLUMN [^;]+;|ALTER TABLE "[a-z_]+" ALTER COLUMN "[a-z_]*search_vector" DROP DEFAULT;)$/,
      );
    }
  });
});

describe('scripts/db-drift-kvox.mjs (filter, no database)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-kvox-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(report: string) {
    const file = join(dir, 'drift.txt');
    writeFileSync(file, report);
    return spawnSync(process.execPath, [SCRIPT, '--from-file', file], { encoding: 'utf8' });
  }

  function driftReport(statements: string[], extra: string[] = []) {
    const body = statements.map((s) => `-- Step\n${s}\n`).join('\n');
    return `SCHEMA_DRIFT  the schema has changes no migration creates; add a migration. The missing SQL is:\n${body}\n${extra.join('\n')}\n`;
  }

  const allowed = loadEntries().map((e) => e.statement);

  it('passes when every printed statement is allowlisted', () => {
    const res = run(driftReport(allowed));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ok');
  });

  it('passes the multi-line form Prisma prints for a two-column drop', () => {
    const res = run(
      driftReport(['ALTER TABLE "storage_objects" DROP COLUMN "managed_by",\nDROP COLUMN "part_size";']),
    );
    expect(res.status).toBe(0);
  });

  it('fails on the allowed_emails reminder columns now that #465 dropped them', () => {
    const res = run(
      driftReport(['ALTER TABLE "allowed_emails" DROP COLUMN "last_reminder_at",\nDROP COLUMN "reminder_count";']),
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('"allowed_emails"');
  });

  it('fails on a statement the allowlist does not name', () => {
    const res = run(driftReport([...allowed, 'ALTER TABLE "users" ADD COLUMN "nickname" TEXT;']));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('"users"');
  });

  it('fails on a platform-column drop that is not one of the allowlisted two', () => {
    const res = run(driftReport(['ALTER TABLE "storage_objects" DROP COLUMN "bucket";']));
    expect(res.status).toBe(1);
  });

  it('never filters the other problem codes', () => {
    const res = run(
      driftReport(allowed, ['INDEX_MISSING  kg_items_live_statement_uniq_idx: not found in pg_indexes']),
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('INDEX_MISSING');
  });
});
