import { describe, expect, it } from 'vitest';

import { CLI_NAME } from '../branding.js';
import { NO_TUI_ENV_VAR, evaluateTuiGate, type TtyContext } from './tty.js';

// =============================================================================
// The TTY gate  (issue #145, epic #110)
// =============================================================================
//
// This is the property that breaks automation when it is wrong: a
// `=== false` typo in `tty.ts` would silently start mounting the TUI into a
// pipe, because `isTTY` on a piped stream is `undefined`, not `false`. Every
// case below is built with an explicit `TtyContext` — never by mutating
// `process.stdout`/`process.stdin`, which the test runner itself reads — so
// each test is independent of the others and of the order files execute in.
// =============================================================================

/** A fully-interactive terminal: both descriptors are TTYs, nothing set. */
function interactiveCtx(overrides: Partial<TtyContext> = {}): TtyContext {
  return {
    stdout: { isTTY: true },
    stdin: { isTTY: true },
    env: { TERM: 'xterm-256color' },
    ...overrides,
  };
}

describe('evaluateTuiGate — the happy path', () => {
  it('engages when both stdout and stdin are real TTYs and nothing objects', () => {
    const decision = evaluateTuiGate(interactiveCtx());
    expect(decision).toEqual({ engage: true });
  });
});

describe('evaluateTuiGate — stdout not a TTY (case 2)', () => {
  // THE case: `isTTY` is `undefined` on a pipe, not `false`. A gate written as
  // `stdout.isTTY === false` would pass this and mount a full-screen renderer
  // into the pipe. Both shapes are covered as SEPARATE tests on purpose, so a
  // regression to `=== false` fails the `undefined` case even if someone
  // "fixes" the `false` case to keep passing.
  it('refuses when stdout.isTTY is undefined (a real pipe)', () => {
    const decision = evaluateTuiGate(
      interactiveCtx({ stdout: { isTTY: undefined } }),
    );
    expect(decision.engage).toBe(false);
    if (!decision.engage) {
      expect(decision.refusal).toBe('stdout-not-a-tty');
    }
  });

  it('refuses when stdout.isTTY is explicitly false', () => {
    const decision = evaluateTuiGate(interactiveCtx({ stdout: { isTTY: false } }));
    expect(decision.engage).toBe(false);
    if (!decision.engage) {
      expect(decision.refusal).toBe('stdout-not-a-tty');
    }
  });

  it('refuses when stdout has no isTTY property at all', () => {
    const decision = evaluateTuiGate(interactiveCtx({ stdout: {} }));
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('stdout-not-a-tty');
  });

  it('names the cause and the thing to do instead', () => {
    const decision = evaluateTuiGate(interactiveCtx({ stdout: { isTTY: undefined } }));
    expect(decision.engage).toBe(false);
    if (decision.engage) return;
    expect(decision.reason).toContain('stdout is not a terminal');
    expect(decision.reason).toContain(`${CLI_NAME} --help`);
  });
});

describe('evaluateTuiGate — stdin not a TTY while stdout is (case 3)', () => {
  // `echo | appctl` and `appctl < /dev/null`: stdout is a real terminal (the
  // menu would be drawn and would look fine), but ink cannot raw-mode a piped
  // stdin, so nothing could ever answer or exit it. This must be caught
  // SEPARATELY from the stdout check, with stdout still a TTY.
  it('refuses when stdin.isTTY is undefined but stdout is a real TTY', () => {
    const decision = evaluateTuiGate(
      interactiveCtx({ stdout: { isTTY: true }, stdin: { isTTY: undefined } }),
    );
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('stdin-not-a-tty');
  });

  it('refuses when stdin.isTTY is explicitly false but stdout is a real TTY', () => {
    const decision = evaluateTuiGate(
      interactiveCtx({ stdout: { isTTY: true }, stdin: { isTTY: false } }),
    );
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('stdin-not-a-tty');
  });

  it('does not fall through to the stdin check when stdout has already failed', () => {
    // Both descriptors are bad, but stdout is checked first (issue #145: "the
    // first one that fires produces the message"), so the refusal must name
    // stdout, not stdin.
    const decision = evaluateTuiGate(
      interactiveCtx({ stdout: { isTTY: undefined }, stdin: { isTTY: undefined } }),
    );
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('stdout-not-a-tty');
  });

  it('names the cause and the thing to do instead', () => {
    const decision = evaluateTuiGate(
      interactiveCtx({ stdout: { isTTY: true }, stdin: { isTTY: undefined } }),
    );
    expect(decision.engage).toBe(false);
    if (decision.engage) return;
    expect(decision.reason).toContain('stdin is not a terminal');
    expect(decision.reason).toContain(`${CLI_NAME} --help`);
  });
});

