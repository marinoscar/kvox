// Loading the golden set (issue #362): every `*.json` in a directory, parsed
// through `goldenFixtureSchema`, sorted by id. A malformed file throws with its
// name — a fixture that does not parse is never silently skipped.

import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import { goldenFixtureSchema, type GoldenFixture } from './fixture-schema';
import { kgEvalPredictionSchema, type KgEvalPrediction } from './prediction-schema';

/** The committed, synthetic set. */
export const GOLDEN_MEETINGS_DIR = resolve(__dirname, '../../test/fixtures/kg-golden/meetings');

export class KgEvalLoadError extends Error {}

export function listFixtureFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f));
}

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

export function loadGoldenSet(dir: string = GOLDEN_MEETINGS_DIR): GoldenFixture[] {
  const fixtures = listFixtureFiles(dir).map(loadFixtureFile);
  const seen = new Set<string>();
  for (const f of fixtures) {
    if (seen.has(f.id)) throw new KgEvalLoadError(`${dir}: fixture id ${f.id} appears twice`);
    seen.add(f.id);
  }
  return fixtures.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** `--only m01,m07` / `--tag promotion`: both narrow; neither given keeps all. */
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

/** One prediction file, or `null` when absent. Throws on a malformed file. */
export function loadPredictionFile(dir: string, fixtureId: string): KgEvalPrediction | null {
  const file = join(dir, `${fixtureId}.json`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new KgEvalLoadError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  const parsed = kgEvalPredictionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new KgEvalLoadError(`${file}: does not match kgEvalPredictionSchema — ${issues}`);
  }
  if (parsed.data.fixtureId !== fixtureId) {
    throw new KgEvalLoadError(`${file}: fixtureId is ${parsed.data.fixtureId}, expected ${fixtureId}`);
  }
  return parsed.data;
}
