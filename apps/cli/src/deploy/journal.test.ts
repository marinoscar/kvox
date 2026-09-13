import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CommandResult } from './executor.js';
import { createRedactor, openJournal, pruneOldRuns, timestampSlug } from './journal.js';

// A real filesystem, not a mocked one: the assertions that matter most here are
// about file MODE and about what happens when a write genuinely fails, and
// neither survives being mocked.
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-journal-'));
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    argv: ['docker', 'compose', 'build'],
    cwd: '/srv/app',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 5,
    timedOut: false,
    ...overrides,
  };
}

describe('createRedactor', () => {
  it('replaces a secret with a marker naming its key', () => {
    const redact = createRedactor([{ key: 'JWT_SECRET', value: 's3cret-value' }]);

    expect(redact('token=s3cret-value end')).toBe(
      'token=***REDACTED:JWT_SECRET*** end',
    );
  });

  it('replaces every occurrence, not just the first', () => {
    const redact = createRedactor([{ key: 'K', value: 'abcdef' }]);

    expect(redact('abcdef abcdef')).toBe(
      '***REDACTED:K*** ***REDACTED:K***',
    );
  });

  it('ignores values too short to redact safely', () => {
    // Redacting "ab" would replace those two characters everywhere and destroy
    // the log, hiding the very failure being diagnosed.
    const redact = createRedactor([{ key: 'SHORT', value: 'ab' }]);

    expect(redact('a table of absolutes')).toBe('a table of absolutes');
  });

  it('ignores an empty value', () => {
    const redact = createRedactor([{ key: 'EMPTY', value: '' }]);

    expect(redact('unchanged')).toBe('unchanged');
  });

  it('replaces the longest secret first when they overlap', () => {
    const redact = createRedactor([
      { key: 'PASSWORD', value: 'p4ssword' },
      { key: 'DB_URL', value: 'postgresql://u:p4ssword@host/db' },
    ]);

    // Shortest-first would redact the password inside the URL and leave the
    // rest of the URL - host, user, database - in the clear.
    expect(redact('url=postgresql://u:p4ssword@host/db')).toBe(
      'url=***REDACTED:DB_URL***',
    );
  });

  it('is the identity function when there is nothing to redact', () => {
    expect(createRedactor([])('anything')).toBe('anything');
  });
});

describe('openJournal', () => {
  it('writes a human log and a machine log', () => {
    const root = makeRoot();
    const journal = openJournal({ deployRoot: root, command: 'install' });

    journal.step('build', 'Build images');
    journal.line('a note');
    journal.finish('success');

    const names = readdirSync(join(root, 'logs'));
    expect(names.filter((n) => n.endsWith('.log'))).toHaveLength(1);
    expect(names.filter((n) => n.endsWith('.jsonl'))).toHaveLength(1);

    const human = readFileSync(journal.path, 'utf8');
    expect(human).toContain('Build images');
    expect(human).toContain('a note');
    expect(human).toContain('success');
  });

  it('writes one JSON object per line, each with a type', () => {
    const root = makeRoot();
    const journal = openJournal({ deployRoot: root, command: 'install' });
    journal.step('s', 'Step');
    journal.finish('success');

    const jsonlName = readdirSync(join(root, 'logs')).find((n) => n.endsWith('.jsonl'));
    const lines = readFileSync(join(root, 'logs', jsonlName as string), 'utf8')
      .trim()
      .split('\n');

    const parsed = lines.map((line) => JSON.parse(line) as { type: string });
    expect(parsed.map((entry) => entry.type)).toEqual([
      'run.start',
      'step.start',
      'run.finish',
    ]);
  });

  it('creates both files 0600', () => {
    const root = makeRoot();
    const journal = openJournal({ deployRoot: root, command: 'install' });
    journal.finish('success');

    for (const name of readdirSync(join(root, 'logs'))) {
      const mode = statSync(join(root, 'logs', name)).mode & 0o777;
      // Even redacted, these describe the infrastructure.
      expect(mode).toBe(0o600);
    }
  });

  it('redacts a secret that appears in an argv', () => {
    const root = makeRoot();
    const secret = 'p4ssw0rd-value';
    const journal = openJournal({
      deployRoot: root,
      command: 'install',
      secrets: [{ key: 'POSTGRES_PASSWORD', value: secret }],
    });

    journal.command(
      commandResult({ argv: ['psql', `postgresql://u:${secret}@h/db`] }),
    );
    journal.finish('success');

    const contents = readdirSync(join(root, 'logs'))
      .map((name) => readFileSync(join(root, 'logs', name), 'utf8'))
      .join('');

    expect(contents).not.toContain(secret);
    expect(contents).toContain('***REDACTED:POSTGRES_PASSWORD***');
  });

  it('redacts a secret that appears in captured output', () => {
    const root = makeRoot();
    const secret = 'another-secret';
    const journal = openJournal({
      deployRoot: root,
      command: 'install',
      secrets: [{ key: 'JWT_SECRET', value: secret }],
    });

    journal.command(commandResult({ stdout: `echoed ${secret}`, stderr: secret }));
    journal.line(`and a line with ${secret}`);
    journal.finish('failure', `summary mentioning ${secret}`);

    const contents = readdirSync(join(root, 'logs'))
      .map((name) => readFileSync(join(root, 'logs', name), 'utf8'))
      .join('');

    expect(contents).not.toContain(secret);
  });

  it('exposes its redactor so runCommand can use the same one', () => {
    const root = makeRoot();
    const journal = openJournal({
      deployRoot: root,
      command: 'install',
      secrets: [{ key: 'K', value: 'the-secret-value' }],
    });

    expect(journal.redact('x the-secret-value y')).toBe('x ***REDACTED:K*** y');
  });

  it('ignores a second finish', () => {
    const root = makeRoot();
    const journal = openJournal({ deployRoot: root, command: 'install' });
    journal.finish('success');
    journal.finish('failure');

    const human = readFileSync(journal.path, 'utf8');
    expect(human).not.toContain('failure');
  });

  it('warns once and keeps going when the log cannot be written', () => {
    const root = makeRoot();
    // A FILE where the logs directory needs to be, rather than a read-only
    // directory: mode bits are bypassed when the suite runs as root (it does,
    // in a container), which would make a permissions-based test pass locally
    // for the wrong reason and prove nothing.
    writeFileSync(join(root, 'logs'), 'not a directory');

    const written: string[] = [];
    const journal = openJournal({
      deployRoot: root,
      command: 'install',
      warnStream: { write: (chunk: string) => written.push(chunk) },
    });

    // The whole point: a log that cannot be written must not abort a deploy
    // that is otherwise fine.
    expect(() => {
      journal.step('s', 'Step');
      journal.line('line');
      journal.command(commandResult());
      journal.finish('success');
    }).not.toThrow();

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('deploy log unavailable');
  });
});

