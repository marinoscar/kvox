// =============================================================================
// ⚠ NO `@Cron` BODY DOES LONG-RUNNING WORK INLINE (issue #353, epic #345)
// =============================================================================
//
// Epic #345 decision 1 says every long-running activity is a queue job. #351
// and #352 moved the database backup, and #353 moved everything else: the
// restore, three cleanup crons that had been deleting rows inline since the
// first week of this repository, two fleet sweeps, and the backup subsystem's
// own housekeeping. This test is what stops that from quietly reverting.
//
// -----------------------------------------------------------------------------
// WHY A STRUCTURAL TEST RATHER THAN A REVIEW CONVENTION
// -----------------------------------------------------------------------------
//
// The regression is invisible from inside the file that causes it. Somebody
// adding a `@Cron` in 2027 writes six lines that delete some rows, and every
// existing test still passes: the deletion works, nothing crashes, and the only
// symptom is that the work is missing from the admin job list, holds no worker
// slot, has no timeout, gets no retry, and answers "did it run last night?"
// with a log grep. That is precisely the class of defect a review catches only
// if the reviewer happens to remember the rule.
//
// So the rule is executable, and the EXEMPTIONS ARE A LIST rather than a
// judgement call: adding a third one means editing this array in a pull request
// that argues for it, which is exactly the conversation that should happen.
//
// -----------------------------------------------------------------------------
// ⚠ WHAT "LONG-RUNNING" MEANS HERE, SO THIS DOES NOT READ AS A LOOPHOLE
// -----------------------------------------------------------------------------
//
// It means WORK WITH A DURATION WORTH ACCOUNTING FOR — a sweep over a table, a
// dump, a network round trip per row, anything that can take minutes or fail in
// a way somebody needs to see. It does NOT mean "every asynchronous call".
// Fire-and-forget notification dispatch (`void this.notifications
// .notifyPermissionHolders(...)`, and the delivery channels behind it) is
// deliberately NOT covered by the rule and is deliberately not on the exemption
// list: a queue row per email buys nothing, and the dispatcher already contracts
// never to reject. See docs/specs/job-queue.md § "All long-running work is a
// job".
//
// -----------------------------------------------------------------------------
// WHAT IT CHECKS, AND WHAT IT HONESTLY CANNOT
// -----------------------------------------------------------------------------
//
// It reads the BODY of every `@Cron`-decorated method under `apps/api/src` and
// requires two things of it: that it queues something, and that it contains
// none of the markers of doing work itself. It does not follow calls into
// helper methods — a cron calling `this.fireDueBackup(...)` is trusted, and
// `fireDueBackup`'s own spec is what pins that it only enqueues. That limit is
// stated rather than hidden: this test is a tripwire on the shape of a cron
// body, not a proof about the whole call graph.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The API's source root, from this file. */
const SRC = join(__dirname, '..', '..', 'src');

/**
 * ⚠ THE EXEMPTION LIST. THREE ENTRIES, AND EACH ONE IS ARGUED.
 *
 * A fourth may be legitimate one day. Adding it means changing this array in a
 * pull request whose description says why the work must NOT be a job — which is
 * the whole reason the list is here rather than in a comment somewhere.
 */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'jobs/tasks/job-stuck-reset.task.ts',
    why:
      'The lease reaper is WHAT RECOVERS ABANDONED JOBS. Recovery that depends on ' +
      'the thing it recovers is not recovery: a queue wedged badly enough to strand ' +
      'a reaper job is exactly the queue that needs reaping.',
  },
  {
    file: 'jobs/tasks/temp-file-janitor.task.ts',
    why:
      'It cleans up after a SIGKILLed worker and sweeps THIS PROCESS\'S LOCAL DISK. ' +
      'A node — or another replica — claiming that job would sweep the wrong ' +
      'filesystem and leave the full one untouched.',
  },
  {
    file: 'nodes/tasks/node-secret-sweep.task.ts',
    why:
      'It destroys the short-lived PostgreSQL roles brokered to worker nodes (#349), ' +
      'and its own header lists three cases the event path structurally cannot cover ' +
      '— the first of which is "a job settled by the reaper". Making credential ' +
      'revocation depend on the queue means a wedged queue leaks live database ' +
      'credentials for as long as it stays wedged. Same argument as the reaper, ' +
      'applied to a security control rather than to recovery.',
  },
];

