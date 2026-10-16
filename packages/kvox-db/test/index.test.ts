import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { KVOX_DB_COMMANDS, kvoxDbUsage, runKvoxDb } from '../src/index.js';

function capture(argv: string[]) {
  let out = '';
  let err = '';
  const code = runKvoxDb(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

describe('@marinoscar/kvox-db scaffold', () => {
  it('prints the usage and exits 0 without arguments', () => {
    const result = capture([]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(kvoxDbUsage());
    expect(result.out).toContain('Usage: kvox-db');
  });

  it('rejects an unknown command with exit code 2', () => {
    const result = capture(['sync']);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown command 'sync'");
    expect(KVOX_DB_COMMANDS).toEqual([]);
  });

  it('exposes the usage through the bin entry once built', () => {
    // dist/ exists after `npm run build`; skip the process check before that.
    const built = spawnSync(process.execPath, ['bin/kvox-db.js', '--help'], { encoding: 'utf8' });
    if (built.status !== 0 && /Cannot find module/.test(built.stderr)) return;
    expect(built.status).toBe(0);
    expect(built.stdout).toContain('Usage: kvox-db');
  });
});
