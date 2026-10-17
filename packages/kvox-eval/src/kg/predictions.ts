// Loading a predictions directory (issue #362): `<dir>/<fixtureId>.json`, one
// file per fixture, parsed through `kgEvalPredictionSchema`. A missing file is
// `null` (the caller scores it as empty and says so); a malformed one throws
// with its name.

import { readFileSync } from 'fs';
import { join } from 'path';

import { KgEvalLoadError } from '../fixtures/index.js';
import { kgEvalPredictionSchema, type KgEvalPrediction } from './prediction-schema.js';

/**
 * One prediction file, or `null` when absent.
 *
 * @param dir - the predictions directory.
 * @param fixtureId - the fixture the file is named after.
 * @returns the prediction, or `null`.
 * @throws `KgEvalLoadError` when the file is not JSON, does not match the schema or names another fixture.
 * @stability experimental
 */
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