/**
 * Markers of a cron doing the work itself.
 *
 * Deliberately concrete rather than clever: these are the exact shapes the
 * seven converted crons used to contain, so a revert reintroduces one of them
 * almost by definition.
 */
const WORK_MARKERS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\.deleteMany\(/, what: 'a bulk delete' },
  { pattern: /\.updateMany(AndReturn)?\(/, what: 'a bulk update' },
  { pattern: /\.\$executeRaw/, what: 'raw SQL' },
  { pattern: /withAdminConnection\(/, what: 'a cluster admin connection' },
  { pattern: /\bcleanupExpired\w*\(/, what: 'an inline cleanup call' },
  { pattern: /\.prune\(\)/, what: 'an inline retention prune' },
  { pattern: /\bdropExpired\w*\(/, what: 'an inline DROP DATABASE sweep' },
  { pattern: /\bthis\.sweep\(/, what: 'an inline sweep' },
  { pattern: /\bthis\.releaseStaleRuns\(/, what: 'an inline stale release' },
  { pattern: /\bthis\.storage(Provider)?\./, what: 'a direct storage-provider call' },
];

/** Every `.ts` file under `dir`, excluding tests. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) return [];

    return [full];
  });
}

/**
 * The body of every `@Cron`-decorated method in `source`, brace-matched.
 *
 * Brace matching rather than a regex over the whole method: a cron body
 * contains braces (template literals, object arguments, nested blocks), and a
 * lazy match would stop at the first `}` and declare every task compliant.
 */
function cronBodies(source: string): string[] {
  const bodies: string[] = [];
  let index = source.indexOf('@Cron(');

  while (index !== -1) {
    const open = source.indexOf('{', index);

    if (open === -1) break;

    let depth = 0;
    let end = open;

    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    bodies.push(source.slice(open, end + 1));
    index = source.indexOf('@Cron(', end);
  }

  return bodies;
}

const files = sourceFiles(SRC)
  .map((file) => ({ path: file, rel: relative(SRC, file).split('\\').join('/') }))
  .map((file) => ({ ...file, source: readFileSync(file.path, 'utf8') }))
  .filter((file) => file.source.includes('@Cron('));

const exemptFiles = new Set(EXEMPT.map((entry) => entry.file));

describe('every @Cron enqueues rather than working', () => {
  it('finds the crons at all, so a broken scan cannot pass vacuously', () => {
    // The failure this guards: a refactor moves the tasks, `sourceFiles` finds
    // nothing, and every case below passes over an empty list.
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(EXEMPT.map((entry) => [entry.file, entry.why] as const))(
    'exempts %s, on the record',
    (file, why) => {
      // The exemption is only real if the file is: a stale entry here would
      // silently exempt nothing while looking like it exempted something.
      expect(files.map((candidate) => candidate.rel)).toContain(file);
      expect(why.length).toBeGreaterThan(40);
    }
  );

  it('queues its work instead of doing it, in every non-exempt cron', () => {
    const offenders: string[] = [];

    for (const file of files) {
      if (exemptFiles.has(file.rel)) continue;

      for (const body of cronBodies(file.source)) {
        if (!/enqueueHousekeepingJob\(|\.enqueue\(/.test(body)) {
          offenders.push(`${file.rel}: a @Cron body that queues nothing`);
        }

        for (const marker of WORK_MARKERS) {
          if (marker.pattern.test(body)) {
            offenders.push(`${file.rel}: a @Cron body containing ${marker.what}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
