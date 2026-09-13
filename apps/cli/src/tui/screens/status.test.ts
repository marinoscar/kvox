import { describe, expect, it } from 'vitest';

import {
  SERVER_URL_ENV_VAR,
  TOKEN_ENV_VAR,
  describeConfig,
  type ConfigContext,
} from '../../config.js';

// =============================================================================
// The status screen shows a `ConfigSummary`, never the token  (issue #145)
// =============================================================================
//
// `StatusScreen` (status.tsx) cannot be rendered without ink-testing-library,
// which is not installed in this package (see the test plan's note on why one
// was not added just for this). What CAN be proven without rendering anything
// is the property the screen's own header comment leans on: `describeConfig`
// — the ONLY source status.tsx reads from — never puts the raw token
// anywhere in the object it returns, masked field included. If that ever
// regressed, the screen would faithfully render whatever it was given.
// =============================================================================

const SECRET = 'pat_super-secret-token-value-do-not-print-me';

function envCtx(overrides: Partial<Record<string, string>> = {}): ConfigContext {
  return {
    home: '/nonexistent-appctl-status-test-home',
    env: {
      [SERVER_URL_ENV_VAR]: 'https://app.example.com',
      [TOKEN_ENV_VAR]: SECRET,
      ...overrides,
    },
  };
}

describe('describeConfig — the shape StatusScreen renders', () => {
  it('never includes the raw token as the value of any field', () => {
    const summary = describeConfig(envCtx());

    for (const [key, value] of Object.entries(summary)) {
      if (typeof value === 'string') {
        expect(value, `field "${key}" must not contain the raw token`).not.toContain(SECRET);
      }
    }
  });

  it('never includes the raw token anywhere in the serialised object (what a screen would print)', () => {
    const summary = describeConfig(envCtx());
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('tokenHint is masked, not a passthrough of the token', () => {
    const summary = describeConfig(envCtx());
    expect(summary.tokenHint).not.toBe(SECRET);
  });

  it('holds even when the token is short (no prefix long enough to reveal)', () => {
    const summary = describeConfig(envCtx({ [TOKEN_ENV_VAR]: 'short' }));
    expect(JSON.stringify(summary)).not.toContain('short');
  });

  it('holds when there is no token at all', () => {
    const summary = describeConfig(envCtx({ [TOKEN_ENV_VAR]: '' }));
    expect(summary.tokenHint).toBe('(none)');
  });
});
