import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import type { PgSpawnFn } from '../../src/db-backup/pg-dump.util';

// =============================================================================
// A fake `pg_*` child process (issue #280, epic #254)
// =============================================================================
//
// The whole `db-backup` unit suite runs against this and NEVER against a real
// binary. That is the reason `spawnPgProcess` takes a `spawnFn` at all: a
// suite that needs `pg_dump` installed is a suite that is skipped on the
// runner where it would have caught something, and a skipped test guards
// nothing. It is also the only way to exercise the paths that matter most -
// a timeout, a SIGKILL, an ENOENT, a `close` arriving after a kill - since
// none of those can be provoked reliably from a real process.
//
// The fake is an EventEmitter with the three streams a child has, so the code
// under test cannot tell it apart from `child_process.spawn`'s return value by
// anything it does.
// =============================================================================

/** One recorded spawn: everything the caller passed, kept for assertions. */
export interface RecordedSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdio: ('pipe' | 'ignore')[];
  child: FakeChildProcess;
}

/**
 * The fake child.
 *
 * `kill` RECORDS the signal instead of sending one, which is what lets a test
 * assert that a timeout used SIGKILL rather than SIGTERM - the distinction the
 * real implementation exists to get right, and one that is invisible from the
 * outside otherwise.
 */
export class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly killSignals: (NodeJS.Signals | number)[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal ?? 'SIGTERM');
    return true;
  }

  /** Emits a normal termination. */
  close(code: number, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }

  /**
   * Emits a spawn failure (ENOENT and friends).
   *
   * The streams are ended too, because node destroys a failed child's stdio -
   * and a consumer iterating stdout would otherwise wait forever for an `end`
   * that a real failure would have delivered. Guarded, so a `fail` after a
   * `close` (the "post-kill events are no-ops" case) does not end an
   * already-finished stream, which throws rather than being ignored.
   */
  fail(error: Error): void {
    if (!this.stdout.writableEnded) this.stdout.end();
    if (!this.stderr.writableEnded) this.stderr.end();
    this.emit('error', error);
  }

  /** Writes to the child's stderr, as `pg_dump` does for warnings and errors. */
  writeStderr(text: string): void {
    this.stderr.write(text);
  }

  /** Writes to the child's stdout - the archive, or a `--list` listing. */
  writeStdout(text: string): void {
    this.stdout.write(text);
  }

  /**
   * Scripts the child's whole life, ONE TICK LATER.
   *
   * The delay is not cosmetic. `createFakeSpawn`'s hook runs INSIDE `spawnFn`,
   * which is before `spawnPgProcess` has attached its own `close` listener - a
   * `close` emitted there is emitted into an empty room, and the promise it
   * was meant to settle never settles. Deferring by one tick puts the events
   * where a real child's would be: after the caller finished wiring up.
   */
  respondLater(stdout: string, code = 0): void {
    setImmediate(() => {
      if (stdout !== '') this.writeStdout(stdout);
      this.close(code);
    });
  }
}

export interface FakeSpawn {
  /** Pass as `spawnFn`. */
  fn: PgSpawnFn;
  /** Every spawn, in order. */
  calls: RecordedSpawn[];
  /** The most recent spawn; throws when nothing has been spawned yet. */
  last(): RecordedSpawn;
}

/**
 * Builds a `spawnFn` that returns fake children.
 *
 * @param onSpawn optional hook run with each new child, so a test can script
 * its output (`child.writeStdout(...); child.close(0)`) at the moment it is
 * created rather than having to reach for it afterwards.
 */
export function createFakeSpawn(onSpawn?: (spawn: RecordedSpawn) => void): FakeSpawn {
  const calls: RecordedSpawn[] = [];

  const fn: PgSpawnFn = (command, args, options) => {
    const child = new FakeChildProcess();
    const record: RecordedSpawn = {
      command,
      args: [...args],
      env: options.env,
      stdio: options.stdio,
      child,
    };

    calls.push(record);
    onSpawn?.(record);

    // The structural cast is the point of the seam: `ChildProcess` carries a
    // large surface (pid, exitCode, ref/unref, the full stdio tuple) that this
    // module never touches, and implementing all of it would make the fake
    // harder to read than the code it tests.
    return child as unknown as ChildProcess;
  };

  return {
    fn,
    calls,
    last(): RecordedSpawn {
      const record = calls[calls.length - 1];
      if (record === undefined) throw new Error('No process was spawned');
      return record;
    },
  };
}

/** Drains a stream to a string - used to prove stdout was passed through untouched. */
export async function collect(stream: Readable): Promise<string> {
  let output = '';
  for await (const chunk of stream) output += String(chunk);
  return output;
}
