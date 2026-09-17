import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from './executor.js';
import type { DatabaseSettings } from './checks/database.js';
import type { CheckContext, CompletedCheck } from './checks/types.js';
import {
  createDatabase,
  creatableDatabase,
  databaseNameProblem,
  quoteIdentifier,
} from './database-create.js';

// Follows the fake-runner shape established in checks/external.test.ts: a
// responder decides the canned result for whatever argv it is handed, and a
// non-zero exit becomes a thrown CommandFailedError, exactly like the real
// executor.
type Canned = { exitCode: number; stdout?: string; stderr?: string };
type Responder = (argv: readonly string[], options: RunCommandOptions) => Canned | undefined;

function fakeRunCommand(respond: Responder): typeof import('./executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const canned = respond(argv, options) ?? { exitCode: 0, stdout: '' };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) throw new CommandFailedError(result.stderr || 'failed', result);
    return result;
  }) as typeof import('./executor.js').runCommand;
}

const SETTINGS: DatabaseSettings = {
  host: 'db.internal',
  port: '5432',
  user: 'appuser',
  password: 'p@ss/word#1',
  database: 'appdb',
  ssl: false,
};

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: '' })),
    deployRoot: '/opt/infra/apps/demo',
    bindPort: 3535,
    proxyRoot: '/opt/infra/proxy',
    env: new Map(),
    ...overrides,
  };
}

function completed(overrides: Partial<CompletedCheck> = {}): CompletedCheck {
  return {
    id: 'database-exists',
    title: 'Database exists',
    severity: 'required',
    status: 'fail',
    detail: 'database "appdb" does not exist',
    durationMs: 1,
    ...overrides,
  };
}

const ENV = new Map([
  ['POSTGRES_HOST', 'db.internal'],
  ['POSTGRES_PORT', '5432'],
  ['POSTGRES_USER', 'appuser'],
  ['POSTGRES_PASSWORD', 'p@ss/word#1'],
  ['POSTGRES_DB', 'appdb'],
]);

describe('creatableDatabase', () => {
  it('returns a target when database-exists failed with the 3D000 detail', () => {
    const target = creatableDatabase([completed({ detail: 'psql: FATAL: 3D000' })], ENV);
    expect(target).toBeDefined();
    expect(target?.settings.database).toBe('appdb');
  });

  it('returns a target when database-exists failed with the English message', () => {
    const target = creatableDatabase(
      [completed({ detail: 'database "appdb" does not exist' })],
      ENV,
    );
    expect(target).toBeDefined();
  });

  it('returns undefined for a database-exists failure with any other detail', () => {
    // The important negative: a dropped connection or an unrelated error is
    // not fixed by creating a database, and must never be offered as if it
    // were.
    const target = creatableDatabase(
      [completed({ detail: 'server closed the connection unexpectedly' })],
      ENV,
    );
    expect(target).toBeUndefined();
  });

  it('returns undefined when database-exists passed', () => {
    const target = creatableDatabase(
      [completed({ status: 'pass', detail: 'appdb' })],
      ENV,
    );
    expect(target).toBeUndefined();
  });

  it('returns undefined when database-exists is absent from the results', () => {
    const target = creatableDatabase(
      [completed({ id: 'database-credentials', detail: 'password authentication failed' })],
      ENV,
    );
    expect(target).toBeUndefined();
  });

  it('returns undefined when database-exists was skipped', () => {
    const target = creatableDatabase(
      [completed({ status: 'skip', detail: 'skipped: database-credentials did not pass' })],
      ENV,
    );
    expect(target).toBeUndefined();
  });

  it('returns undefined when env is undefined', () => {
    const target = creatableDatabase(
      [completed({ detail: 'database "appdb" does not exist' })],
      undefined,
    );
    expect(target).toBeUndefined();
  });

  it('returns undefined when POSTGRES_DB is empty', () => {
    const target = creatableDatabase(
      [completed({ detail: 'database "appdb" does not exist' })],
      new Map([...ENV, ['POSTGRES_DB', '']]),
    );
    expect(target).toBeUndefined();
  });

  it('names database, host, port and user in the description', () => {
    const target = creatableDatabase(
      [completed({ detail: 'database "appdb" does not exist' })],
      ENV,
    );
    expect(target?.description).toContain('appdb');
    expect(target?.description).toContain('db.internal');
    expect(target?.description).toContain('5432');
    expect(target?.description).toContain('appuser');
  });
});

