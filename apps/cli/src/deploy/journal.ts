import { appendFileSync, mkdirSync, openSync, closeSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandResult } from './executor.js';

// =============================================================================
// The run journal  (issue #173, epic #168)
// =============================================================================
//
// "Keep a detailed log for troubleshooting" is a headline requirement of this
// epic, and the whole point is that the log OUTLIVES THE TERMINAL SESSION. An
// install runs over SSH, takes minutes, and the person diagnosing it later is
// usually not the person who ran it.
//
// Two files per run, because they have two different readers:
//
//   <command>-<timestamp>.log    a human reading it over SSH
//   <command>-<timestamp>.jsonl  a program, and `appctl deploy status --json`
//
// REDACTION IS THE SECURITY-CRITICAL PART AND IT IS STRUCTURAL. These logs are
// written to be pasted into bug reports; that is their purpose. So every
// string written goes through a redactor seeded with the secret VALUES the
// wizard collected. Nothing here is trusted to remember to redact at the call
// site, because the one call site that forgets is the one that leaks.
//
// A JOURNAL NEVER THROWS INTO THE DEPLOY. A log directory that cannot be
// written is a nuisance; a deployment aborted because of one is a bug. Every
// write is guarded and degrades to a single warning on stderr.
// =============================================================================

/** Runs kept on disk. Older pairs are deleted, matching the scripts replaced. */
const DEFAULT_RETAIN_RUNS = 10;

/**
 * Values shorter than this are never redacted.
 *
 * Redacting a two-character password would replace every occurrence of those
 * two characters in the entire log and destroy it - which both hides the
 * failure being diagnosed and, by mangling everything, makes it obvious that
 * something is wrong without saying what. A secret this short is a much bigger
 * problem than its appearance in a log.
 */
const MIN_REDACTABLE_LENGTH = 5;

export interface SecretEntry {
  /** The variable name, used in the marker so the log stays diagnosable. */
  key: string;
  value: string;
}

export type Redactor = (value: string) => string;

/**
 * Builds the redactor.
 *
 * LONGEST VALUE FIRST, deliberately. Secrets overlap - a password can be a
 * substring of a connection string that is itself a secret - and replacing the
 * short one first leaves the tail of the long one in the clear.
 *
 * A consequence worth knowing about: a password of `postgres` also matches
 * inside the word `postgresql`, so a URL scheme can come out mangled. That is
 * the correct trade. A log that is ugly is recoverable; a log that leaked a
 * credential is not.
 */
export function createRedactor(secrets: readonly SecretEntry[]): Redactor {
  const entries = secrets
    .filter((entry) => entry.value.length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => b.value.length - a.value.length);

  if (entries.length === 0) {
    return (value) => value;
  }

  return (value: string): string => {
    let result = value;
    for (const entry of entries) {
      if (result.includes(entry.value)) {
        result = result.split(entry.value).join(`***REDACTED:${entry.key}***`);
      }
    }
    return result;
  };
}

export interface Journal {
  /** Marks the start of a named step. */
  step(id: string, title: string): void;
  /** A free-text line: progress, a note, a warning. */
  line(text: string): void;
  /** Records a command with its argv, cwd, exit code, duration and output. */
  command(result: CommandResult): void;
  /** Closes the run. Safe to call twice; the second call does nothing. */
  finish(outcome: 'success' | 'failure', summary?: string): void;
  /** The human log's path, for the "see the log" line on failure. */
  readonly path: string;
  /** Seeded with this run's secrets; hand it to `runCommand`. */
  readonly redact: Redactor;
}

export interface OpenJournalOptions {
  deployRoot: string;
  /** `install`, `update`, `doctor`, `status`. Appears in the filename. */
  command: string;
  secrets?: readonly SecretEntry[] | undefined;
  retainRuns?: number | undefined;
  now?: (() => Date) | undefined;
  /** Where the degraded-mode warning goes. Defaults to process.stderr. */
  warnStream?: { write(chunk: string): unknown } | undefined;
}

/** Filesystem-safe, sorts chronologically as a string. */
export function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

