/**
 * What Home knows about the person's note libraries and imports (#721, epic
 * #708): the `libraries` and `recentImports` cards of the knowledge-first Home.
 *
 * ONE REQUEST PER CONTENT TYPE: the libraries (`GET /api/notes/libraries`) and
 * the latest batches (`GET /api/notes/import-batches?limit=`) are read once, in
 * parallel, by {@link useHomeImports}, and both cards draw from that one answer.
 * The calls are the notes slice's (`listNoteLibraries`, `listNoteImportBatches`);
 * Home only reads.
 */

import type { NoteImportBatch, NoteLibrary } from '@marinoscar/kvox-contract/notes';
import { useCallback, useEffect, useState } from 'react';

import { useIsMounted, useKvoxHost } from '../../core/headless/index.js';
import { listNoteImportBatches, listNoteLibraries } from '../../notes/headless/index.js';

/**
 * How many import batches the `recentImports` card lists.
 *
 * @stability experimental
 */
export const HOME_RECENT_IMPORTS_LIMIT = 5;

/**
 * The libraries, counted.
 *
 * @stability experimental
 */
export interface HomeLibrariesSummary {
  /** Libraries the person has. */
  libraries: number;
  /** Files imported as notes, across every library. */
  imported: number;
  /** Files that failed to import, across every library. */
  failed: number;
  /** The most recent scan of any library (ISO 8601), or `null` when none was scanned. */
  lastSync: string | null;
}

/**
 * Counts the libraries for the `libraries` card.
 *
 * @param libraries - The person's libraries.
 * @returns The counts and the last sync.
 *
 * @stability experimental
 */
export function summarizeLibraries(libraries: readonly NoteLibrary[]): HomeLibrariesSummary {
  let imported = 0;
  let failed = 0;
  let lastSync: string | null = null;
  for (const library of libraries) {
    imported += library.counts?.imported ?? 0;
    failed += library.counts?.failed ?? 0;
    if (library.lastScanAt && (lastSync === null || Date.parse(library.lastScanAt) > Date.parse(lastSync))) {
      lastSync = library.lastScanAt;
    }
  }
  return { libraries: libraries.length, imported, failed, lastSync };
}

/**
 * Options of {@link useHomeImports}.
 *
 * @stability experimental
 */
export interface UseHomeImportsOptions {
  /** `false` reads nothing (no `notes:read`, or neither card is listed). */
  enabled: boolean;
  /** How many batches to read. Default {@link HOME_RECENT_IMPORTS_LIMIT}. */
  batchLimit?: number;
}

/**
 * What {@link useHomeImports} returns. Each half settles on its own: a server
 * without import batches still shows the libraries, and the reverse.
 *
 * @stability experimental
 */
export interface UseHomeImportsResult {
  /** The libraries, or `null` before the read settles or when it failed. */
  libraries: NoteLibrary[] | null;
  /** The latest batches, or `null` before the read settles or when it failed. */
  batches: NoteImportBatch[] | null;
  /** Either read is still in flight. */
  isLoading: boolean;
  /** The libraries read failed. */
  librariesFailed: boolean;
  /** The batches read failed. */
  batchesFailed: boolean;
  /** Re-reads both. */
  refresh: () => Promise<void>;
}

/**
 * The person's note libraries and latest import batches, read in parallel.
 *
 * @param options - See {@link UseHomeImportsOptions}.
 * @returns Both lists and their load state.
 *
 * @stability experimental
 */
export function useHomeImports(options: UseHomeImportsOptions): UseHomeImportsResult {
  const { enabled, batchLimit = HOME_RECENT_IMPORTS_LIMIT } = options;
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [libraries, setLibraries] = useState<NoteLibrary[] | null>(null);
  const [batches, setBatches] = useState<NoteImportBatch[] | null>(null);
  const [librariesFailed, setLibrariesFailed] = useState(false);
  const [batchesFailed, setBatchesFailed] = useState(false);
  const [isLoading, setIsLoading] = useState(enabled);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const [libs, recent] = await Promise.allSettled([
      listNoteLibraries(host),
      listNoteImportBatches(host, { limit: batchLimit }),
    ]);
    if (!isMounted()) return;
    setLibraries(libs.status === 'fulfilled' ? libs.value : null);
    setLibrariesFailed(libs.status === 'rejected');
    setBatches(recent.status === 'fulfilled' ? recent.value : null);
    setBatchesFailed(recent.status === 'rejected');
    setIsLoading(false);
  }, [batchLimit, enabled, host, isMounted]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void refresh();
  }, [enabled, refresh]);

  return { libraries, batches, isLoading, librariesFailed, batchesFailed, refresh };
}
