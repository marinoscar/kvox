import { describe, expect, it } from 'vitest';

import type { DatabaseSettings } from './checks/database.js';
import { databaseFacts, describeDatabase, dropDatabase, droppableDatabase } from './database-drop.js';
import type { CommandResult, RunCommandOptions } from './executor.js';

// =============================================================================
// database-drop.ts  (issue #268)
// =============================================================================
//
// The one destructive statement `deploy` will ever issue against an operator's
// database, so the assertions here are mostly about what it does NOT do:
// terminate anything on the ordinary path, terminate anything outside this one
// database when it must, or hand psql's own sentence back as a remedy.
// =============================================================================

const SETTINGS: DatabaseSettings = {
  host: 'db.internal',
  port: '5432',
  user: 'app',
  password: 'super-secret-value',
  database: 'appdb',
  ssl: false,
};

interface Answer {
  /** A substring of the statement this answer is for. */
  when: string;
  stdout?: string;
  stderr?: string;
  fail?: boolean;
  /** Use this answer only on the nth matching call (1-based). */
  nth?: number;
}

interface Fake {
  sql: string[];
  envs: (NodeJS.ProcessEnv | undefined)[];
  runCommand: typeof import('./executor.js').runCommand;
}

function fake(answers: Answer[]): Fake {
  const sql: string[] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const counts = new Map<string, number>();

  const runCommand = (async (
    argv: readonly string[],
    options: RunCommandOptions,
  ): Promise<CommandResult> => {
    const statement = argv[argv.indexOf('-tAc') + 1] ?? '';
    sql.push(statement);
    envs.push(options.env);

    const matching = answers.filter((answer) => statement.includes(answer.when));
    const seen = (counts.get(statement) ?? 0) + 1;
    counts.set(statement, seen);
    const answer = matching.find((candidate) => candidate.nth === seen) ?? matching.find((candidate) => candidate.nth === undefined);

    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: answer?.fail === true ? 1 : 0,
      stdout: answer?.stdout ?? '',
      stderr: answer?.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (answer?.fail === true) throw Object.assign(new Error('exited 1'), { result });
    return result;
  }) as typeof import('./executor.js').runCommand;

  return { sql, envs, runCommand };
}

describe('droppableDatabase', () => {
  it('names the database from the deployment’s own .env', () => {
    const target = droppableDatabase(
      new Map([
        ['POSTGRES_DB', 'appdb'],
        ['POSTGRES_HOST', 'db.internal'],
        ['POSTGRES_USER', 'app'],
      ]),
    );

    expect(target?.settings.database).toBe('appdb');
    expect(target?.description).toBe('appdb on db.internal:5432 as app');
  });

  it('answers undefined when no database is named', () => {
    expect(droppableDatabase(undefined)).toBeUndefined();
    expect(droppableDatabase(new Map([['POSTGRES_DB', '']]))).toBeUndefined();
  });
});

describe('databaseFacts', () => {
  it('is READ-ONLY: it sizes and counts, and changes nothing', async () => {
    const probe = fake([
      { when: 'pg_size_pretty', stdout: '42 MB' },
      { when: 'count(*) from pg_stat_activity', stdout: '3' },
    ]);

    const facts = await databaseFacts(probe, SETTINGS);

    expect(facts).toEqual({
      database: 'appdb',
      host: 'db.internal',
      port: '5432',
      user: 'app',
      size: '42 MB',
      connections: 3,
    });
    // It runs under --dry-run and before the operator has decided.
    for (const statement of probe.sql) {
      expect(statement).not.toMatch(/\b(DROP|CREATE|ALTER|pg_terminate_backend)\b/i);
    }
  });

  it('runs against `postgres`, never the database it is asking about', async () => {
    const probe = fake([{ when: 'pg_size_pretty', stdout: '1 MB' }]);
    const captured: string[] = [];
    const wrapped = {
      runCommand: (async (argv: readonly string[], options: RunCommandOptions) => {
        captured.push(argv[argv.indexOf('-d') + 1] ?? '');
        return probe.runCommand(argv, options);
      }) as typeof probe.runCommand,
    };

    await databaseFacts(wrapped, SETTINGS);

    expect(new Set(captured)).toEqual(new Set(['postgres']));
  });

  it('reports a number it could not read as MISSING, never as zero', async () => {
    const probe = fake([
      { when: 'pg_size_pretty', stdout: '42 MB' },
      { when: 'count(*) from pg_stat_activity', fail: true, stderr: 'permission denied' },
    ]);

    const facts = await databaseFacts(probe, SETTINGS);

    // "0 connections" that means "I could not see them" is exactly the
    // reassurance that gets an operator to consent.
    expect(facts.connections).toBeUndefined();
    expect(describeDatabase(facts)).toContain(
      "  Sessions    could not be read (app may not see other roles' sessions)",
    );
  });

  it('reports a database that is not there rather than pretending to size it', async () => {
    const probe = fake([
      { when: 'pg_size_pretty', fail: true, stderr: 'ERROR:  database "appdb" does not exist' },
    ]);

    const facts = await databaseFacts(probe, SETTINGS);

    expect(facts.problem).toContain('does not exist on db.internal:5432');
    expect(describeDatabase(facts).join('\n')).toContain('Could not read it');
  });

  it('never puts the password in an argv', async () => {
    const probe = fake([{ when: 'pg_size_pretty', stdout: '1 MB' }]);
    const seen: string[][] = [];
    const wrapped = {
      runCommand: (async (argv: readonly string[], options: RunCommandOptions) => {
        seen.push([...argv]);
        return probe.runCommand(argv, options);
      }) as typeof probe.runCommand,
    };

    await databaseFacts(wrapped, SETTINGS);

    for (const argv of seen) expect(argv.join(' ')).not.toContain(SETTINGS.password);
    expect(probe.envs[0]?.['PGPASSWORD']).toBe(SETTINGS.password);
  });
});

