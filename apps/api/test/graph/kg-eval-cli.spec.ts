/**
 * `npm run kg:eval` end to end (issue #362): the CLI is spawned exactly as
 * the npm script runs it, plus an in-process check of the `--run` path with a
 * stub runner (`extract`, #363, is the one real runner).
 */

import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { main } from '../../scripts/kg-eval';
import { goldPrediction } from '../../scripts/kg-eval/gold-runner';
import { GOLDEN_MEETINGS_DIR, listFixtureFiles } from '../../scripts/kg-eval/load';
import { emptyPrediction } from '../../scripts/kg-eval/prediction-schema';
import { assertOutsideRepo, RealDataPathError, REAL_DATA_REFUSAL, syntheticRunsDir } from '../../scripts/kg-eval/real-data';
import { kgEvalReportSchema } from '../../scripts/kg-eval/report';
import { KG_EVAL_RUNNERS } from '../../scripts/kg-eval/runner';

const API_DIR = resolve(__dirname, '../..');
const REPO_ROOT = resolve(API_DIR, '../..');
const TS_NODE = require.resolve('ts-node/dist/bin.js');

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const { KG_EVAL_REAL_DIR: _unset, ...base } = process.env;
  const res = spawnSync(
    process.execPath,
    [TS_NODE, '-P', 'scripts/tsconfig.json', '--transpile-only', 'scripts/kg-eval.ts', ...args],
    { cwd: API_DIR, encoding: 'utf8', env: { ...base, ...env }, timeout: 60_000 },
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('kg:eval CLI (issue #362)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kg-eval-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('--predictions gold --only m01,m02 --json <file> exits 0 with a schema-valid report of 1.000s', () => {
    const json = join(tmp, 'report.json');
    const res = cli(['--predictions', 'gold', '--only', 'm01,m02', '--json', json]);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^kg:eval {2}fixtures=2 {2}runner=gold {2}model=-/);
    expect(res.stdout).toMatch(/COMMITMENT RECALL\s+1\.000\s+target ≥ 0\.85\s+PASS/);

    const report = kgEvalReportSchema.parse(JSON.parse(readFileSync(json, 'utf8')));
    expect(report.fixtureIds).toEqual(['m01', 'm02']);
    for (const t of report.types.filter((r) => r.tp + r.fn > 0)) {
      expect({ type: t.type, p: t.precision, r: t.recall }).toEqual({ type: t.type, p: 1, r: 1 });
    }
    expect(report.metrics.autoLinkPrecision.value).toBe(1);
  });

  it('--tag narrows to the tagged fixtures', () => {
    const res = cli(['--predictions', 'gold', '--tag', 'note-only']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/fixtures=2 /);
  });

  it('--run with an unregistered runner exits 2, naming the registered ones', () => {
    const res = cli(['--run', 'nope', '--model', 'any-model']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("no runner 'nope' registered (known: extract)");
  });

  it('--run extract (#363) is registered, and exits 2 without its API key', () => {
    const res = cli(['--run', 'extract', '--model', 'any-model'], { KG_EVAL_OPENAI_API_KEY: '' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--run reads its API key from KG_EVAL_OPENAI_API_KEY; it is not set');
  });

  it('--real-dir inside the repository is refused with exit 3', () => {
    const res = cli(['--predictions', 'gold', '--real-dir', resolve(API_DIR, 'test/fixtures')]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain(REAL_DATA_REFUSAL);
  });

  it('--real-dir through a symlink that points into the repository is refused too', () => {
    const link = join(tmp, 'looks-outside');
    symlinkSync(REPO_ROOT, link);
    const res = cli(['--predictions', 'gold', '--real-dir', join(link, 'scratch')]);
    expect(res.status).toBe(3);
  });

  it('KG_EVAL_REAL_DIR inside the repository is refused as well', () => {
    const res = cli(['--predictions', 'gold'], { KG_EVAL_REAL_DIR: resolve(REPO_ROOT, 'real') });
    expect(res.status).toBe(3);
  });

  it('--export-note into the repository is refused before any database access', () => {
    const res = cli([
      '--export-note',
      '00000000-0000-4000-8000-000000000000',
      '--user',
      'someone@example.com',
      '--real-dir',
      resolve(REPO_ROOT, 'real-notes'),
    ]);
    expect(res.status).toBe(3);
  });

  it('--export-note without --user is a usage error', () => {
    const res = cli(['--export-note', 'x', '--real-dir', tmp]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--export-note requires --user');
  });

  it('scores a real set from a directory outside the repository', () => {
    const first = listFixtureFiles(GOLDEN_MEETINGS_DIR)[0];
    copyFileSync(first, join(tmp, 'm01-copy.json'));
    const res = cli(['--predictions', 'gold', '--real-dir', tmp]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/fixtures=1 /);
  });

  it('--enforce exits 1 when a predictions directory scores below target', () => {
    writeFileSync(join(tmp, 'm01.json'), JSON.stringify(emptyPrediction('m01', 'weak-model')));
    const res = cli(['--predictions', tmp, '--only', 'm01', '--enforce']);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/model=weak-model/);
    expect(res.stdout).toMatch(/ENTITY COVERAGE\s+0\.000\s+target ≥ 0\.90\s+FAIL/);

    // Without --enforce the same run is report-only.
    expect(cli(['--predictions', tmp, '--only', 'm01']).status).toBe(0);
  });

  it('scores a missing prediction file as empty and says so', () => {
    const res = cli(['--predictions', tmp, '--only', 'm02']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('no prediction for m02');
  });
});

describe('kg:eval --run with a registered runner (in process)', () => {
  let tmp: string;
  const out: string[] = [];
  const err: string[] = [];
  const io = (env: NodeJS.ProcessEnv) => ({ out: (s: string) => out.push(s), err: (s: string) => err.push(s), env });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kg-eval-run-'));
    out.length = 0;
    err.length = 0;
    KG_EVAL_RUNNERS.stub = async () => ({
      name: 'stub',
      run: async (fixture) => ({ ...goldPrediction(fixture), model: 'stub-model' }),
    });
  });
  afterEach(() => {
    delete KG_EVAL_RUNNERS.stub;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes one prediction per fixture, never the API key, then scores them', async () => {
    const code = await main(['--run', 'stub', '--model', 'stub-model', '--only', 'm01,m03', '--out', tmp], io({
      KG_EVAL_OPENAI_API_KEY: 'sk-test-never-written',
    }));
    expect(code).toBe(0);
    expect(readdirSync(tmp).sort()).toEqual(['m01.json', 'm03.json']);
    for (const f of readdirSync(tmp)) expect(readFileSync(join(tmp, f), 'utf8')).not.toContain('sk-test-never-written');
    expect(out.join('\n')).toMatch(/runner=stub {2}model=stub-model/);
    expect(out.join('\n')).not.toContain('sk-test-never-written');
    expect(err.join('\n')).not.toContain('sk-test-never-written');
  });

  it('requires the API key from the environment', async () => {
    const code = await main(['--run', 'stub', '--model', 'm', '--only', 'm01', '--out', tmp], io({}));
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('KG_EVAL_OPENAI_API_KEY');
  });

  it('refuses --out inside the repository except under apps/api/.kg-eval/ for synthetic runs', async () => {
    const env = { KG_EVAL_OPENAI_API_KEY: 'k' };
    const inRepo = await main(['--run', 'stub', '--model', 'm', '--only', 'm01', '--out', resolve(API_DIR, 'tmp-out')], io(env));
    expect(inRepo).toBe(3);
    expect(existsSync(resolve(API_DIR, 'tmp-out'))).toBe(false);

    const real = await main(
      ['--run', 'stub', '--model', 'm', '--real-dir', tmp, '--out', join(syntheticRunsDir(), 'real-run')],
      io(env),
    );
    expect(real).toBe(3);
    expect(existsSync(join(syntheticRunsDir(), 'real-run'))).toBe(false);
  });
});

describe('assertOutsideRepo', () => {
  it('lets the git-ignored synthetic runs directory through only when asked', () => {
    const p = join(syntheticRunsDir(), 'runs', 'x');
    expect(() => assertOutsideRepo(p)).toThrow(RealDataPathError);
    expect(assertOutsideRepo(p, { allowSyntheticRunsDir: true })).toBe(p);
  });

  it('refuses the repository root itself and accepts a path outside it', () => {
    expect(() => assertOutsideRepo(REPO_ROOT)).toThrow(REAL_DATA_REFUSAL);
    expect(() => assertOutsideRepo(join(tmpdir(), 'somewhere-else'))).not.toThrow();
  });
});
