import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeLogger, REDACTED, formatLogRecord, readLogTail, redact } from './logger.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appctl-logger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('redact (issue #275)', () => {
  it('redacts by key, at any depth, through arrays', () => {
    const out = redact({
      token: 'nod_secret',
      nested: { apiKey: 'k', list: [{ password: 'p' }, { fine: 'yes' }] },
    }) as Record<string, unknown>;

    expect(out.token).toBe(REDACTED);
    const nested = out.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe(REDACTED);
    expect((nested.list as Array<Record<string, unknown>>)[0]?.password).toBe(REDACTED);
    expect((nested.list as Array<Record<string, unknown>>)[1]?.fine).toBe('yes');
  });

  it('anchors ^pat$ so `path` and `pattern` survive', () => {
    // These two appear constantly in a worker's log lines. Redacting them would
    // make the log useless in exactly the situation it exists for.
    const out = redact({ path: '/tmp/x', pattern: '*.mp4', pat: 'pat_secret' }) as Record<string, unknown>;
    expect(out.path).toBe('/tmp/x');
    expect(out.pattern).toBe('*.mp4');
    expect(out.pat).toBe(REDACTED);
  });

  it('redacts a presigned URL wherever it appears, including inside a message', () => {
    const out = redact({
      url: 'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=deadbeef&X-Amz-Expires=900',
      note: 'download failed for https://store.example/o?sig=abc123 after 3 tries',
    }) as Record<string, string>;

    expect(out.url).toBe('[redacted-signed-url]');
    expect(out.note).toContain('[redacted-signed-url]');
    expect(out.note).not.toContain('abc123');
  });

  it('redacts bare pat_/nod_ credentials in free text', () => {
    const out = redact('the server rejected nod_abcdef123456') as string;
    expect(out).toBe('the server rejected nod_[redacted]');
  });

  it('does not hang on a cyclic structure', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.self).toBe('[circular]');
  });

  it('summarises past the depth limit rather than recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[max depth]');
  });
});

describe('NodeLogger', () => {
  it('writes JSONL at 0600 and never throws on an unwritable path', () => {
    const path = join(dir, 'logs', 'node.log');
    const logger = new NodeLogger({ path });
    logger.info('hello', { jobId: 'j1', token: 'nod_secret' });

    const line = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
    expect(line.msg).toBe('hello');
    expect(line.jobId).toBe('j1');
    expect(line.token).toBe(REDACTED);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // A path whose parent is a file: mkdir fails. Logging must still not throw.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'x');
    expect(() => new NodeLogger({ path: join(blocked, 'sub', 'node.log') }).error('boom')).not.toThrow();
  });

  it('rolls over one generation at the configured size', () => {
    const path = join(dir, 'node.log');
    const logger = new NodeLogger({ path, rolloverBytes: 200 });
    for (let i = 0; i < 20; i += 1) logger.info(`line ${i} ${'x'.repeat(40)}`);

    expect(statSync(`${path}.1`).size).toBeGreaterThan(0);
    expect(statSync(path).size).toBeLessThan(200 + 200);
  });

  it('mirrors to a consumer, and a throwing mirror does not stop the file write', () => {
    const path = join(dir, 'node.log');
    const logger = new NodeLogger({
      path,
      mirror: () => {
        throw new Error('a broken renderer');
      },
    });
    expect(() => logger.info('still written')).not.toThrow();
    expect(readFileSync(path, 'utf8')).toContain('still written');
  });
});

describe('readLogTail', () => {
  it('returns the last N records and skips a partial trailing line', () => {
    const path = join(dir, 'node.log');
    writeFileSync(
      path,
      ['{"ts":"1","level":"info","msg":"a"}', '{"ts":"2","level":"info","msg":"b"}', '{"ts":"3","level":"in'].join('\n'),
    );

    const tail = readLogTail(path, 2);
    expect(tail.map((record) => record.msg)).toEqual(['a', 'b']);
  });

  it('returns nothing for a missing file rather than throwing', () => {
    expect(readLogTail(join(dir, 'nope.log'))).toEqual([]);
  });

  it('formats a record with its extra fields', () => {
    expect(formatLogRecord({ ts: 'T', level: 'warn', msg: 'hi', jobId: 'j' })).toBe('T WARN  hi {"jobId":"j"}');
  });
});

// =============================================================================
// The per-job database credential (#352, epic #345)
// =============================================================================
//
// A worker node now holds a real database password for the length of one job.
// It lives in a local constant and is handed to one child process — see
// `executors/db-backup-run.ts` — but "nothing logs it" has to be a property of
// THIS file too, because the executor is not the only thing that can end up
// holding the broker's response (an error, an engine event, a fork's own code).

describe('redacting a brokered credential', () => {
  const PASSWORD = 'p4ssw0rd-9f2c';

  it('redacts the broker response wholesale, whatever shape the material has', () => {
    // ⚠ WHOLESALE, BY KEY, and that is the point: the material's shape is the
    // BROKER's business — discrete fields today, a token and an endpoint
    // tomorrow — so a rule that only knew about `password` would leak the next
    // broker's spelling.
    const redacted = redact({
      secret: { kind: 'postgres.readonly', material: { user: 'r', password: PASSWORD } },
      material: { anything: PASSWORD, nested: { deeper: PASSWORD } },
    }) as Record<string, unknown>;

    expect(JSON.stringify(redacted)).not.toContain(PASSWORD);
    expect(redacted.material).toBe(REDACTED);
  });

  it('redacts `PGPASSWORD=…` inside a MESSAGE, which no key-based rule can see', () => {
    // The real shape: a spawn failure that echoed the child's environment, or
    // a command an operator pasted into an issue.
    const line = redact(
      `spawn failed: env PGPASSWORD=${PASSWORD} pg_dump --host db.internal`,
    ) as string;

    expect(line).not.toContain(PASSWORD);
    expect(line).toContain('PGPASSWORD=[redacted]');
    // The rest of the line survives — a log that redacted the command too
    // would be useless in exactly the situation it exists for.
    expect(line).toContain('pg_dump --host db.internal');
  });

  it('redacts the password out of a `postgres://` URI an error echoed', () => {
    // This repository never BUILDS one (`pg-job-role.broker.ts` hands over
    // discrete fields precisely so no password is percent-encoded into a URL),
    // but libpq will happily print one an operator configured by hand.
    const line = redact(
      `connection to postgresql://appjob_reader:${PASSWORD}@db.internal:5432/appdb failed`,
    ) as string;

    expect(line).not.toContain(PASSWORD);
    expect(line).toContain('postgresql://appjob_reader:[redacted]@db.internal:5432/appdb');
  });

  it('still leaves ordinary fields alone', () => {
    // The counter-assertion the anchored `^pat$` rule already earns: a worker's
    // log is full of paths and patterns, and a logger that redacted them would
    // be worse than no logger.
    const kept = redact({ path: '/var/lib/appctl', pattern: '*.dump', host: 'db.internal' });

    expect(kept).toEqual({ path: '/var/lib/appctl', pattern: '*.dump', host: 'db.internal' });
  });
});
