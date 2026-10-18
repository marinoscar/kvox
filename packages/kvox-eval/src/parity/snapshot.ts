import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { RecordedProviderRequest } from '@marinoscar/kvox-ai/testing';

// =============================================================================
// The committed request snapshots (issue #580, part 2)
// =============================================================================
//
// `parity/requests.<fixture>.json` (one per golden meeting) and
// `parity/requests.ask.json`, at the package root, shipped in `files`. They are the
// single source of truth for "what the harness sends": the direct binding's spec
// here, the web binding's spec in `apps/api`, and the Desktop repository's own
// binding all compare against the same files.
// =============================================================================

/** `src/parity` and `dist/parity` both sit two levels below the package root. */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

/**
 * The directory of the committed snapshots (`parity/` of the package).
 *
 * @stability experimental
 */
export const PARITY_SNAPSHOT_DIR = join(PACKAGE_ROOT, 'parity');

/**
 * The name of the Ask snapshot, beside the fixture ids (`m01`...).
 *
 * @stability experimental
 */
export const PARITY_ASK_SNAPSHOT = 'ask';

/**
 * The path of one snapshot file.
 *
 * @param name - a fixture id (`m01`) or {@link PARITY_ASK_SNAPSHOT}.
 * @returns the absolute path of `requests.<name>.json`.
 * @stability experimental
 */
export function paritySnapshotPath(name: string): string {
  if (!/^[a-z0-9]+$/i.test(name)) throw new Error(`Not a parity snapshot name: ${JSON.stringify(name)}`);
  return join(PARITY_SNAPSHOT_DIR, `requests.${name}.json`);
}

/**
 * Reads one committed snapshot: the provider-level requests a binding must build, in call order.
 *
 * @example
 * ```ts
 * expect(recorded).toEqual(loadParitySnapshot('m01'));
 * ```
 *
 * @param name - a fixture id (`m01`) or {@link PARITY_ASK_SNAPSHOT}.
 * @returns the records.
 * @throws when the file is missing (run the direct spec with `KVOX_EVAL_UPDATE_PARITY=1` to write it).
 * @stability experimental
 */
export function loadParitySnapshot(name: string): RecordedProviderRequest[] {
  return JSON.parse(readFileSync(paritySnapshotPath(name), 'utf8')) as RecordedProviderRequest[];
}

/**
 * Writes one snapshot (the direct spec does, when `KVOX_EVAL_UPDATE_PARITY=1`).
 *
 * @param name - a fixture id (`m01`) or {@link PARITY_ASK_SNAPSHOT}.
 * @param records - the provider-level records, normalized.
 * @stability experimental
 */
export function writeParitySnapshot(name: string, records: readonly RecordedProviderRequest[]): void {
  mkdirSync(PARITY_SNAPSHOT_DIR, { recursive: true });
  writeFileSync(paritySnapshotPath(name), `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}
