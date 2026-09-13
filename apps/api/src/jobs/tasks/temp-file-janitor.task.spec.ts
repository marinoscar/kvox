// =============================================================================
// Unit tests for the temp-file janitor (issue #263, epic #254)
// =============================================================================
//
// RUN AGAINST A REAL FILESYSTEM, in a disposable directory `os.tmpdir` is
// pointed at for the duration of the suite. Mocking `fs` here would prove
// nothing worth proving: the acceptance criterion is that the janitor removes
// an aged prefixed file while leaving a fresh one AND an unrelated one alone,
// and that is a statement about which files still exist afterwards — the one
// question a mocked `fs.rm` cannot answer.
//
// The unrelated-file case is the important one. `/tmp` is shared with the
// operating system, the package manager and every other process on the box; a
// sweeper that deleted "old files in /tmp" would eventually delete something
// that mattered to someone else, and the prefix is the only thing standing
// between this task and that.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TempFileJanitorTask } from './temp-file-janitor.task';
import * as jobTemp from '../job-temp';
import { JOB_TEMP_PREFIX } from '../job-temp';
import type { ConfigService } from '@nestjs/config';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Ages a path by rewriting its mtime — the signal the janitor reads. */
async function ageBy(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await fs.utimes(path, when, when);
}

describe('TempFileJanitorTask', () => {
  let dir: string;
  let dirSpy: jest.SpyInstance;

  const makeTask = (mode: string | undefined = 'all') =>
    new TempFileJanitorTask({ get: () => mode } as unknown as ConfigService);

  /** A prefixed path inside the disposable directory, as `jobTempPath` builds. */
  const tempPath = (suffix = ''): string => join(dir, `${JOB_TEMP_PREFIX}${randomUUID()}${suffix}`);

  /**
   * The sweep is pointed at a disposable directory of our own — never the
   * machine's real `/tmp`, which is shared with everything else on the box
   * (including, on a developer's laptop, another checkout of this repository
   * running this very suite).
   *
   * The redirection is a spy on `jobTempDir` rather than the `TMPDIR`
   * environment variable, because `os.tmpdir()` reads the REAL process
   * environment while a Jest test file writes to a sandboxed copy of it —
   * setting `TMPDIR` here would silently do nothing and the suite would be
   * sweeping `/tmp` for real.
   */
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'janitor-spec-'));
    dirSpy = jest.spyOn(jobTemp, 'jobTempDir').mockReturnValue(dir);
  });

  afterEach(async () => {
    dirSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('removes an aged prefixed file and leaves a fresh one and an unrelated one alone', async () => {
    const aged = tempPath('.partial');
    const fresh = tempPath('.partial');
    const unrelated = join(dir, 'systemd-private-something');

    await fs.writeFile(aged, 'abandoned by a worker that was killed');
    await fs.writeFile(fresh, 'still being written right now');
    await fs.writeFile(unrelated, 'belongs to somebody else entirely');

    await ageBy(aged, SIX_HOURS_MS + 60_000);
    // The unrelated file is aged too, so the ONLY thing saving it is the
    // prefix test.
    await ageBy(unrelated, 30 * 24 * 60 * 60 * 1000);

    const result = await makeTask().sweep();

    expect(result).toEqual({ removed: 1, kept: 1 });
    await expect(fs.access(aged)).rejects.toThrow();
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(unrelated)).resolves.toBeUndefined();
  });

  it('keeps a prefixed file that is younger than the age limit', async () => {
    const recent = tempPath();
    await fs.writeFile(recent, 'a long download, still in progress');
    await ageBy(recent, SIX_HOURS_MS - 60_000);

    await expect(makeTask().sweep()).resolves.toEqual({ removed: 0, kept: 1 });
    await expect(fs.access(recent)).resolves.toBeUndefined();
  });

  it('removes an aged prefixed directory, not just files', async () => {
    const scratch = tempPath('-workdir');
    await fs.mkdir(scratch);
    await fs.writeFile(join(scratch, 'page-1.png'), 'x');
    await ageBy(scratch, SIX_HOURS_MS + 60_000);

    await expect(makeTask().sweep()).resolves.toEqual({ removed: 1, kept: 0 });
    await expect(fs.access(scratch)).rejects.toThrow();
  });

  it('sweeps nothing when the worker mode is off', async () => {
    // A process that runs no handlers has created no temp files, so anything
    // prefixed on that host belongs to some OTHER process that does the work.
    const aged = tempPath();
    await fs.writeFile(aged, 'not ours to delete');
    await ageBy(aged, SIX_HOURS_MS * 10);

    await expect(makeTask('off').sweep()).resolves.toEqual({ removed: 0, kept: 0 });
    await expect(fs.access(aged)).resolves.toBeUndefined();
  });

  it('sweeps in both modes that actually run jobs, and when the mode is unset', async () => {
    for (const mode of ['all', 'system', undefined]) {
      const aged = tempPath();
      await fs.writeFile(aged, 'abandoned');
      await ageBy(aged, SIX_HOURS_MS + 1000);

      await expect(makeTask(mode).sweep()).resolves.toMatchObject({ removed: 1 });
    }
  });

  it('sweeps on module init, because a killed process is usually restarted', async () => {
    const aged = tempPath();
    await fs.writeFile(aged, 'leaked by the previous life of this container');
    await ageBy(aged, SIX_HOURS_MS + 1000);

    await makeTask().onModuleInit();

    await expect(fs.access(aged)).rejects.toThrow();
  });

  it('survives a temp directory that cannot be listed', async () => {
    dirSpy.mockReturnValue(join(dir, 'does-not-exist'));

    await expect(makeTask().sweep()).resolves.toEqual({ removed: 0, kept: 0 });
  });

  it('keeps going when one entry cannot be removed', async () => {
    // Per-file errors are swallowed: one unreadable entry must not stop the
    // sweep of the hundreds behind it.
    const good = tempPath();
    const bad = tempPath();

    await fs.writeFile(good, 'removable');
    await fs.writeFile(bad, 'not removable today');
    await ageBy(good, SIX_HOURS_MS + 1000);
    await ageBy(bad, SIX_HOURS_MS + 1000);

    // The real implementation is captured BEFORE the spy replaces it, so the
    // other file is still genuinely removed and the assertion below is about
    // the filesystem rather than about the mock.
    const realRm = fs.rm.bind(fs);
    const rm = jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === bad) {
        throw new Error('EPERM');
      }

      return realRm(target, options);
    });

    try {
      await expect(makeTask().sweep()).resolves.toEqual({ removed: 1, kept: 0 });
      await expect(fs.access(good)).rejects.toThrow();
    } finally {
      rm.mockRestore();
    }
  });

  it('never considers a file without the prefix, however old', async () => {
    const ancient = join(dir, 'important.sock');
    await fs.writeFile(ancient, 'someone else’s');
    await ageBy(ancient, 365 * 24 * 60 * 60 * 1000);

    await expect(makeTask().sweep()).resolves.toEqual({ removed: 0, kept: 0 });
    await expect(fs.access(ancient)).resolves.toBeUndefined();
  });

  it('uses a non-empty prefix, so startsWith can never match everything', async () => {
    // The safety property `job-temp.ts` falls back for: an empty prefix would
    // turn this task into an indiscriminate `/tmp` sweeper.
    expect(JOB_TEMP_PREFIX.length).toBeGreaterThan(0);
    expect(JOB_TEMP_PREFIX.endsWith('-')).toBe(true);
  });
});