describe('dropDatabase', () => {
  it('issues one quoted DROP and touches no session when nothing is connected', async () => {
    const probe = fake([]);

    const outcome = await dropDatabase(probe, SETTINGS);

    expect(outcome).toEqual({ ok: true, detail: 'dropped appdb', terminated: 0 });
    expect(probe.sql).toEqual(['DROP DATABASE "appdb"']);
    // Termination is the remedy for one failure, not part of the happy path.
    expect(probe.sql.some((statement) => statement.includes('pg_terminate_backend'))).toBe(false);
  });

  it('is NOT `WITH (FORCE)`: that is PG13+ and silent about what it killed', async () => {
    const probe = fake([]);
    await dropDatabase(probe, SETTINGS);

    expect(probe.sql[0]).not.toMatch(/FORCE/i);
  });

  it('terminates only this database’s sessions, and reports how many', async () => {
    const probe = fake([
      {
        when: 'DROP DATABASE',
        nth: 1,
        fail: true,
        stderr: 'ERROR:  database "appdb" is being accessed by other users',
      },
      { when: 'pg_terminate_backend', stdout: '4' },
    ]);

    const outcome = await dropDatabase(probe, SETTINGS);

    const terminate = probe.sql.find((statement) => statement.includes('pg_terminate_backend'));
    // ⚠ Scoped. The operator authorised destroying ONE database; a session
    // against a different one is not theirs to end.
    expect(terminate).toContain("datname = 'appdb'");
    expect(terminate).toContain('pid <> pg_backend_pid()');
    expect(outcome).toMatchObject({ ok: true, terminated: 4 });
    expect(outcome.ok === true && outcome.detail).toContain('after ending 4 open session(s)');
  });

  it('never terminates for a failure that is not 55006', async () => {
    const probe = fake([
      { when: 'DROP DATABASE', fail: true, stderr: 'ERROR:  permission denied to drop database' },
    ]);

    const outcome = await dropDatabase(probe, SETTINGS);

    expect(probe.sql.some((statement) => statement.includes('pg_terminate_backend'))).toBe(false);
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false && outcome.detail).toContain('may not drop appdb');
    expect(outcome.ok === false && outcome.remedy).toContain(
      'dropdb -h db.internal -p 5432 -U app appdb',
    );
  });

  it('explains an unbreakable block in English, with a query naming what holds it', async () => {
    const probe = fake([
      {
        when: 'DROP DATABASE',
        fail: true,
        stderr: 'ERROR:  database "appdb" is being accessed by other users',
      },
      { when: 'pg_terminate_backend', fail: true, stderr: 'ERROR:  permission denied' },
    ]);

    const outcome = await dropDatabase(probe, SETTINGS);

    expect(outcome.ok).toBe(false);
    // The operator is not left staring at psql's own sentence.
    expect(outcome.ok === false && outcome.detail).toContain('may not end the sessions holding it');
    expect(outcome.ok === false && outcome.remedy).toContain('pg_stat_activity');
    expect(outcome.ok === false && outcome.remedy).toContain('a pooler');
  });

  it('says so plainly when something reconnects between the terminate and the retry', async () => {
    const probe = fake([
      {
        when: 'DROP DATABASE',
        fail: true,
        stderr: 'ERROR:  database "appdb" is being accessed by other users',
      },
      { when: 'pg_terminate_backend', stdout: '2' },
    ]);

    const outcome = await dropDatabase(probe, SETTINGS);

    // A third attempt would race the same way, so it does not make one.
    expect(probe.sql.filter((statement) => statement.startsWith('DROP DATABASE'))).toHaveLength(2);
    expect(outcome.ok === false && outcome.detail).toContain('something reconnected immediately');
    expect(outcome.ok === false && outcome.remedy).toContain('Stop it first');
  });

  it('treats a database that is already gone as the state that was asked for', async () => {
    const probe = fake([
      { when: 'DROP DATABASE', fail: true, stderr: 'ERROR:  database "appdb" does not exist' },
    ]);

    expect(await dropDatabase(probe, SETTINGS)).toEqual({
      ok: true,
      detail: 'appdb was already gone',
      terminated: 0,
    });
  });

  it('refuses a name that is not a plain identifier instead of escaping it cleverly', async () => {
    const probe = fake([]);

    const outcome = await dropDatabase(probe, { ...SETTINGS, database: 'app db"; DROP' });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.detail).toContain('not a plain identifier');
    // Nothing was sent at all.
    expect(probe.sql).toEqual([]);
  });
});

describe('describeDatabase', () => {
  it('warns that sessions will be ended when it can see some', () => {
    const lines = describeDatabase({
      database: 'appdb',
      host: 'db.internal',
      port: '5432',
      user: 'app',
      size: '42 MB',
      connections: 3,
    }).join('\n');

    expect(lines).toContain('appdb on db.internal:5432 as app');
    expect(lines).toContain('42 MB');
    expect(lines).toContain('3 other connection(s) open right now');
    expect(lines).toContain('scoped to this database only');
  });

  it('says nothing about ending sessions when there are none', () => {
    const lines = describeDatabase({
      database: 'appdb',
      host: 'db.internal',
      port: '5432',
      user: 'app',
      size: '1 MB',
      connections: 0,
    }).join('\n');

    expect(lines).not.toContain('scoped to this database only');
  });
});
