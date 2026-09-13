import { mkdtempSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLI_NAME } from './branding.js';
import { registerConfigCommand } from './commands/config.js';
import type { ApiClient } from './api-client.js';
import {
  SERVER_URL_ENV_VAR,
  TOKEN_ENV_VAR,
  configDirPath,
  describeConfig,
  maskToken,
  readConfigFile,
  requireCredentials,
  resolveConfig,
  saveCredentials,
  writeConfigFile,
  type ConfigContext,
} from './config.js';
import { completeLogin } from './device-login.js';
import { ApiError, AuthRequiredError } from './errors.js';

// =============================================================================
// CLI config storage, env overrides, headless login (issue #143, epic #110)
// =============================================================================
//
// These are REAL filesystem tests — `fs.mkdtempSync` gives each test its own
// throwaway `$TMPDIR/appctl-config-test-XXXXXX` directory used as `home` via
// `ConfigContext`, and every test removes it in `afterEach`. Mode bits
// (`0600` on the file, `0700` on the directory) are exactly the kind of thing
// a mocked `fs` would happily agree exists without ever proving it — see
// `writeConfigFile`'s own comment on why the "obvious" `{ mode: 0o600 }`
// implementation is silently wrong on an overwrite, which is precisely what
// case 2 below exists to catch.
//
// `vi.mock('node:fs', …)` below is scoped to ONE thing: letting the
// "simulated failed write" test make `renameSync` throw AFTER
// `writeFileSync` has already created the real temp file, so that test
// exercises `writeConfigFile`'s actual cleanup branch rather than a
// permission error that never gets that far. Every other call in this file
// passes straight through to the real implementation via `importOriginal`.
// =============================================================================

let renameShouldFail = false;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameShouldFail) throw new Error('simulated rename failure');
      return actual.renameSync(...args);
    },
  };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'appctl-config-test-'));
  renameShouldFail = false;
});

afterEach(() => {
  renameShouldFail = false;
  rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(overrides: Partial<ConfigContext> = {}): ConfigContext {
  return { home: tmpDir, env: {}, ...overrides };
}

describe('writeConfigFile — file and directory permissions', () => {
  it('creates a brand-new config file with mode 0600', () => {
    const path = writeConfigFile({ serverUrl: 'https://app.example.com', token: 'pat_x' }, ctx());

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the config directory with mode 0700', () => {
    writeConfigFile({ serverUrl: 'https://app.example.com', token: 'pat_x' }, ctx());

    const dirMode = statSync(configDirPath(ctx())).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it('re-secures an existing world-readable file to 0600 on overwrite (the create-vs-overwrite trap)', () => {
    const c = ctx();
    const path = writeConfigFile({ serverUrl: 'https://app.example.com', token: 'pat_old' }, c);

    // Simulate a config file that predates the 0600-at-creation guarantee, or
    // was hand-edited/restored with looser permissions.
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    // A plain `writeFileSync(path, data, { mode: 0o600 })` on an EXISTING file
    // would silently leave it at 0o644 — `mode` only applies when open(2)
    // CREATES the file. `writeConfigFile` must go through its create-temp,
    // then rename-over-target path instead, which is what actually fixes this.
    writeConfigFile({ serverUrl: 'https://app.example.com', token: 'pat_new' }, c);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readConfigFile(c)?.token).toBe('pat_new');
  });

  it('leaves no leftover temp files after a normal save', () => {
    const c = ctx();
    writeConfigFile({ serverUrl: 'https://app.example.com', token: 'pat_x' }, c);
    // A second save, so any temp-naming collision or leftover from the first
    // write would show up too.
    writeConfigFile({ serverUrl: 'https://app.example.com', token: 'pat_y' }, c);

    const entries = readdirSync(configDirPath(c));
    expect(entries).toEqual(['config.json']);
  });

  it('leaves no leftover temp files after a SIMULATED FAILED write (rename throws after the temp file was created)', () => {
    const c = ctx();
    // A prior successful login, so we can also prove it survives untouched.
    writeConfigFile({ serverUrl: 'https://app.example.com', token: 'pat_good' }, c);

    renameShouldFail = true;
    try {
      expect(() =>
        writeConfigFile({ serverUrl: 'https://app.example.com', token: 'pat_bad' }, c),
      ).toThrow();
    } finally {
      renameShouldFail = false;
    }

    // Only the original config.json remains — the temp file created by
    // writeFileSync before the mocked renameSync threw was cleaned up by
    // writeConfigFile's own catch block (`rmSync(tmp, { force: true })`).
    const entries = readdirSync(configDirPath(c));
    expect(entries).toEqual(['config.json']);

    // And the failed write did not clobber the previously-good file.
    expect(readConfigFile(c)?.token).toBe('pat_good');
  });
});

describe('resolveConfig — environment overrides the file', () => {
  it('prefers env values over a file that has different values', () => {
    const c: ConfigContext = {
      home: tmpDir,
      env: {
        [SERVER_URL_ENV_VAR]: 'https://from-env.example.com',
        [TOKEN_ENV_VAR]: 'pat_from_env',
      },
    };

    writeConfigFile(
      { serverUrl: 'https://from-file.example.com', token: 'pat_from_file' },
      c,
    );

    const resolved = resolveConfig(c);

    expect(resolved.serverUrl).toBe('https://from-env.example.com');
    expect(resolved.token).toBe('pat_from_env');
    expect(resolved.serverUrlSource).toBe('env');
    expect(resolved.tokenSource).toBe('env');
  });
});

describe('requireCredentials — the three "nothing usable" messages', () => {
  it('names the missing variable when only APPCTL_TOKEN is set (no file)', () => {
    const c: ConfigContext = { home: tmpDir, env: { [TOKEN_ENV_VAR]: 'pat_only' } };

    expect(() => requireCredentials(c)).toThrow(AuthRequiredError);
    try {
      requireCredentials(c);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthRequiredError);
      expect((error as Error).message).toContain(SERVER_URL_ENV_VAR);
    }
  });

  it('names the missing variable when only APPCTL_SERVER_URL is set (no file)', () => {
    const c: ConfigContext = {
      home: tmpDir,
      env: { [SERVER_URL_ENV_VAR]: 'https://app.example.com' },
    };

    try {
      requireCredentials(c);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthRequiredError);
      expect((error as Error).message).toContain(TOKEN_ENV_VAR);
    }
  });

  it('gives the "run login" guidance — not a raw 401 — when nothing is configured at all', () => {
    const c = ctx(); // empty env, no file ever written in this tmpDir

    try {
      requireCredentials(c);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthRequiredError);
      const message = (error as Error).message;
      expect(message).toContain(`${CLI_NAME} login`);
      // Explicitly NOT the shape of a server-rejected-credential message.
      expect(message).not.toMatch(/401/);
      expect(message).not.toMatch(/unauthorized/i);
    }
  });
});

