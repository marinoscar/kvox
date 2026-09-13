import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// =============================================================================
// The worker's log  (issue #275, epic #254)
// =============================================================================
//
// JSONL under the state directory, one rollover generation at ~5 MiB.
//
// -----------------------------------------------------------------------------
// WRITES ARE SYNCHRONOUS, ON PURPOSE
// -----------------------------------------------------------------------------
//
// The volume is low (a worker logs per job, not per request) and the failure
// mode of the alternative is precisely the one that costs the most: an
// asynchronous or buffered logger loses the lines written immediately before a
// crash, and those are the only lines anybody wants after a crash. #277's
// memory valve makes that concrete — the process exits deliberately, and the
// sample explaining why must already be on disk.
//
// LOGGING NEVER THROWS. A full disk, a read-only volume, a deleted directory:
// none of them may take a worker down. Every write is wrapped, and a failure is
// dropped rather than propagated — a logger that can kill the process it
// documents is worse than no logger.
//
// -----------------------------------------------------------------------------
// REDACTION IS RECURSIVE, WITH CYCLE AND DEPTH GUARDS
// -----------------------------------------------------------------------------
//
// This is not theoretical hygiene. Engine events carry PRESIGNED URLS, which
// are bearer capabilities over object storage — anybody holding one can read
// (or write) that object until it expires, with no further authentication. A
// log file is a thing people attach to issues. So the sensitive-key pattern is
// applied at every depth, through arrays and nested objects, and a cyclic
// structure (an Error with a `cause` chain that loops, say) must not hang the
// worker while it tries.
// =============================================================================

/**
 * Keys whose values are replaced wholesale.
 *
 * `^pat$` is ANCHORED so `path` and `pattern` survive — both appear constantly
 * in a worker's log lines (temp paths, glob patterns), and redacting them would
 * make the log useless in exactly the situation it exists for. Everything else
 * is a substring match, because the real-world spellings are endless
 * (`apiKey`, `api_key`, `X-Api-Key`, `providerSecret`, `dbPassword`).
 *
 * `password` already covers `PGPASSWORD` (substring, case-insensitive), and
 * `material` is added by #352: it is the exact key `POST /nodes/:id/jobs/:jobId
 * /secret` returns a credential under, so an object logged as
 * `{ secret }`, `{ material }` or `{ credential: response }` is redacted
 * wholesale whatever the broker put inside it. That last property is the point
 * — the material's SHAPE is the broker's business (a DSN today, a token and an
 * endpoint tomorrow), so a rule that only knew about `password` would leak the
 * next broker's spelling.
 */
export const SENSITIVE_KEY =
  /^pat$|token|api[-_]?key|apikey|secret|credential|password|^material$|^pgpassword$/i;

/** What a redacted value becomes. Constant, so it cannot leak a length. */
export const REDACTED = '[redacted]';

/** How deep redaction walks before giving up and summarising. */
const MAX_DEPTH = 8;

/** Roll the log over at this size. One generation is kept. */
export const ROLLOVER_BYTES = 5 * 1024 * 1024;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

/**
 * Replace anything that looks like a credential, at any depth.
 *
 * Also redacts a bare STRING that looks like a signed URL, regardless of its
 * key: a presigned URL logged as `{ url }` would otherwise pass, and `url` is
 * far too common a key to blanket-redact.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return '[max depth]';

  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;

  // The cycle guard. Without it, an object graph with a loop — trivially
  // produced by an Error carrying a `cause` that references it — recurses
  // until the stack blows, inside a logger, on a path that is supposed to be
  // incapable of failing.
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1, seen));

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, depth + 1, seen);
  }
  return out;
}

/**
 * Redact secrets embedded in a string.
 *
 * FOUR shapes, every one of which reaches the log through a MESSAGE rather
 * than through a named field — which is precisely why the key-based rule above
 * cannot catch them:
 *   - a signed URL (any URL carrying a signature-ish query parameter)
 *   - a bare credential with a known prefix (`pat_`, `nod_`)
 *   - `PGPASSWORD=…`, as a spawn error or a pasted command echoes it (#352)
 *   - a `postgres://user:password@host` URI, as libpq echoes one
 */
