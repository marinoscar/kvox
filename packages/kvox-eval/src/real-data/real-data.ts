// =============================================================================
// The real-data path guard (issue #362; moved into the package by #580).
//
// Real meetings are private conversations — there is no `transcripts:read_any`
// for exactly that reason — so nothing from a run over them may ever land
// inside the repository. The one security control is `assertOutsideRepo`:
// every path a real-data run writes to or reads a real set from is resolved
// (symlinks included) and refused when it falls inside the git work tree. The
// single exception is a scratch directory the CALLER names (`allowInside`;
// the web app passes its git-ignored `apps/api/.kg-eval/`), and only for runs
// over the committed SYNTHETIC set.
//
// PURE of the database: exporting a real note as a skeleton reads the app's
// own tables and stays in the app (`apps/api/scripts/kg-eval/real-data.ts`).
// =============================================================================

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';

/**
 * The refusal every real-data path guard prints (exit code 3).
 *
 * @stability experimental
 */
export const REAL_DATA_REFUSAL = 'real meeting data must never be written inside the repository';

/**
 * A real-data path inside the repository: refused, exit code 3.
 *
 * @stability experimental
 */
export class RealDataPathError extends Error {
  /**
   * @param path - the refused path, canonicalized.
   */
  constructor(readonly path: string) {
    super(`${REAL_DATA_REFUSAL}: ${path}`);
  }
}

/**
 * Absolute, with symlinks resolved on the longest prefix that exists.
 *
 * @param p - a path, relative to the working directory or absolute.
 * @returns the canonical path.
 * @stability experimental
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync(existing);
  } catch {
    // keep the unresolved prefix
  }
  return rest.length > 0 ? join(real, ...rest) : real;
}

/**
 * Whether `child` is `parent` or below it (both already canonical).
 *
 * @param child - the candidate path.
 * @param parent - the directory.
 * @returns `true` when inside.
 * @stability experimental
 */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The repository root(s): git's answer from this file's folder and from the
 * working directory, plus the package's own grandparent as a fallback (the
 * monorepo root when the package is not installed from the registry).
 *
 * @returns canonical roots, deduplicated.
 * @stability experimental
 */
export function repositoryRoots(): string[] {
  const roots = new Set<string>();
  // src/real-data (or dist/real-data) → package → packages → <root>
  roots.add(canonicalPath(resolve(__dirname, '..', '..', '..', '..')));
  for (const cwd of [__dirname, process.cwd()]) {
    try {
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (top) roots.add(canonicalPath(top));
    } catch {
      // Not a git checkout (or no git binary): the fallback above still applies.
    }
  }
  return [...roots];
}

/**
 * What {@link assertOutsideRepo} may let through.
 *
 * @stability experimental
 */
export interface AssertOutsideRepoOptions {
  /**
   * A directory inside the repository a path may still be under: the caller's
   * git-ignored scratch directory. Pass it ONLY for output of a run over the
   * committed synthetic set.
   */
  allowInside?: string | null;
}

/**
 * Refuses a path inside the repository (symlinks resolved).
 *
 * @param p - the path a real-data run would read or write.
 * @param opts - the one directory that may be let through.
 * @returns the canonical path.
 * @throws {@link RealDataPathError} when it is inside the repository.
 * @stability experimental
 */
export function assertOutsideRepo(p: string, opts: AssertOutsideRepoOptions = {}): string {
  const abs = canonicalPath(p);
  if (opts.allowInside && isInside(abs, canonicalPath(opts.allowInside))) return abs;
  for (const root of repositoryRoots()) {
    if (isInside(abs, root)) throw new RealDataPathError(abs);
  }
  return abs;
}

/**
 * The next free `m9NN` id in a real directory (real ids never collide with the
 * committed m01…).
 *
 * @param realDir - the developer's real-data directory.
 * @returns an id such as `m901`.
 * @stability experimental
 */
export function nextRealFixtureId(realDir: string): string {
  const used = new Set<number>();
  if (existsSync(realDir)) {
    for (const f of readdirSync(realDir)) {
      const m = /^m(\d{2,3})/.exec(f);
      if (m) used.add(Number(m[1]));
    }
  }
  let n = 901;
  while (used.has(n)) n += 1;
  return `m${n}`;
}