describe('evaluateTuiGate — TERM reports no cursor addressing (case 4)', () => {
  it('refuses on TERM=dumb even with two real TTYs', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'dumb' } }));
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('dumb-terminal');
  });

  it('refuses on an empty TERM', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: '' } }));
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('dumb-terminal');
  });

  // ABSENT vs EMPTY, as two tests. These are DIFFERENT VALUES — `env.TERM` is
  // `undefined` when nothing exported TERM and `''` when something exported it
  // empty — and the gate originally compared against `''` alone, so the absent
  // case (by far the more common of the two) fell through and engaged the TUI
  // with no terminfo resolved at all. Keeping them separate means a regression
  // to `term === ''` fails the absent case even though the empty case passes.
  it('refuses when TERM was never exported (undefined, not "")', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: {} }));
    expect(decision.engage).toBe(false);
    if (decision.engage) return;
    expect(decision.refusal).toBe('dumb-terminal');
    expect(decision.reason).toContain('TERM is not set');
  });

  it('refuses when TERM is exported empty, and says "empty" rather than "not set"', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: '' } }));
    expect(decision.engage).toBe(false);
    if (decision.engage) return;
    expect(decision.refusal).toBe('dumb-terminal');
    expect(decision.reason).toContain('TERM is empty');
  });

  it('refuses when TERM is only whitespace', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: '   ' } }));
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('dumb-terminal');
  });

  it('is case- and whitespace-insensitive ("DUMB", padded)', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: '  DUMB  ' } }));
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('dumb-terminal');
  });

  it('accepts a normal TERM value', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'screen-256color' } }));
    expect(decision.engage).toBe(true);
  });

  it('names the cause and the thing to do instead', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'dumb' } }));
    expect(decision.engage).toBe(false);
    if (decision.engage) return;
    expect(decision.reason).toContain('TERM is "dumb"');
    expect(decision.reason).toContain(`${CLI_NAME} --help`);
  });
});

describe('evaluateTuiGate — CI, even with a real pty on both descriptors (case 5)', () => {
  // `docker run -t` in a pipeline, a Jenkins pty plugin, `script(1)`-forced
  // colour: every earlier check passes because there really is a terminal.
  // There is still no human present to answer a menu.
  it('refuses when CI is set, with two real TTYs and a real TERM', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'xterm', CI: 'true' } }));
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('ci');
  });

  it('refuses when CONTINUOUS_INTEGRATION is set instead of CI', () => {
    const decision = evaluateTuiGate(
      interactiveCtx({ env: { TERM: 'xterm', CONTINUOUS_INTEGRATION: '1' } }),
    );
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('ci');
  });

  it('CI=false does not refuse — a developer explicitly turning CI mode off', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'xterm', CI: 'false' } }));
    expect(decision.engage).toBe(true);
  });

  it('CI=0 does not refuse', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'xterm', CI: '0' } }));
    expect(decision.engage).toBe(true);
  });

  it('CI=no does not refuse', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'xterm', CI: 'no' } }));
    expect(decision.engage).toBe(true);
  });

  it('CI="" (unset-but-exported) does not refuse', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'xterm', CI: '' } }));
    expect(decision.engage).toBe(true);
  });

  it('names the cause and the thing to do instead', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'xterm', CI: 'true' } }));
    expect(decision.engage).toBe(false);
    if (decision.engage) return;
    expect(decision.reason).toContain('CI is set');
    expect(decision.reason).toContain('unset CI');
  });
});

