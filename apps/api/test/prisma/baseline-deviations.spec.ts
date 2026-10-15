import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * scripts/baseline-deviations.mjs turns the BLOCKING statements of a saved
 * `platform db baseline --through 14` dry run into `platform.lock` deviations
 * (#463). The only thing it may excuse on a PLATFORM table is the four KVox
 * deviation columns; every other statement has to name a table or enum that an
 * app-only migration creates. A statement that touches a platform table any
 * other way is a real difference, and the script must refuse it (exit 1).
 */

const API_DIR = resolve(__dirname, '..', '..');
const SCRIPT = join(API_DIR, 'scripts', 'baseline-deviations.mjs');

const MANAGED = 'ALTER TABLE "storage_objects" ADD COLUMN "managed_by" TEXT, ADD COLUMN "part_size" INTEGER;';
const REMINDERS =
  'ALTER TABLE "allowed_emails" ADD COLUMN "last_reminder_at" TIMESTAMPTZ(6), ADD COLUMN "reminder_count" INTEGER NOT NULL DEFAULT 0;';
const WIDGET_TYPE = `CREATE TYPE "WidgetState" AS ENUM ('a', 'b');`;
const WIDGET_TABLE =
  'CREATE TABLE "widgets" ( "id" UUID NOT NULL, "owner_id" UUID NOT NULL, "state" "WidgetState" NOT NULL, CONSTRAINT "widgets_pkey" PRIMARY KEY ("id") );';
const WIDGET_FK =
  'ALTER TABLE "widgets" ADD CONSTRAINT "widgets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;';
const WIDGET_INDEX = 'CREATE UNIQUE INDEX "widgets_owner_id_key" ON "widgets"("owner_id");';

describe('scripts/baseline-deviations.mjs', () => {
  let dir: string;
  let migrations: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'baseline-dev-'));
    migrations = join(dir, 'migrations');
    const app = [
      ['20260914120000_add_storage_part_size_and_managed_by', `-- storage\n${MANAGED}\n`],
      [
        '20260918120000_add_allowlist_reminder_tracking',
        'ALTER TABLE "allowed_emails" ADD COLUMN "reminder_count" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "last_reminder_at" TIMESTAMPTZ(6);\n',
      ],
      ['20260915000000_add_widgets', `${WIDGET_TYPE}\n${WIDGET_TABLE}\n${WIDGET_FK}\n`],
    ];
    for (const [name, sql] of app) {
      mkdirSync(join(migrations, name), { recursive: true });
      writeFileSync(join(migrations, name, 'migration.sql'), sql);
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(statements: string[]) {
    const report = [
      'B1 map: 14 matched, 23 unmatched, 3 app-only',
      '  app-only: 20260914120000_add_storage_part_size_and_managed_by',
      '  app-only: 20260918120000_add_allowlist_reminder_tracking',
      '  app-only: 20260915000000_add_widgets',
      '',
      `B3 diff: ${statements.length} blocking, 0 declared`,
      ...statements.map((s) => `  BLOCKING: ${s}`),
      '',
    ].join('\n');
    const file = join(dir, 'report.txt');
    writeFileSync(file, report);
    return spawnSync(process.execPath, [SCRIPT, file, '--migrations', migrations], { encoding: 'utf8' });
  }

  it('turns domain objects and the four deviation columns into three deviations', () => {
    const res = run([WIDGET_TYPE, MANAGED, REMINDERS, WIDGET_TABLE, WIDGET_FK, WIDGET_INDEX]);
    expect(res.status).toBe(0);
    const deviations = JSON.parse(res.stdout);
    expect(deviations.map((d: { id: string }) => d.id)).toEqual([
      'kvox:storage-managed-by-part-size',
      'kvox:allowlist-reminders',
      'kvox:domain-schema',
    ]);
    expect(deviations[0].expectDiff).toEqual([MANAGED]);
    expect(deviations[1].expectDiff).toEqual([REMINDERS]);
    expect(deviations[2].expectDiff).toEqual([WIDGET_TYPE, WIDGET_TABLE, WIDGET_FK, WIDGET_INDEX]);
    expect(deviations[2].reason).toContain('not a change to a platform table');
  });

  it('refuses a new column on a platform table', () => {
    const res = run([WIDGET_TABLE, 'ALTER TABLE "users" ADD COLUMN "nickname" TEXT;']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('REFUSED');
    expect(res.stderr).toContain('"users"');
    expect(res.stdout).toBe('');
  });

  it('refuses a platform-table column that is not one of the four', () => {
    const res = run(['ALTER TABLE "storage_objects" ADD COLUMN "managed_by" TEXT, ADD COLUMN "sneaky" TEXT;']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('storage_objects');
  });

  it('refuses a deviation column the app-only migrations do not add', () => {
    const res = run(['ALTER TABLE "allowed_emails" ADD COLUMN "reminder_count" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "bounced" BOOLEAN;']);
    expect(res.status).toBe(1);
  });

  it('refuses anything but ADD COLUMN on a deviation table', () => {
    const res = run(['ALTER TABLE "allowed_emails" DROP COLUMN "reminder_count";']);
    expect(res.status).toBe(1);
  });

  it('refuses an index, constraint or type on a platform object', () => {
    for (const statement of [
      'CREATE INDEX "users_nick_idx" ON "users"("email");',
      'ALTER TABLE "jobs" ADD CONSTRAINT "jobs_x_fkey" FOREIGN KEY ("x") REFERENCES "users"("id");',
      `CREATE TYPE "JobKind" AS ENUM ('a');`,
    ]) {
      const res = run([WIDGET_TABLE, statement]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(statement);
    }
  });

  it('refuses a statement shape it does not recognise', () => {
    const res = run(['DROP TABLE "users";']);
    expect(res.status).toBe(1);
  });

  it('answers 2 when the report has no dry-run data', () => {
    const file = join(dir, 'empty.txt');
    writeFileSync(file, 'nothing here\n');
    const res = spawnSync(process.execPath, [SCRIPT, file, '--migrations', migrations], { encoding: 'utf8' });
    expect(res.status).toBe(2);
  });
});
