// =============================================================================
// scripts/voiceprint-model.js (#831): the one-JSON-line contract the deploy step and
// the doctor parse. Only the paths that need no build and no network are exercised
// here (usage); install and status go through the same kvox-ai functions the adapter
// spec covers.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'voiceprint-model.js');

describe('scripts/voiceprint-model.js', () => {
  it('refuses an unknown command with exit code 2 and one JSON error line', () => {
    const run = spawnSync(process.execPath, [SCRIPT, 'frobnicate'], { encoding: 'utf8' });

    expect(run.status).toBe(2);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ status: 'error', code: 'usage', message: expect.any(String) });
  });

  it('is exposed as an npm script', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts['voiceprints:model']).toBe('node scripts/voiceprint-model.js');
  });
});