describe('evaluateTuiGate — APPCTL_NO_TUI, the explicit escape hatch (case 1)', () => {
  it('exports the env var name as APPCTL_NO_TUI', () => {
    expect(NO_TUI_ENV_VAR).toBe('APPCTL_NO_TUI');
  });

  it('refuses unconditionally, even on an otherwise perfect terminal', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'xterm', [NO_TUI_ENV_VAR]: '1' } }));
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('disabled');
  });

  it('is honoured before every other check — wins over a piped stdout too', () => {
    const decision = evaluateTuiGate({
      stdout: { isTTY: undefined },
      stdin: { isTTY: undefined },
      env: { TERM: 'dumb', CI: 'true', [NO_TUI_ENV_VAR]: '1' },
    });
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('disabled');
  });

  it('APPCTL_NO_TUI=false does not disable it', () => {
    const decision = evaluateTuiGate(
      interactiveCtx({ env: { TERM: 'xterm', [NO_TUI_ENV_VAR]: 'false' } }),
    );
    expect(decision.engage).toBe(true);
  });

  it('names the cause and the thing to do instead', () => {
    const decision = evaluateTuiGate(interactiveCtx({ env: { TERM: 'xterm', [NO_TUI_ENV_VAR]: '1' } }));
    expect(decision.engage).toBe(false);
    if (decision.engage) return;
    expect(decision.reason).toContain(NO_TUI_ENV_VAR);
    expect(decision.reason).toContain('Run a subcommand');
  });
});

describe('evaluateTuiGate — precedence, most-actionable-first', () => {
  it('checks are ordered: disabled, stdout, stdin, dumb-terminal, ci', () => {
    // Fail every check at once and confirm only the FIRST one's refusal is
    // reported, one layer at a time by removing the winning cause and
    // re-asserting the next.
    const allBad: TtyContext = {
      stdout: { isTTY: undefined },
      stdin: { isTTY: undefined },
      env: { TERM: 'dumb', CI: 'true', [NO_TUI_ENV_VAR]: '1' },
    };
    let decision = evaluateTuiGate(allBad);
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('disabled');

    decision = evaluateTuiGate({ ...allBad, env: { ...allBad.env, [NO_TUI_ENV_VAR]: undefined } });
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('stdout-not-a-tty');

    decision = evaluateTuiGate({
      ...allBad,
      env: { ...allBad.env, [NO_TUI_ENV_VAR]: undefined },
      stdout: { isTTY: true },
    });
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('stdin-not-a-tty');

    decision = evaluateTuiGate({
      ...allBad,
      env: { ...allBad.env, [NO_TUI_ENV_VAR]: undefined },
      stdout: { isTTY: true },
      stdin: { isTTY: true },
    });
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('dumb-terminal');

    decision = evaluateTuiGate({
      ...allBad,
      env: { ...allBad.env, [NO_TUI_ENV_VAR]: undefined, TERM: 'xterm' },
      stdout: { isTTY: true },
      stdin: { isTTY: true },
    });
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.refusal).toBe('ci');
  });

  it('every refusal has a distinct refusal value', () => {
    const refusals = new Set<string>();

    const cases: TtyContext[] = [
      interactiveCtx({ env: { TERM: 'xterm', [NO_TUI_ENV_VAR]: '1' } }),
      interactiveCtx({ stdout: { isTTY: undefined } }),
      interactiveCtx({ stdin: { isTTY: undefined } }),
      interactiveCtx({ env: { TERM: 'dumb' } }),
      interactiveCtx({ env: { TERM: 'xterm', CI: 'true' } }),
    ];

    for (const ctx of cases) {
      const decision = evaluateTuiGate(ctx);
      expect(decision.engage).toBe(false);
      if (!decision.engage) refusals.add(decision.refusal);
    }

    expect(refusals.size).toBe(cases.length);
  });
});

describe('evaluateTuiGate — defaults to the real process when no context is given', () => {
  it('does not throw when called with no arguments', () => {
    expect(() => evaluateTuiGate()).not.toThrow();
  });

  it('does not throw when called with a context missing stdout/stdin/env', () => {
    expect(() => evaluateTuiGate({})).not.toThrow();
  });
});
