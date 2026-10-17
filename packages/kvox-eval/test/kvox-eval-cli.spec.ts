/**
 * `kvox-eval` (issue #580): the command in process (injectable io and env), the
 * key's environment variable and its deprecated aliases, the copilot refusal,
 * the real-data guard, `runKgEval`'s gold self-test, and a live run over the
 * real `createKvoxAi` + `createDirectRuntime` with a scripted provider adapter —
 * no network, no real key.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { AiError, type AiProviderAdapter, type AiResponse } from '@marinoscar/platform-api/ai';

import { main } from '../src/cli/main';
import { KG_EVAL_EXIT, runKgCommand, type EvalCommandIo } from '../src/cli/kg-command';
import { GOLDEN_MEETINGS_DIR, listFixtureFiles } from '../src/fixtures/load';
import { goldPrediction } from '../src/kg/gold-runner';
import { kgEvalReportSchema } from '../src/kg/report';
import { KgEvalTargetsError, KgEvalUsageError, runKgEval } from '../src/kg/run-kg-eval';
import { KG_EVAL_RUNNERS } from '../src/kg/runner';
import { DEPRECATED_EVAL_API_KEY_ENVS, KVOX_EVAL_API_KEY_ENV, readEvalApiKey } from '../src/live/env';
import { createLiveKvoxAi, LiveProviderError } from '../src/live/live-ai';
import { assertOutsideRepo, REAL_DATA_REFUSAL, RealDataPathError } from '../src/real-data/real-data';

const REPO_ROOT = resolve(__dirname, '../../..');
const SECRET = 'sk-test-kvox-eval-never-printed';

function capture(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: EvalCommandIo = { out: (s) => out.push(s), err: (s) => err.push(s), env };
  return { io, out, err, all: () => [...out, ...err].join('\n') };
}

/** A provider adapter that answers every structured call with `answer` (or fails), recording the keys it saw. */
function scriptedAdapter(answer: unknown | (() => never)): { adapter: AiProviderAdapter; keys: string[] } {
  const keys: string[] = [];
  const adapter = {
    id: 'openai',
    displayName: 'scripted',
    responses: {
      create: async (_req: unknown, ctx: { apiKey: string }): Promise<AiResponse> => {
        keys.push(ctx.apiKey);
        if (typeof answer === 'function') (answer as () => never)();
        return { parsed: answer, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } as unknown as AiResponse;
      },
      stream: async function* () {
        throw new Error('not scripted');
      },
    },
  } as unknown as AiProviderAdapter;
  return { adapter, keys };
}

describe('readEvalApiKey (#580)', () => {
  it('reads KVOX_EVAL_OPENAI_API_KEY first, with no note', () => {
    const notes: string[] = [];
    expect(readEvalApiKey({ [KVOX_EVAL_API_KEY_ENV]: SECRET, KG_EVAL_OPENAI_API_KEY: 'old' }, (l) => notes.push(l))).toEqual({
      apiKey: SECRET,
      source: KVOX_EVAL_API_KEY_ENV,
    });
    expect(notes).toEqual([]);
  });

  it.each(DEPRECATED_EVAL_API_KEY_ENVS)('still reads %s for one release, with a note that names the variable, never the key', (name) => {
    const notes: string[] = [];
    expect(readEvalApiKey({ [name]: SECRET }, (l) => notes.push(l))).toEqual({ apiKey: SECRET, source: name });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`${name} is deprecated`);
    expect(notes[0]).toContain(KVOX_EVAL_API_KEY_ENV);
    expect(notes[0]).not.toContain(SECRET);
  });

  it('treats an empty variable as unset', () => {
    expect(readEvalApiKey({ [KVOX_EVAL_API_KEY_ENV]: '', KG_EVAL_OPENAI_API_KEY: '' })).toBeNull();
  });
});