describe('databaseNameProblem / quoteIdentifier', () => {
  it.each(['kvox', '_x', 'a$b', 'App_1'])('accepts an ordinary name: %s', (name) => {
    expect(databaseNameProblem(name)).toBeUndefined();
  });

  it('rejects an empty name', () => {
    expect(databaseNameProblem('')).toBeDefined();
  });

  it('rejects a name over 63 characters', () => {
    expect(databaseNameProblem('a'.repeat(64))).toBeDefined();
  });

  it.each([
    'has space',
    'has"quote',
    "has'quote",
    'has;semicolon',
    'has-hyphen',
    'café', // non-ASCII
  ])('rejects an unsafe name: %s', (name) => {
    expect(databaseNameProblem(name)).toBeDefined();
  });

  it('wraps a plain name in double quotes', () => {
    expect(quoteIdentifier('kvox')).toBe('"kvox"');
  });

  it('doubles an embedded quote', () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });
});

describe('createDatabase', () => {
  it('connects to the postgres maintenance database and issues CREATE DATABASE', async () => {
    const seen: string[][] = [];
    const outcome = await createDatabase(
      context({
        runCommand: fakeRunCommand((argv) => {
          seen.push([...argv]);
          return { exitCode: 0, stdout: '' };
        }),
      }),
      SETTINGS,
    );

    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const argv = seen[0] as string[];
    // Connects to the maintenance database, never the target: the target is
    // precisely what does not exist yet.
    const dFlagIndex = argv.indexOf('-d');
    expect(dFlagIndex).toBeGreaterThanOrEqual(0);
    expect(argv[dFlagIndex + 1]).toBe('postgres');
    expect(argv.join(' ')).toContain('CREATE DATABASE "appdb"');
  });

  it('never puts the password anywhere in the argv; it is passed by name through env', async () => {
    const seen: string[][] = [];
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];

    await createDatabase(
      context({
        runCommand: fakeRunCommand((argv, options) => {
          seen.push([...argv]);
          envs.push(options.env);
          return { exitCode: 0, stdout: '' };
        }),
      }),
      SETTINGS,
    );

    const flat = seen.flat().join(' ');
    expect(flat).not.toContain('p@ss/word#1');
    // PGPASSWORD is passed BY NAME in argv (as the bare variable name for
    // docker's -e flag), its value only ever appears in the child's env.
    expect(envs[0]?.PGPASSWORD).toBe('p@ss/word#1');
  });

  it('never calls runCommand at all when the name fails validation', async () => {
    let called = false;
    const outcome = await createDatabase(
      context({
        runCommand: fakeRunCommand(() => {
          called = true;
          return { exitCode: 0 };
        }),
      }),
      { ...SETTINGS, database: 'not a valid name' },
    );

    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('reports success on 42P04 (already exists) - a race or a transient error either way', async () => {
    const outcome = await createDatabase(
      context({
        runCommand: fakeRunCommand(() => ({
          exitCode: 1,
          stderr: 'ERROR:  42P04: database "appdb" already exists',
        })),
      }),
      SETTINGS,
    );

    expect(outcome.ok).toBe(true);
  });

  it('reports success on the English "already exists" message too', async () => {
    const outcome = await createDatabase(
      context({
        runCommand: fakeRunCommand(() => ({
          exitCode: 1,
          stderr: 'psql: error: database "appdb" already exists',
        })),
      }),
      SETTINGS,
    );

    expect(outcome.ok).toBe(true);
  });

  it('names ALTER ROLE ... CREATEDB and a manual createdb on a permission error (42501)', async () => {
    const outcome = await createDatabase(
      context({
        runCommand: fakeRunCommand(() => ({
          exitCode: 1,
          stderr: 'ERROR:  42501: permission denied to create database',
        })),
      }),
      SETTINGS,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.remedy).toContain('ALTER ROLE');
      expect(outcome.remedy).toContain('CREATEDB');
      expect(outcome.remedy).toContain('createdb');
    }
  });

  it('names the same remedy on "permission denied" and "must be superuser" phrasing', async () => {
    for (const stderr of [
      'permission denied to create database',
      'must be superuser to create database',
      'must be a member of the role',
    ]) {
      const outcome = await createDatabase(
        context({ runCommand: fakeRunCommand(() => ({ exitCode: 1, stderr })) }),
        SETTINGS,
      );
      expect(outcome.ok, stderr).toBe(false);
      if (!outcome.ok) {
        expect(outcome.remedy).toContain('ALTER ROLE');
        expect(outcome.remedy).toContain('createdb');
      }
    }
  });

  it('carries the first line of stderr for any other failure', async () => {
    const outcome = await createDatabase(
      context({
        runCommand: fakeRunCommand(() => ({
          exitCode: 1,
          stderr: 'FATAL:  the server caught fire\nmore detail on the next line',
        })),
      }),
      SETTINGS,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain('the server caught fire');
      expect(outcome.detail).not.toContain('more detail on the next line');
    }
  });

  it('does not propagate when the runner throws something other than CommandFailedError', async () => {
    const outcome = await createDatabase(
      context({
        runCommand: (async () => {
          throw new Error('ECONNRESET');
        }) as unknown as typeof import('./executor.js').runCommand,
      }),
      SETTINGS,
    );

    // Should resolve, not reject.
    expect(outcome.ok).toBe(false);
  });
});
