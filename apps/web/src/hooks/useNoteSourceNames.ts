/**
 * Resolve "from *Q3 planning*" for a page of notes — issue #57, epic #45.
 *
 * =============================================================================
 * ⚠ WHY THIS EXISTS AT ALL, AND WHAT SHOULD REPLACE IT
 * =============================================================================
 *
 * `GET /api/notes` denormalises `templateName` onto every row — so a note whose
 * template was later deleted still says which one made it — but it does NOT
 * denormalise the SOURCE's name. A row carries `sourceType` plus one id and
 * nothing else, so a client that wants to render the source as a name rather
 * than as a category has to go and get it.
 *
 * THE RIGHT FIX IS IN THE API, not here: a `sourceName` beside `templateName`,
 * resolved in the same query that already joins the template. That is a change
 * to `dto/note.dto.ts` and `notes.service.ts` and it belongs to whoever next
 * touches them. Until then this hook is the honest client-side stand-in, and it
 * is written to be deleted: one import, one return value, and every consumer
 * already degrades to `noteSourceFallbackLabel` when the answer is missing.
 *
 * =============================================================================
 * WHAT IT COSTS, AND WHY THAT IS ACCEPTABLE
 * =============================================================================
 *
 * One request per DISTINCT, UNCACHED source on the page — at most twenty, in
 * practice far fewer (notes from one meeting share a transcript), and zero on
 * every later render, every tab switch and every poll because the cache is
 * module-level and lives for the tab. Each is a single indexed row read.
 *
 * THE CACHE IS NEVER INVALIDATED, deliberately. It holds titles of things this
 * page links to, not the things themselves; the worst a stale entry can do is
 * label a link with the name the target had a minute ago, and the target's own
 * page will show the current one. An invalidation strategy here would be more
 * machinery than the problem has.
 *
 * A FAILED LOOKUP IS CACHED AS "UNRESOLVED" AND NEVER RETRIED. A source the
 * caller cannot read answers 404 (the notes and transcripts controllers both
 * refuse to confirm existence), and that is a permanent answer for this user:
 * retrying it on every poll would be a request per row per five seconds for a
 * name that is never coming.
 */

import { useEffect, useState } from 'react';

import { getNote } from '../services/notes';
import type { NoteListItem } from '../services/notes';
import { getTranscript } from '../services/transcripts';
import { api } from '../services/api';
import { noteSourceRef } from '../utils/noteSource';
import type { NoteSourceRef } from '../utils/noteSource';
import { useIsMounted } from './useIsMounted';

/**
 * Resolved names, keyed by `<type>:<id>`.
 *
 * The type is part of the key because ids are uuids from three different
 * tables: nothing stops a note id and a transcript id colliding, and a bare id
 * key would then label one with the other's title.
 */
export type NoteSourceNames = Record<string, string>;

/** The key both this hook and its consumers build. Exported so neither guesses. */
export function noteSourceKey(ref: NoteSourceRef): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * Module-level and shared by every mount.
 *
 * A `null` value is a resolved NEGATIVE — "asked, cannot be named" — which is
 * what stops the retry loop described in the header. `undefined` (absent) is
 * "not asked yet".
 */
const cache = new Map<string, string | null>();

/** In flight right now, so two rows naming one transcript issue one request. */
const inFlight = new Set<string>();

/** Reset the shared cache. Exported for tests, which must not leak into each other. */
export function clearNoteSourceNameCache(): void {
  cache.clear();
  inFlight.clear();
}

async function resolveName(ref: NoteSourceRef): Promise<string | null> {
  switch (ref.type) {
    case 'transcript': {
      // `getTranscript` is the conditional (ETag) reader every transcript
      // surface uses. With no validator passed it can only answer `ok`.
      const result = await getTranscript(ref.id);
      return result.status === 'ok' ? result.data.title : null;
    }
    case 'note': {
      const note = await getNote(ref.id);
      return note.title;
    }
    case 'document': {
      // The uploaded file's own name. `managed_by: 'notes'` hides this object
      // from the storage LIST, not from a read of one by id.
      const object = await api.get<{ name: string }>(
        `/storage/objects/${encodeURIComponent(ref.id)}`,
      );
      return typeof object.name === 'string' ? object.name : null;
    }
    default:
      return null;
  }
}

/**
 * The names for whatever sources `notes` references, as far as they are known.
 *
 * Returns a map rather than mutating the rows: the rows are the API's answer
 * and should stay it, and a consumer that gets `undefined` back renders the
 * category noun instead — which is the correct thing to show both before the
 * lookup lands and forever after one that cannot.
 */
export function useNoteSourceNames(notes: NoteListItem[]): NoteSourceNames {
  const [names, setNames] = useState<NoteSourceNames>({});
  const isMounted = useIsMounted();

  // The rows this hook cares about, as a stable string, so the effect below
  // does not re-run for a poll that returned identical rows.
  const wanted = notes
    .map((note) => {
      const ref = noteSourceRef(note);
      return ref ? noteSourceKey(ref) : '';
    })
    .filter(Boolean)
    .sort()
    .join(',');

  useEffect(() => {
    const refs = new Map<string, NoteSourceRef>();
    for (const note of notes) {
      const ref = noteSourceRef(note);
      if (ref) refs.set(noteSourceKey(ref), ref);
    }

    // Publish whatever the cache already holds, synchronously, so a tab
    // revisited (or a poll) paints resolved names on the first frame instead of
    // flashing the fallback noun while the map is rebuilt.
    const known: NoteSourceNames = {};
    for (const key of refs.keys()) {
      const cached = cache.get(key);
      if (typeof cached === 'string') known[key] = cached;
    }
    if (isMounted()) setNames((current) => ({ ...current, ...known }));

    const missing = [...refs.entries()].filter(
      ([key]) => !cache.has(key) && !inFlight.has(key),
    );
    if (missing.length === 0) return;

    for (const [key] of missing) inFlight.add(key);

    void Promise.all(
      missing.map(async ([key, ref]) => {
        try {
          const name = await resolveName(ref);
          cache.set(key, name);
        } catch {
          // Cached as a resolved negative, never rethrown: a name that cannot
          // be read is a row that renders its category noun, not a page that
          // shows an error about a link's label.
          cache.set(key, null);
        } finally {
          inFlight.delete(key);
        }
      }),
    ).then(() => {
      if (!isMounted()) return;
      const resolved: NoteSourceNames = {};
      for (const key of refs.keys()) {
        const value = cache.get(key);
        if (typeof value === 'string') resolved[key] = value;
      }
      setNames((current) => ({ ...current, ...resolved }));
    });
    // `notes` is deliberately NOT a dependency: it is a new array identity on
    // every poll even when the rows are identical, and `wanted` is the value
    // that actually changes when the set of sources does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, isMounted]);

  return names;
}