function redactString(value: string): string {
  let out = value;

  // Presigned URLs. Matched on the QUERY, not the host, because every provider
  // spells the parameters differently but all of them put one there.
  out = out.replace(
    /https?:\/\/[^\s"']*[?&](?:X-Amz-Signature|X-Amz-Credential|Signature|sig|se|sp|sv|token)=[^\s"'&]*[^\s"']*/gi,
    '[redacted-signed-url]',
  );

  // Bearer credentials this application mints. The prefixes are public (they
  // are stored unencrypted as `tokenPrefix`), the remainder is not.
  out = out.replace(/\b(pat|nod)_[A-Za-z0-9._-]{6,}/g, '$1_[redacted]');

  // ⚠ `PGPASSWORD=…` IN A STRING (#352, epic #345). The key-based rule above
  // cannot see this one: it arrives inside a MESSAGE, not a field — a spawn
  // error that echoed the child's environment, a shell command an operator
  // pasted into an issue, a `child_process` error naming the env it failed
  // with. The value ends at whitespace, a quote, a comma or a semicolon,
  // because that is where every one of those spellings ends it.
  out = out.replace(/(PGPASSWORD\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, '$1[redacted]');

  // A PostgreSQL connection URI with credentials in it. This repository never
  // BUILDS one — `pg-job-role.broker.ts` hands over discrete fields precisely
  // so that no password is ever percent-encoded into a URL — but a libpq error
  // message can echo one an operator configured by hand, and it would
  // otherwise sail past every rule above.
  out = out.replace(
    /(postgres(?:ql)?:\/\/[^\s:/@]+):[^\s@]+@/gi,
    '$1:[redacted]@',
  );

  return out;
}

export interface NodeLoggerOptions {
  /** Absolute path of the JSONL file. Its directory is created if missing. */
  path: string;
  /** Also mirror lines here — the foreground `node start` printer. */
  mirror?: ((record: LogRecord) => void) | undefined;
  now?: (() => number) | undefined;
  rolloverBytes?: number | undefined;
}

/**
 * A tiny synchronous JSONL logger.
 *
 * Not pino: this process must run with no runtime dependency beyond what the
 * CLI already ships, the volume does not justify a transport, and the
 * redaction rules above are specific enough that a generic serialiser would
 * need as much configuration as this file is long.
 */
export class NodeLogger {
  private readonly path: string;
  private readonly mirror: ((record: LogRecord) => void) | undefined;
  private readonly now: () => number;
  private readonly rolloverBytes: number;

  constructor(options: NodeLoggerOptions) {
    this.path = options.path;
    this.mirror = options.mirror;
    this.now = options.now ?? Date.now;
    this.rolloverBytes = options.rolloverBytes ?? ROLLOVER_BYTES;
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  /** NEVER THROWS. See the file header. */
  write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    const record: LogRecord = {
      ts: new Date(this.now()).toISOString(),
      level,
      msg: redactString(msg),
      ...((fields === undefined ? {} : (redact(fields) as Record<string, unknown>))),
    };

    try {
      this.mirror?.(record);
    } catch {
      // A broken mirror must not stop the file write, which is the durable half.
    }

    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.rolloverIfNeeded();
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Dropped. A logger that can kill the worker is worse than no logger.
    }
  }

  /** One generation only: `node.log` → `node.log.1`, previous `.1` discarded. */
  private rolloverIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return; // No file yet — nothing to roll.
    }
    if (size < this.rolloverBytes) return;
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // Cannot roll — keep appending rather than losing the line.
    }
  }
}

// -----------------------------------------------------------------------------
// Reading the log back  (`node logs`, and the daemon's per-client replay)
// -----------------------------------------------------------------------------

/**
 * The last `limit` records, oldest first.
 *
 * Reads the whole file rather than seeking backwards, which is correct for a
 * file bounded at 5 MiB by the rollover above and would not be for an unbounded
 * one. A line that does not parse is SKIPPED, not thrown on: a log truncated by
 * a hard kill ends in a partial line, and refusing to show any of it because
 * the last one is half-written is the wrong trade in a diagnostic tool.
 */
export function readLogTail(path: string, limit = 100): LogRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const records: LogRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed) as LogRecord);
    } catch {
      // A partial trailing line from a hard kill.
    }
  }

  return limit > 0 && records.length > limit ? records.slice(-limit) : records;
}

/** Human-readable rendering of one record. Used by `node logs` and the TUI. */
export function formatLogRecord(record: LogRecord): string {
  const { ts, level, msg, ...rest } = record;
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${ts} ${String(level).toUpperCase().padEnd(5)} ${msg}${extra}`;
}