describe('runKgEval (#580)', () => {
  it('gold: the self-test scores 1.000 on every labelled row of every fixture', async () => {
    const report = kgEvalReportSchema.parse(await runKgEval({ runner: 'gold' }));
    expect(report.fixtures).toBe(listFixtureFiles(GOLDEN_MEETINGS_DIR).length);
    expect(report.runner).toBe('gold');
    expect(report.targetsMet).toBe(true);
    for (const t of report.types.filter((r) => r.tp + r.fn > 0)) expect({ type: t.type, p: t.precision, r: t.recall }).toEqual({ type: t.type, p: 1, r: 1 });
  });

  it('is gold by default and narrows with fixtures and tag', async () => {
    const report = await runKgEval({ fixtures: ['m01', 'm02'] });
    expect(report.fixtureIds).toEqual(['m01', 'm02']);
  });

  it('a live runner needs a model and a port, and an unknown runner is a usage error', async () => {
    await expect(runKgEval({ runner: 'extract' })).rejects.toThrow(KgEvalUsageError);
    await expect(runKgEval({ runner: 'nope' })).rejects.toThrow("no runner 'nope' registered");
    await expect(runKgEval({ runner: 'gold', predictionsDir: tmpdir() })).rejects.toThrow(KgEvalUsageError);
  });

  it('enforce throws KgEvalTargetsError carrying the report when a target fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvox-eval-empty-'));
    try {
      const missing: string[] = [];
      const err = await runKgEval({ predictionsDir: dir, fixtures: ['m01'], enforce: true, onMissingPrediction: (id) => missing.push(id) }).catch((e) => e);
      expect(err).toBeInstanceOf(KgEvalTargetsError);
      expect((err as KgEvalTargetsError).report.targetsMet).toBe(false);
      expect(missing).toEqual(['m01']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('kvox-eval kg (in process)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kvox-eval-cli-'));
  });
  afterEach(() => {
    delete KG_EVAL_RUNNERS.stub;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('--predictions gold prints the same table as the harness self-test', async () => {
    const c = capture();
    expect(await main(['kg', '--predictions', 'gold', '--only', 'm01'], c.io)).toBe(KG_EVAL_EXIT.ok);
    expect(c.out.join('\n')).toMatch(/^kg:eval {2}fixtures=1 {2}runner=gold {2}model=-/);
    expect(c.err).toEqual([]);
  });

  it('--provider copilot is refused with exit 2, before any key is looked for', async () => {
    const c = capture({});
    expect(await main(['kg', '--runner', 'extract', '--provider', 'copilot', '--model', 'm'], c.io)).toBe(KG_EVAL_EXIT.usage);
    expect(c.err.join('\n')).toContain("the 'copilot' provider is not available yet");
    expect(c.err.join('\n')).toContain('#581');
  });

  it('a live runner without a key exits 2 naming KVOX_EVAL_OPENAI_API_KEY', async () => {
    const c = capture({});
    expect(await main(['kg', '--runner', 'extract', '--model', 'm', '--out', tmp], c.io)).toBe(KG_EVAL_EXIT.usage);
    expect(c.err.join('\n')).toContain(`--runner reads its API key from ${KVOX_EVAL_API_KEY_ENV}; it is not set`);
  });

  it('extract-resolve is accepted for extract+resolve, and an unknown runner names the registered ones', async () => {
    const c = capture({});
    expect(await main(['kg', '--runner', 'nope', '--model', 'm'], c.io)).toBe(KG_EVAL_EXIT.usage);
    expect(c.err.join('\n')).toContain("no runner 'nope' registered (known: extract, extract+resolve)");
    const d = capture({});
    await main(['kg', '--runner', 'extract-resolve', '--model', 'm', '--out', tmp], d.io);
    expect(d.err.join('\n')).not.toContain('registered');
  });

  it('--real-dir inside the repository is refused with exit 3, and so is --out of a real-data run', async () => {
    const c = capture();
    expect(await main(['kg', '--predictions', 'gold', '--real-dir', resolve(REPO_ROOT, 'packages')], c.io)).toBe(KG_EVAL_EXIT.pathRefused);
    expect(c.err.join('\n')).toContain(REAL_DATA_REFUSAL);
    const env = capture({ KG_EVAL_REAL_DIR: resolve(REPO_ROOT, 'real') });
    expect(await main(['kg', '--predictions', 'gold'], env.io)).toBe(KG_EVAL_EXIT.pathRefused);
    const out = capture({ [KVOX_EVAL_API_KEY_ENV]: SECRET });
    expect(await main(['kg', '--runner', 'extract', '--model', 'm', '--real-dir', tmp, '--out', resolve(REPO_ROOT, 'tmp-out')], out.io)).toBe(
      KG_EVAL_EXIT.pathRefused,
    );
    expect(existsSync(resolve(REPO_ROOT, 'tmp-out'))).toBe(false);
  });

  it('a live run writes one prediction per fixture and never prints or writes the key (a deprecated alias included)', async () => {
    KG_EVAL_RUNNERS.stub = async () => ({ name: 'stub', run: async (fixture) => ({ ...goldPrediction(fixture), model: 'stub-model' }) });
    const { adapter } = scriptedAdapter({});
    const c = capture({ KG_EVAL_OPENAI_API_KEY: SECRET });
    const code = await runKgCommand(['--runner', 'stub', '--model', 'stub-model', '--only', 'm01,m03', '--out', tmp], c.io, {
      adapters: { openai: adapter },
    });
    expect(code).toBe(KG_EVAL_EXIT.ok);
    expect(readdirSync(tmp).sort()).toEqual(['m01.json', 'm03.json']);
    for (const f of readdirSync(tmp)) expect(readFileSync(join(tmp, f), 'utf8')).not.toContain(SECRET);
    expect(c.err.join('\n')).toContain('KG_EVAL_OPENAI_API_KEY is deprecated');
    expect(c.all()).not.toContain(SECRET);
  });

  it('a failed live call exits 2 with its class, code and HTTP status only — never the key or a body', async () => {
    const { adapter, keys } = scriptedAdapter(() => {
      throw new AiError('AI_KEY_INVALID', `The provider rejected the key ${SECRET}.`);
    });
    const c = capture({ [KVOX_EVAL_API_KEY_ENV]: SECRET });
    const code = await runKgCommand(['--runner', 'extract', '--model', 'gpt-test', '--only', 'm01', '--out', tmp], c.io, {
      adapters: { openai: adapter },
    });
    expect(code).toBe(KG_EVAL_EXIT.usage);
    expect(keys).toEqual([SECRET]); // the key reached the adapter's call context, and only there
    expect(c.err.join('\n')).toContain('the live call failed (key_missing; AI_KEY_INVALID, HTTP 400)');
    expect(c.all()).not.toContain(SECRET);
  });

  it('kvox-eval ask is not headless yet: exit 2, pointing at npm run ask:eval', async () => {
    const c = capture();
    expect(await main(['ask'], c.io)).toBe(KG_EVAL_EXIT.usage);
    expect(c.err.join('\n')).toContain('npm run ask:eval --workspace=api');
  });
});