export function openJournal(options: OpenJournalOptions): Journal {
  const now = options.now ?? (() => new Date());
  const redact = createRedactor(options.secrets ?? []);
  const warnStream = options.warnStream ?? process.stderr;

  const logsDir = join(options.deployRoot, 'logs');
  const slug = timestampSlug(now());
  const base = `appctl-${options.command}-${slug}`;
  const logPath = join(logsDir, `${base}.log`);
  const jsonlPath = join(logsDir, `${base}.jsonl`);

  let degraded = false;
  let finished = false;
  const startedAt = Date.now();

  /** One warning per run, not one per line. */
  function degrade(error: unknown): void {
    if (degraded) return;
    degraded = true;
    const reason = error instanceof Error ? error.message : String(error);
    warnStream.write(
      `warning: deploy log unavailable (${reason}); continuing without one\n`,
    );
  }

  try {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    // Create both files 0600 BEFORE anything is appended. appendFileSync's
    // `mode` applies only when it creates the file, and relying on that leaves
    // the permissions to whichever call happens to be first.
    for (const path of [logPath, jsonlPath]) {
      closeSync(openSync(path, 'a', 0o600));
    }
    pruneOldRuns(logsDir, options.retainRuns ?? DEFAULT_RETAIN_RUNS);
  } catch (error) {
    degrade(error);
  }

  function write(path: string, text: string): void {
    if (degraded) return;
    try {
      // Appended synchronously and unbuffered. A crashed deploy is exactly
      // when the log matters, so holding lines in memory defeats the purpose.
      appendFileSync(path, text, { mode: 0o600 });
    } catch (error) {
      degrade(error);
    }
  }

  function event(type: string, fields: Record<string, unknown>): void {
    write(
      jsonlPath,
      redact(JSON.stringify({ ts: now().toISOString(), type, ...fields })) + '\n',
    );
  }

  function human(text: string): void {
    write(logPath, redact(text) + '\n');
  }

  human(`=== appctl deploy ${options.command} - ${now().toISOString()} ===`);
  event('run.start', { command: options.command, deployRoot: options.deployRoot });

  return {
    path: logPath,
    redact,

    step(id: string, title: string): void {
      human('');
      human(`--- ${title} [${id}] ---`);
      event('step.start', { id, title });
    },

    line(text: string): void {
      human(text);
      event('line', { text: redact(text) });
    },

    command(result: CommandResult): void {
      const rendered = result.argv.join(' ');
      human(`$ ${rendered}`);
      human(`  cwd=${result.cwd} exit=${result.exitCode} ${result.durationMs}ms`);
      if (result.stdout !== '') human(indent(result.stdout));
      if (result.stderr !== '') human(indent(result.stderr));

      event('command', {
        argv: result.argv,
        cwd: result.cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },

    finish(outcome: 'success' | 'failure', summary?: string): void {
      if (finished) return;
      finished = true;
      const durationMs = Date.now() - startedAt;
      human('');
      human(`=== ${outcome} in ${durationMs}ms ===`);
      if (summary !== undefined) human(summary);
      event('run.finish', { outcome, durationMs, ...(summary === undefined ? {} : { summary }) });
    },
  };
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `  | ${line}`)
    .join('\n');
}

/**
 * Deletes all but the newest `retain` runs.
 *
 * The .log and its .jsonl are deleted TOGETHER, keyed on the shared base name.
 * Pruning them independently would leave a machine-readable half with no human
 * half to read beside it, which is the pair you actually want when diagnosing.
 */
export function pruneOldRuns(logsDir: string, retain: number): void {
  if (retain <= 0) return;

  const bases = new Set<string>();
  for (const name of readdirSync(logsDir)) {
    const match = /^(appctl-.+?)\.(log|jsonl)$/.exec(name);
    if (match?.[1] !== undefined) bases.add(match[1]);
  }

  // The timestamp is ISO-8601 with separators replaced, so it sorts
  // chronologically as text and needs no parsing or stat() call.
  const ordered = [...bases].sort();
  for (const base of ordered.slice(0, Math.max(0, ordered.length - retain))) {
    for (const extension of ['log', 'jsonl']) {
      try {
        unlinkSync(join(logsDir, `${base}.${extension}`));
      } catch {
        // Already gone, or not ours to delete. Retention is housekeeping, not
        // a correctness requirement, so a failure here is not worth reporting.
      }
    }
  }
}