describe('config command — the token is never printed', () => {
  const SENTINEL_TOKEN = 'pat_SENTINELdoNotPrint1234567890abcdef';

  it('describeConfig() never exposes the raw token — only a masked hint', () => {
    const c = ctx();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SENTINEL_TOKEN }, c);

    const summary = describeConfig(c);

    expect(JSON.stringify(summary)).not.toContain(SENTINEL_TOKEN);
    expect(summary.tokenHint).not.toBe(SENTINEL_TOKEN);
    expect(summary.tokenHint).toBe(maskToken(SENTINEL_TOKEN));
  });

  it('the actual `config` command output never contains the token, stdout or stderr', async () => {
    const c = ctx();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SENTINEL_TOKEN }, c);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let stdoutText = '';
    let stderrText = '';
    try {
      const program = new Command();
      registerConfigCommand(program, c);
      await program.parseAsync(['config'], { from: 'user' });
    } finally {
      // Read the recorded calls BEFORE restoring — `mockRestore()` clears the
      // spy's call history along with putting the real implementation back,
      // so anything read afterward would see an empty array.
      stdoutText = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
      stderrText = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    expect(stdoutText).not.toContain(SENTINEL_TOKEN);
    expect(stderrText).not.toContain(SENTINEL_TOKEN);
    // Sanity check the command actually printed something meaningful, so an
    // empty/no-op output could not trivially "pass" this assertion.
    expect(stderrText).toContain('app.example.com');
  });
});

describe('completeLogin (--token path) — a failed validation does not overwrite a good token', () => {
  it('leaves the previously-stored good token in place after a bad --token attempt fails', async () => {
    const c = ctx();
    const goodServerUrl = 'https://good.example.com';
    const goodToken = 'pat_good_token_value';

    saveCredentials({ serverUrl: goodServerUrl, token: goodToken }, c);

    const rejectingClient = {
      get: vi.fn().mockRejectedValue(
        new ApiError({
          status: 401,
          serverMessage: 'Unauthorized',
          code: 'UNAUTHORIZED',
          details: undefined,
          method: 'GET',
          url: `${goodServerUrl}/api/auth/me`,
          structured: true,
        }),
      ),
    } as unknown as ApiClient;

    await expect(
      completeLogin({
        serverUrl: goodServerUrl,
        token: 'pat_bad_token_value',
        configContext: c,
        createClient: () => rejectingClient,
      }),
    ).rejects.toThrow();

    const stored = readConfigFile(c);
    expect(stored?.token).toBe(goodToken);
    expect(stored?.serverUrl).toBe(goodServerUrl);
  });
});