describe('pruneOldRuns', () => {
  function seed(logs: string, bases: readonly string[]): void {
    mkdirSync(logs, { recursive: true });
    for (const base of bases) {
      writeFileSync(join(logs, `${base}.log`), 'x');
      writeFileSync(join(logs, `${base}.jsonl`), 'x');
    }
  }

  it('keeps the newest runs and deletes the rest as pairs', () => {
    const root = makeRoot();
    const logs = join(root, 'logs');
    seed(logs, [
      'appctl-install-2026-01-01T00-00-00-000Z',
      'appctl-install-2026-02-01T00-00-00-000Z',
      'appctl-update-2026-03-01T00-00-00-000Z',
    ]);

    pruneOldRuns(logs, 2);

    const remaining = readdirSync(logs).sort();
    expect(remaining).toEqual([
      'appctl-install-2026-02-01T00-00-00-000Z.jsonl',
      'appctl-install-2026-02-01T00-00-00-000Z.log',
      'appctl-update-2026-03-01T00-00-00-000Z.jsonl',
      'appctl-update-2026-03-01T00-00-00-000Z.log',
    ]);
  });

  it('does nothing when under the limit', () => {
    const root = makeRoot();
    const logs = join(root, 'logs');
    seed(logs, ['appctl-install-2026-01-01T00-00-00-000Z']);

    pruneOldRuns(logs, 10);

    expect(readdirSync(logs)).toHaveLength(2);
  });

  it('leaves unrelated files alone', () => {
    const root = makeRoot();
    const logs = join(root, 'logs');
    seed(logs, ['appctl-install-2026-01-01T00-00-00-000Z']);
    writeFileSync(join(logs, 'notes.txt'), 'keep me');

    pruneOldRuns(logs, 0);

    expect(readdirSync(logs)).toContain('notes.txt');
  });

  it('prunes to the retention count when a journal opens', () => {
    const root = makeRoot();
    const logs = join(root, 'logs');
    seed(logs, [
      'appctl-install-2026-01-01T00-00-00-000Z',
      'appctl-install-2026-02-01T00-00-00-000Z',
    ]);

    openJournal({ deployRoot: root, command: 'install', retainRuns: 2 }).finish(
      'success',
    );

    // Retention counts the run being opened, so retainRuns: 2 leaves the newer
    // pre-existing run and the new one, and drops the oldest.
    const kept = readdirSync(logs).filter((n) => n.endsWith('.log')).sort();
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe('appctl-install-2026-02-01T00-00-00-000Z.log');
  });
});

describe('timestampSlug', () => {
  it('is filesystem-safe and sorts chronologically as text', () => {
    const earlier = timestampSlug(new Date('2026-01-01T00:00:00.000Z'));
    const later = timestampSlug(new Date('2026-02-01T00:00:00.000Z'));

    expect(earlier).not.toMatch(/[:.]/);
    expect(earlier < later).toBe(true);
  });
});