describe('createLiveKvoxAi (#580)', () => {
  it('runs extract over createKvoxAi and the direct runtime, with the key only in the adapter call', async () => {
    const { adapter, keys } = scriptedAdapter({ meeting: { topics: [] }, entities: [], relations: [], items: [] });
    const { ai, failures } = createLiveKvoxAi({ provider: 'openai', model: 'gpt-test', apiKey: SECRET, adapters: { openai: adapter } });
    const report = await runKgEval({ runner: 'extract', ai, model: 'gpt-test', fixtures: ['m01'] });
    expect(report.runner).toBe('extract');
    expect(report.model).toBe('gpt-test');
    expect(keys).toEqual([SECRET]);
    expect(failures).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('refuses copilot, an unknown provider, openai without a key and openai-compatible without a base URL', () => {
    expect(() => createLiveKvoxAi({ provider: 'copilot', model: 'm', apiKey: 'k' })).toThrow(LiveProviderError);
    expect(() => createLiveKvoxAi({ provider: 'nope', model: 'm', apiKey: 'k' })).toThrow("unknown provider 'nope'");
    expect(() => createLiveKvoxAi({ provider: 'openai', model: 'm', apiKey: null })).toThrow('needs an API key');
    expect(() => createLiveKvoxAi({ provider: 'openai-compatible', model: 'm', apiKey: null })).toThrow('--base-url');
  });

  it('builds the platform adapters by default', () => {
    expect(() => createLiveKvoxAi({ provider: 'openai', model: 'm', apiKey: 'k' })).not.toThrow();
    expect(() => createLiveKvoxAi({ provider: 'openai-compatible', model: 'm', apiKey: null, baseUrl: 'http://localhost:1/v1' })).not.toThrow();
  });
});

describe('assertOutsideRepo (package)', () => {
  it('refuses the repository root and accepts a path outside it', () => {
    expect(() => assertOutsideRepo(REPO_ROOT)).toThrow(RealDataPathError);
    expect(() => assertOutsideRepo(join(tmpdir(), 'somewhere-else'))).not.toThrow();
  });

  it('lets a caller-named scratch directory through only when asked', () => {
    const scratch = join(REPO_ROOT, 'apps', 'api', '.kg-eval');
    const p = join(scratch, 'runs', 'x');
    expect(() => assertOutsideRepo(p)).toThrow(RealDataPathError);
    expect(assertOutsideRepo(p, { allowInside: scratch })).toBe(p);
  });
});
