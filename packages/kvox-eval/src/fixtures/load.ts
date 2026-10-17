// Loading the golden set (issue #362): every `*.json` in a directory, parsed
// through `goldenFixtureSchema`, sorted by id. A malformed file throws with its
// name — a fixture that does not parse is never silently skipped.
//
// #580: the set ships inside `@marinoscar/kvox-eval` (`fixtures/kg-golden/`),
// resolved against the package root, so the same path works from `dist/` and
// from `src/` under ts-jest.

import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import { goldenFixtureSchema, type GoldenFixture } from './fixture-schema.js';

/** `src/fixtures` and `dist/fixtures` both sit two levels below the package root. */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

/**
 * The committed, synthetic golden set's directory (`fixtures/kg-golden/` of the package).
 *
 * @stability experimental
 */
export const GOLDEN_SET_DIR = join(PACKAGE_ROOT, 'fixtures', 'kg-golden');

/**
 * The committed, synthetic meetings (`fixtures/kg-golden/meetings/`).
 *
 * @stability experimental
 */
export const GOLDEN_MEETINGS_DIR = join(GOLDEN_SET_DIR, 'meetings');

/**
 * A golden set (or a selection of it) that cannot be loaded: a file that is not
 * JSON or does not match its schema, a duplicate id, an unknown id. The CLIs map
 * it to exit code 2.
 *
 * @stability experimental
 */
export class KgEvalLoadError extends Error {}

/**
 * Every `*.json` file of a directory, sorted by name.
 *
 * @param dir - the directory.
 * @returns absolute paths.
 * @stability experimental
 */
export function listFixtureFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * One fixture file, parsed and validated.
 *
 * @param file - the file.
 * @returns the fixture.
 * @throws {@link KgEvalLoadError} when it is not JSON or does not match `goldenFixtureSchema`.
 * @stability experimental
 */
export function loadFixtureFile(file: string): GoldenFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new KgEvalLoadError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  const parsed = goldenFixtureSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new KgEvalLoadError(`${file}: does not match goldenFixtureSchema — ${issues}`);
  }
  return parsed.data;
}

/**
 * Every fixture of a directory, sorted by id (numerically: m2 before m10).
 *
 * @param dir - the directory; default the committed {@link GOLDEN_MEETINGS_DIR}.
 * @returns the fixtures.
 * @throws {@link KgEvalLoadError} on a malformed file or a duplicate id.
 * @stability experimental
 */
export function loadGoldenSet(dir: string = GOLDEN_MEETINGS_DIR): GoldenFixture[] {
  const fixtures = listFixtureFiles(dir).map(loadFixtureFile);
  const seen = new Set<string>();
  for (const f of fixtures) {
    if (seen.has(f.id)) throw new KgEvalLoadError(`${dir}: fixture id ${f.id} appears twice`);
    seen.add(f.id);
  }
  return fixtures.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/**
 * `--only m01,m07` / `--tag promotion`: both narrow; neither given keeps all.
 *
 * @param fixtures - the loaded set.
 * @param only - fixture ids to keep, or `null`.
 * @param tag - a tag every kept fixture carries, or `null`.
 * @returns the selection, in set order.
 * @throws {@link KgEvalLoadError} when `only` names an id the set does not have.
 * @stability experimental
 */
export function selectFixtures(
  fixtures: GoldenFixture[],
  only: string[] | null,
  tag: string | null,
): GoldenFixture[] {
  let out = fixtures;
  if (only && only.length > 0) {
    const unknown = only.filter((id) => !fixtures.some((f) => f.id === id));
    if (unknown.length > 0) throw new KgEvalLoadError(`unknown fixture id(s): ${unknown.join(', ')}`);
    out = out.filter((f) => only.includes(f.id));
  }
  if (tag) out = out.filter((f) => f.tags.includes(tag));
  return out;
}

/**
 * The committed golden meetings, optionally narrowed to some ids.
 *
 * @example
 * ```ts
 * const [m01, m07] = loadGoldenMeetings(['m01', 'm07']);
 * ```
 *
 * @param ids - fixture ids to keep (in set order); omitted or empty keeps all.
 * @returns the fixtures.
 * @throws {@link KgEvalLoadError} on a malformed file or an unknown id.
 * @stability experimental
 */
export function loadGoldenMeetings(ids?: readonly string[]): GoldenFixture[] {
  return selectFixtures(loadGoldenSet(GOLDEN_MEETINGS_DIR), ids && ids.length > 0 ? [...ids] : null, null);
}
