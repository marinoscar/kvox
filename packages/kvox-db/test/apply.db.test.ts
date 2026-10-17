import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyKvoxSync, checkKvoxInstall, planKvoxSync, readManifest } from '../src/index.js';
import { PACKAGE_DIR } from './helpers.js';

const adminUrl = process.env.DATABASE_URL;
const require = createRequire(__filename);

/**
 * Applies the platform's migrations and then the domain's, installed with
 * `stable` names, to an empty database and checks it with `check --database`.
 * Runs only when DATABASE_URL points at a PostgreSQL 16 server with the
 * pgvector and pg_trgm extensions available and a role allowed to create a
 * database and the extensions (the test creates and drops its own database).
 */
describe.skipIf(!adminUrl)('kvox-db against a fresh database', () => {
  const name = `kvox_db_apply_${process.pid}`;
  let url = '';
  let root = '';
  type PgClient = { connect(): Promise<void>; query(sql: string): Promise<{ rows: Record<string, string>[] }>; end(): Promise<void> };
  const { Client } = require('pg') as { Client: new (config: { connectionString: string }) => PgClient };
  const withDatabase = (database: string) => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl! });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    url = withDatabase(name);

    // The host: an empty app folder that receives the platform's own migrations from the platform command, stamped from a pinned clock so they sort before the domain.
    root = mkdtempSync(join(tmpdir(), 'kvox-db-apply-'));
    const platformBin = join(require.resolve('@marinoscar/platform-db/package.json'), '..', 'bin', 'platform.js');
    const installed = spawnSync(process.execPath, [platformBin, 'db', 'sync', '--root', root, '--timestamp', '2024-01-01T00:00:00Z'], { encoding: 'utf8' });
    expect(installed.status, installed.stderr).toBe(0);
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    const admin = new Client({ connectionString: adminUrl! });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it('applies the platform history, then the domain history installed with stable names, then passes check --database', async () => {
    const dirs = () => readdirSync(join(root, 'prisma', 'migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
    const platformDirs = dirs();

    // The temp host sits outside the repository, so name the platform schema folder instead of resolving it from the host.
    const platformSchemaDir = join(require.resolve('@marinoscar/platform-db/package.json'), '..', 'schema');
    const plan = planKvoxSync({ root, names: 'stable', platformSchemaDir });
    applyKvoxSync(plan);
    const all = dirs();
    const kvoxDirs = all.filter((d) => !platformDirs.includes(d));
    expect(kvoxDirs).toHaveLength(readManifest(join(PACKAGE_DIR, 'migrations')).migrations.length);
    expect(all.slice(-kvoxDirs.length)).toEqual(kvoxDirs); // the domain sorts after the platform's

    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      // The extensions are created by the bootstrap superuser, never by the command or the migrations' role.
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      for (const dir of all) {
        const sql = readFileSync(join(root, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8');
        await client.query(sql);
      }
    } finally {
      await client.end();
    }

    const result = await checkKvoxInstall({ root, database: true, databaseUrl: url });
    expect(result.problems).toEqual([]);
  }, 120_000);

  it('fails check --database after a raw index is dropped', async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('DROP INDEX kg_items_live_statement_uniq_idx');
    } finally {
      await client.end();
    }
    const result = await checkKvoxInstall({ root, database: true, databaseUrl: url });
    expect(result.problems.map((p) => p.code)).toEqual(['INDEX_MISSING']);
    expect(result.problems[0]?.message).toContain('kg_items_live_statement_uniq_idx');
  });
});
