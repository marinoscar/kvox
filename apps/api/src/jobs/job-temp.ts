// =============================================================================
// Temp files a job handler creates (issue #263, epic #254)
// =============================================================================
//
// A handler that downloads a file, renders a document, shells out to a
// converter or streams an object through a transform writes it somewhere
// first, and `os.tmpdir()` is where. That is fine right up until the worker is
// SIGKILLed mid-download — an OOM kill, a container replaced by a rolling
// deploy, a node whose lid closed — at which point NO `finally` block runs,
// and the partial file stays on disk forever. The next kill leaves another.
// On a long-lived host with a small `/tmp`, the eventual failure is not "a job
// failed": it is every write on the machine failing at once, for a reason that
// looks nothing like the job queue.
//
// This file is one half of the fix — the NAMING half. `TempFileJanitorTask` is
// the other, and it can only work if it can tell OUR abandoned files from
// everybody else's: `/tmp` is shared with the operating system, the package
// manager, the language runtime and any other process on the box, and a
// sweeper that deleted "old files in /tmp" would eventually delete something
// that mattered to someone else. So every temp file this application creates
// carries a prefix, and the janitor removes ONLY files that carry it.
//
// -----------------------------------------------------------------------------
// THE PREFIX IS DERIVED FROM `APP_NAME`, NOT WRITTEN OUT
// -----------------------------------------------------------------------------
//
// This repository is a template: nothing in it may hard-code an application,
// product or repository name, and `packages/shared`'s `APP_NAME` is the one
// line a fork edits to rebrand. Slugifying it here means the prefix rebrands
// with everything else, and — the reason that actually matters — two
// applications built from this template running on the SAME host get DIFFERENT
// prefixes, so neither janitor can ever delete the other's in-flight temp
// files. A fixed literal (`app-job-`) would have made that collision silent
// and data-losing.
//
// The one cost is honest and small: renaming the application orphans temp
// files written under the old name. They are files in `/tmp` with nothing
// referring to them, left to the operating system's own reaping (systemd's
// `tmpfiles.d` clears `/tmp` on a schedule and every reboot), and the window
// is a single deploy. A janitor that also swept "whatever the prefix used to
// be" would need a list of former names — a second thing to keep in sync, to
// solve a problem that resolves itself.
//
// `slugify` falls back to a NEUTRAL constant rather than to an empty prefix,
// because an empty prefix would make `startsWith('')` true for every file in
// `/tmp` and turn the janitor into exactly the indiscriminate sweeper the
// paragraph above rejects. That fallback is a safety property, not a
// nicety — see the test.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APP_NAME } from '@app/shared';

/**
 * What the prefix degrades to when `APP_NAME` slugifies to nothing (all
 * punctuation, all non-Latin script, empty).
 *
 * Deliberately generic and carrying no product name — it is a description of
 * WHAT the file is, not of WHOSE it is.
 */
const NEUTRAL_PREFIX_SLUG = 'app';

/**
 * A display name to a filename-safe slug (`'Some Name'` → `'some-name'`);
 * anything that reduces to nothing falls back to the neutral slug above.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : NEUTRAL_PREFIX_SLUG;
}

/**
 * The prefix EVERY temp file created by a job handler must carry.
 *
 * Computed once at import time — `APP_NAME` is a build-time constant, so
 * recomputing it per call would buy nothing.
 *
 * Import this rather than writing your own scratch-file name: a file without
 * this prefix is a file the janitor will never clean up, and one whose
 * abandoned copies accumulate for the life of the host.
 */
export const JOB_TEMP_PREFIX = `${slugify(APP_NAME)}-job-`;

/**
 * The directory temp files live in, read on EVERY call rather than captured in
 * a constant.
 *
 * `os.tmpdir()` reads `TMPDIR`/`TEMP` at call time, so a process whose
 * environment changes is honoured instead of silently ignored, and it is one
 * `process.env` lookup either way.
 *
 * It is also the seam the janitor's suite redirects — by stubbing THIS
 * function, not the environment: a Jest test file writes to a sandboxed copy
 * of `process.env`, so setting `TMPDIR` there would silently do nothing and
 * the suite would sweep the machine's real `/tmp`.
 */
export function jobTempDir(): string {
  return tmpdir();
}

/**
 * An absolute path for a new scratch file, prefixed and collision-free.
 *
 * ⚠ IT CREATES NOTHING. It returns a path; the caller writes the file, and the
 * caller deletes it when the work succeeds. The janitor is the safety net for
 * the case where the caller never gets the chance — not a substitute for
 * cleaning up after yourself, because it deliberately leaves anything younger
 * than six hours alone.
 *
 * @param suffix an optional trailing part (`'.pdf'`, `'-page-2.png'`), for
 * tools that insist on a real extension.
 */
export function jobTempPath(suffix = ''): string {
  return join(jobTempDir(), `${JOB_TEMP_PREFIX}${randomUUID()}${suffix}`);
}
