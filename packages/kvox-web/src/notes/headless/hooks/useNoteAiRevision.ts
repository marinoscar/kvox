import { useEffect, useState } from 'react';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import { getNoteVersions } from '../clients/notes.js';
import type { NoteVersion } from '../clients/notes.js';

/**
 * The AI's own revision of an imported note — issue #758.
 *
 * An imported note is never GENERATED, but `note.import.format` may commit a
 * later version written by the AI (`kind: 'edit'`, no author) with a summary of
 * what it did ("Formatted with AI"). That fact lives only in the note's
 * history, so this reads the first page of it and picks the oldest such
 * version. The summary is shown as the API wrote it; nothing here invents a
 * sentence the history does not carry.
 *
 * ⚠ READS ONLY WHEN `enabled`. The note page passes it for an imported note
 * past version 1 — every other note has nothing to find, and must not pay a
 * request for it.
 *
 * @stability experimental
 */
export interface UseNoteAiRevisionOptions {
  /** Read only when `true`. */
  enabled: boolean;
  /**
   * The note's current version. A change re-reads the history, so a formatting
   * pass that lands while the page is open is picked up.
   */
  currentVersion: number;
}

/**
 * What {@link useNoteAiRevision} returns.
 *
 * @stability experimental
 */
export interface UseNoteAiRevisionResult {
  /**
   * The oldest AI-authored edit that carries a summary, or `null` when there is
   * none, before the read settles, when not `enabled`, or when the read failed
   * (the history page says the same thing in full, so a failure here is quiet).
   */
  revision: NoteVersion | null;
}

/**
 * Picks the oldest AI-authored edit with a summary from a page of versions.
 *
 * @param items - Versions, in any order.
 * @returns The version, or `null`.
 *
 * @stability experimental
 */
export function pickNoteAiRevision(items: readonly NoteVersion[]): NoteVersion | null {
  let found: NoteVersion | null = null;
  for (const item of items) {
    if (item.kind !== 'edit' || item.author !== null || !item.summary) continue;
    if (found === null || item.version < found.version) found = item;
  }
  return found;
}

/**
 * The AI's own revision of a note, read from its history only while `enabled`.
 *
 * @param noteId - The note.
 * @param options - Whether to read, and the note's current version.
 * @returns The revision, or `null`.
 *
 * @stability experimental
 */
export function useNoteAiRevision(
  noteId: string,
  { enabled, currentVersion }: UseNoteAiRevisionOptions,
): UseNoteAiRevisionResult {
  const [revision, setRevision] = useState<NoteVersion | null>(null);
  const host = useKvoxHost();
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled) {
      setRevision(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const page = await getNoteVersions(host, noteId, { limit: 50 });
        if (cancelled || !isMounted()) return;
        setRevision(pickNoteAiRevision(page.items));
      } catch {
        if (cancelled || !isMounted()) return;
        setRevision(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, currentVersion, host, isMounted, noteId]);

  return { revision };
}
