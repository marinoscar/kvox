import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { KVOX_DB_COMMANDS, kvoxDbUsage, runKvoxDb } from '../src/index.js';
import { PACKAGE_DIR, cleanup, freshHost } from './helpers.js';

afterEach(cleanup);

async function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  let out = '';
  let err = '';
  const code = await runKvoxDb(argv, { out: (t) => (out += t), err: (t) => (err += t) }, { env, cwd });
  return { code, out, err };
}

describe('kvox-db command', () => {
  it('prints the usage and exits 0 without arguments or with --help', async () => {
    const none = await run([], '.');
    expect(none.code).toBe(0);
    expect(none.out).toBe(kvoxDbUsage());
    expect(none.out).toContain('Usage: kvox-db');
    for (const command of KVOX_DB_COMMANDS) expect(none.out).toContain(command);
    const help = await run(['--help'], '.');
    expect(help.code).toBe(0);
    expect(help.out).toContain('sync');
  });

  it('rejects an unknown command and an unknown policy with exit code 2', async () => {
    expect((await run(['frobnicate'], '.')).code).toBe(2);
    const bad = await run(['sync', '--names', 'bogus'], '.');
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('original, stable, after-host');
  });

  it('syncs, checks and fails a check with exit codes 0 and 1', async () => {
    const root = freshHost();
    const sync = await run(['sync', '--root', root], '.');
    expect(sync.code, sync.err).toBe(0);
    expect(sync.out).toContain('kvox.lock');
    const ok = await run(['check', '--root', root], '.');
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain('kvox-db check: ok');

    const fragment = join(root, 'prisma', 'fragments', 'kvox.ask.prisma');
    writeFileSync(fragment, `${readFileSync(fragment, 'utf8')}// edited\n`);
    const bad = await run(['check', '--root', root], '.');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('FRAGMENT_MODIFIED');
  });

  it('exits 2 for check --database without DATABASE_URL', async () => {
    const root = freshHost();
    await run(['sync', '--root', root], '.');
    const result = await run(['check', '--root', root, '--database'], '.', {});
    expect(result.code).toBe(2);
    expect(result.err).toContain('DATABASE_URL');
  });

  it('runs through the built bin file', () => {
    const built = spawnSync(process.execPath, ['bin/kvox-db.js', '--help'], { cwd: PACKAGE_DIR, encoding: 'utf8' });
    // dist/ exists after `npm run build`; skip the process check before that.
    if (built.status !== 0 && /Cannot find module/.test(built.stderr)) return;
    expect(built.status).toBe(0);
    expect(built.stdout).toContain('Usage: kvox-db');
    expect(readdirSync(PACKAGE_DIR)).toContain('bin');
  });
});
