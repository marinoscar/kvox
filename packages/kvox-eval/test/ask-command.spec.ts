/**
 * `kvox-eval ask` configuration errors (#608): every refusal that must happen
 * before the in-memory database starts. The runner and the replay are mocked, so
 * a spec that reaches either fails loudly; nothing here starts PGlite.
 */

import { ASK_EVAL_EXIT, runAskCommand, type AskCommandIo } from '../src/ask-run/ask-command';
import { runAskReplay } from '../src/ask-run/replay';
import { runAskEval } from '../src/ask-run/run-ask-eval';
import { KVOX_EVAL_API_KEY_ENV } from '../src/live/env';

jest.mock('../src/ask-run/run-ask-eval', () => ({
  DEFAULT_ASK_EVAL_MODEL: 'gpt-4o-mini',
  runAskEval: jest.fn(async () => {
    throw new Error('runAskEval must not be reached');
  }),
  startAskEvalSession: jest.fn(async () => {
    throw new Error('startAskEvalSession must not be reached');
  }),
}));
jest.mock('../src/ask-run/replay', () => ({
  runAskReplay: jest.fn(async () => {
    throw new Error('runAskReplay must not be reached');
  }),
}));

const KEY = 'sk-test-ask-command-never-printed';

function capture(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: AskCommandIo = { out: (s) => out.push(s), err: (s) => err.push(s), env };
  return { io, out, err, errText: () => err.join('\n'), all: () => [...out, ...err].join('\n') };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('kvox-eval ask: configuration errors (no database)', () => {
  it('with no key it exits 2 naming the variable, before anything starts', async () => {
    const c = capture({});
    expect(await runAskCommand([], c.io)).toBe(ASK_EVAL_EXIT.config);
    expect(c.errText()).toContain(`reads its API key from ${KVOX_EVAL_API_KEY_ENV}; it is not set`);
    expect(runAskEval).not.toHaveBeenCalled();
    expect(runAskReplay).not.toHaveBeenCalled();
  });

  it('an empty key counts as no key', async () => {
    const c = capture({ [KVOX_EVAL_API_KEY_ENV]: '' });
    expect(await runAskCommand(['--model', 'm'], c.io)).toBe(ASK_EVAL_EXIT.config);
    expect(runAskEval).not.toHaveBeenCalled();
  });

  it('--provider copilot is refused with exit 2 even when a key is set', async () => {
    const c = capture({ [KVOX_EVAL_API_KEY_ENV]: KEY });
    expect(await runAskCommand(['--provider', 'copilot'], c.io)).toBe(ASK_EVAL_EXIT.config);
    expect(c.errText()).toContain("'copilot'");
    expect(c.all()).not.toContain(KEY);
    expect(runAskEval).not.toHaveBeenCalled();
  });

  it('an unknown provider is refused with exit 2', async () => {
    const c = capture({ [KVOX_EVAL_API_KEY_ENV]: KEY });
    expect(await runAskCommand(['--provider', 'nope'], c.io)).toBe(ASK_EVAL_EXIT.config);
    expect(c.errText()).toContain("unknown provider 'nope'");
    expect(runAskEval).not.toHaveBeenCalled();
  });

  it('--replay with a live-only flag exits 2 and prints the usage', async () => {
    for (const flags of [['--model', 'm'], ['--provider', 'openai'], ['--base-url', 'http://x'], ['--only', 'q01'], ['--category', 'negative'], ['--min-match', '0.5']]) {
      const c = capture({});
      expect(await runAskCommand(['--replay', ...flags], c.io)).toBe(ASK_EVAL_EXIT.config);
      expect(c.errText()).toContain(`--replay takes no ${flags[0]}`);
      expect(c.errText()).toContain('usage: kvox-eval ask');
    }
    expect(runAskReplay).not.toHaveBeenCalled();
  });

  it.each(['abc', '-0.1', '1.5'])('a bad --min-match (%s) exits 2', async (value) => {
    const c = capture({ [KVOX_EVAL_API_KEY_ENV]: KEY });
    expect(await runAskCommand([`--min-match=${value}`], c.io)).toBe(ASK_EVAL_EXIT.config);
    expect(c.errText()).toContain('--min-match must be a number between 0 and 1');
    expect(runAskEval).not.toHaveBeenCalled();
  });

  it('no selected questions exits 2 without running', async () => {
    const c = capture({ [KVOX_EVAL_API_KEY_ENV]: KEY });
    expect(await runAskCommand(['--category', 'no-such-category'], c.io)).toBe(ASK_EVAL_EXIT.config);
    expect(runAskEval).not.toHaveBeenCalled();
  });

  it('an unknown question id exits 2 without running', async () => {
    const c = capture({ [KVOX_EVAL_API_KEY_ENV]: KEY });
    expect(await runAskCommand(['--only', 'q9999'], c.io)).toBe(ASK_EVAL_EXIT.config);
    expect(runAskEval).not.toHaveBeenCalled();
  });

  it.each([['--nope'], ['--model'], ['positional']])('an unknown flag or malformed argument (%s) exits 2 with the usage', async (arg) => {
    const c = capture({ [KVOX_EVAL_API_KEY_ENV]: KEY });
    expect(await runAskCommand([arg], c.io)).toBe(ASK_EVAL_EXIT.config);
    expect(c.errText()).toContain('usage: kvox-eval ask');
    expect(runAskEval).not.toHaveBeenCalled();
  });

  it('--help prints the usage and exits 0', async () => {
    const c = capture({});
    expect(await runAskCommand(['--help'], c.io)).toBe(ASK_EVAL_EXIT.ok);
    expect(c.out.join('\n')).toContain('usage: kvox-eval ask');
  });

  it('a host-named command prefixes its messages with its own name', async () => {
    const c = capture({});
    expect(await runAskCommand([], c.io, { name: 'ask:eval' })).toBe(ASK_EVAL_EXIT.config);
    expect(c.errText()).toContain('ask:eval: reads its API key');
  });
});
