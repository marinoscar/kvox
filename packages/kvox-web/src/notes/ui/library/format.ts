/**
 * Wording shared by the note library pages (issue #720): sizes, token counts and
 * the one-line description of a sync in progress.
 */

import type { LibrarySyncProgress } from '../../headless/index.js';

/**
 * A byte count for a person: `0 B`, `812 KB`, `14.2 MB`.
 *
 * @param bytes - The count.
 * @returns The label.
 *
 * @stability experimental
 */
export function formatImportBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * A token estimate for a person: `900`, `12k`, `1.4M`.
 *
 * @param tokens - The estimate.
 * @returns The label.
 *
 * @stability experimental
 */
export function formatTokenEstimate(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * `n thing` or `n things`.
 *
 * @param count - The count.
 * @param singular - The word for one.
 * @param plural - The word for several. Default `singular + 's'`.
 * @returns The phrase.
 *
 * @stability experimental
 */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * The one-line description of a sync or an import in progress.
 *
 * @param progress - The snapshot.
 * @returns The sentence.
 *
 * @stability experimental
 */
export function describeSyncProgress(progress: LibrarySyncProgress): string {
  switch (progress.phase) {
    case 'enumerating':
      return progress.done === 0
        ? 'Looking for notes in the folder…'
        : `Looking for notes… ${pluralize(progress.done, 'file')} found`;
    case 'hashing':
      return `Checking changed files… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`;
    case 'uploading':
      return `Uploading ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}${
        progress.failed.length > 0 ? ` (${progress.failed.length.toLocaleString()} failed)` : ''
      }`;
    case 'done':
      return progress.total === 0 ? 'Everything is up to date.' : 'Upload finished.';
  }
}

/**
 * The determinate value (0 to 100) of a sync in progress, or `undefined` while
 * the total is not known yet (enumerating).
 *
 * @param progress - The snapshot.
 * @returns The percentage, or `undefined`.
 *
 * @stability experimental
 */
export function syncProgressPercent(progress: LibrarySyncProgress): number | undefined {
  if (progress.phase === 'enumerating') return undefined;
  if (progress.phase === 'done') return 100;
  if (progress.total === 0) return 0;
  return Math.min(100, Math.round((progress.done / progress.total) * 100));
}
