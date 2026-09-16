import { describe, it, expect } from 'vitest';

import {
  NOTE_SOURCE_KINDS,
  buildNoteSource,
  buildNoteTitle,
  emptyNewNoteDraft,
  isNewNoteReady,
} from '../../pages/newNote';
import {
  NOTE_STATUS_FILTERS,
  noteStatusFromQuery,
  searchFromQuery as notesSearchFromQuery,
} from '../../pages/notesLibraryFilters';
import {
  TRANSCRIPT_STATUS_FILTERS,
  searchFromQuery,
  transcriptScopeFromQuery,
  transcriptStatusFromQuery,
} from '../../pages/transcriptsLibraryFilters';
import {
  noteSourceFallbackLabel,
  noteSourcePath,
  noteSourceRef,
} from '../../utils/noteSource';
import type { NoteSourceFields } from '../../utils/noteSource';

/**
 * The notes surface's pure parts — issue #57, epic #45.
 *
 * Everything here is a function over data, which is exactly why it is a
 * separate file: these are the decisions that are easy to get wrong and
 * expensive to assert through a rendered form.
 *
 * This file was `libraryTabs.test.ts` until #106. Its first suite covered
 * `pages/libraryTabs.ts` — the Transcripts | Notes tab-is-the-URL mapping —
 * which that issue deleted along with the tab strip it served: `/transcripts`
 * and `/notes` are two destinations rendering two pages now, so there is no
 * pathname-to-tab function left to test. What that suite actually guarded, that
 * each path lights its own navigation row, moved to
 * `__tests__/config/destinations.test.ts`, which asserts it against the
 * destination table directly rather than through a page's tab state.
 *
 * ⚠ SINCE #170 THIS FILE ALSO COVERS THE TRANSCRIPTS LIBRARY'S PARSERS, which
 * its name does not advertise. The deep-link seeding that issue added is ONE
 * decision spanning two filter modules — both libraries read the same `?q`, and
 * each validates `?status` against its own offered list — and the assertion
 * that matters most (`searchFromQuery` is literally the same function under
 * both imports, not two implementations that agree today) can only be written
 * with both modules in scope. Splitting it in two would put the halves of one
 * rule where neither reader sees the other.
 */

describe('newNote — the body the form produces', () => {
  it('offers exactly three source kinds', () => {
    expect(NOTE_SOURCE_KINDS.map((kind) => kind.value)).toEqual([
      'transcript',
      'note',
      'document',
    ]);
    // Every one carries a hint: an unexplained radio is a choice a user makes
    // by guessing.
    for (const kind of NOTE_SOURCE_KINDS) expect(kind.hint.length).toBeGreaterThan(0);
  });

  it('sends exactly one id, whatever the form is holding', () => {
    // ⚠ THE CASE THIS FUNCTION EXISTS FOR: a user who picked a transcript,
    // changed their mind and uploaded a document. The API's source is a
    // discriminated union and a body with two ids is a body it rejects.
    const draft = {
      ...emptyNewNoteDraft(),
      kind: 'document' as const,
      transcriptId: 't1',
      noteId: 'n1',
      objectId: 'obj-1',
    };

    expect(buildNoteSource(draft)).toEqual({ type: 'document', objectId: 'obj-1' });
    expect(buildNoteSource({ ...draft, kind: 'transcript' })).toEqual({
      type: 'transcript',
      transcriptId: 't1',
    });
    expect(buildNoteSource({ ...draft, kind: 'note' })).toEqual({
      type: 'note',
      noteId: 'n1',
    });
  });

  it('produces nothing at all until the chosen kind has been answered', () => {
    expect(buildNoteSource(emptyNewNoteDraft())).toBeNull();
    expect(
      buildNoteSource({ ...emptyNewNoteDraft(), kind: 'note', transcriptId: 't1' }),
    ).toBeNull();
  });

  it('holds Generate back until an uploaded document has actually been read', () => {
    const draft = { ...emptyNewNoteDraft(), kind: 'document' as const, objectId: 'obj-1', templateId: 'tpl-1' };

    expect(isNewNoteReady(draft, false)).toBe(false);
    expect(isNewNoteReady(draft, true)).toBe(true);
  });

  it('does not hold a transcript source back on a document’s extraction', () => {
    // `documentReady` is about a queue job, not about the form. Collapsing the
    // two would block a source the flag has nothing to say about.
    const draft = { ...emptyNewNoteDraft(), transcriptId: 't1', templateId: 'tpl-1' };
    expect(isNewNoteReady(draft, false)).toBe(true);
  });

  it('requires a template', () => {
    const draft = { ...emptyNewNoteDraft(), transcriptId: 't1' };
    expect(isNewNoteReady(draft, true)).toBe(false);
  });
});

describe('buildNoteTitle — #187', () => {
  it('trims a typed title', () => {
    const draft = { ...emptyNewNoteDraft(), title: '  Q3 planning  ' };
    expect(buildNoteTitle(draft)).toBe('Q3 planning');
  });

  it('preserves internal spaces, trimming only the ends', () => {
    const draft = { ...emptyNewNoteDraft(), title: '  Q3   planning notes  ' };
    expect(buildNoteTitle(draft)).toBe('Q3   planning notes');
  });

  it('turns an untouched (empty) title into undefined', () => {
    expect(buildNoteTitle(emptyNewNoteDraft())).toBeUndefined();
  });

  it('turns whitespace-only input into undefined', () => {
    // ⚠ THE CASE THIS FUNCTION EXISTS FOR: the API's `title` is
    // `z.string().trim().min(1)`, so a value that trims to nothing must never
    // cross the wire — it would be a 400, not a fallback to the generated name.
    expect(buildNoteTitle({ ...emptyNewNoteDraft(), title: '   ' })).toBeUndefined();
    expect(buildNoteTitle({ ...emptyNewNoteDraft(), title: '\t' })).toBeUndefined();
    expect(buildNoteTitle({ ...emptyNewNoteDraft(), title: '\n' })).toBeUndefined();
    expect(buildNoteTitle({ ...emptyNewNoteDraft(), title: ' \t\n ' })).toBeUndefined();
  });
});

describe('noteSource — what a note was made from', () => {
  const base: NoteSourceFields = {
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
  };

  it('reads the id the sourceType names, and only that one', () => {
    expect(noteSourceRef(base)).toEqual({ type: 'transcript', id: 't1' });
    expect(
      noteSourceRef({ ...base, sourceType: 'note', sourceNoteId: 'n9', sourceTranscriptId: 't1' }),
    ).toEqual({ type: 'note', id: 'n9' });
  });

  it('answers null for a row whose type and id disagree', () => {
    // Unrepresentable on the way IN; a row written by another build could still
    // present it on the way out, and every consumer degrades rather than
    // rendering a broken link.
    expect(noteSourceRef({ ...base, sourceTranscriptId: null })).toBeNull();
  });

  it('links a transcript and another note, and deliberately does not link a document', () => {
    expect(noteSourcePath(base)).toBe('/transcripts/t1');
    expect(noteSourcePath({ ...base, sourceType: 'note', sourceNoteId: 'n9' })).toBe('/notes/n9');
    // An uploaded source document is `managed_by: 'notes'` and has no page in
    // this application. Naming it is right; linking it is not.
    expect(noteSourcePath({ ...base, sourceType: 'document', sourceObjectId: 'obj-1' })).toBeNull();
  });

  it('falls back to a NOUN, never to an id', () => {
    expect(noteSourceFallbackLabel('transcript')).toBe('a transcript');
    expect(noteSourceFallbackLabel('note')).toBe('another note');
    expect(noteSourceFallbackLabel('document')).toBe('an uploaded document');
  });
});

describe('notesLibraryFilters', () => {
  it('starts with the "Any status" sentinel the view translates into an omission', () => {
    expect(NOTE_STATUS_FILTERS[0]).toEqual({ value: 'all', label: 'Any status' });
  });

  it('offers deleting and does NOT offer draft', () => {
    const values = NOTE_STATUS_FILTERS.map((option) => option.value);
    // A note sits in `deleting` for as long as its purge job runs, and a user
    // who just deleted something has nowhere else to look.
    expect(values).toContain('deleting');
    // `draft` is the seconds between pressing Generate and the first token —
    // nobody filters for it, and "Generating" already covers what a reader
    // means by it.
    expect(values).not.toContain('draft');
  });
});

/**
 * The deep-link parsers — issue #170, epic #166.
 *
 * Pure functions over `URLSearchParams`, which is exactly why they live in the
 * filter modules and are asserted here rather than through a mounted page: the
 * interesting rules are what happens to input nobody typed deliberately (an
 * unknown status, a status the page does not offer, a missing parameter), and
 * a rendered `<Select>` is a slow and indirect way to ask.
 */

function query(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

describe('transcriptScopeFromQuery', () => {
  it('reads ?scope=shared', () => {
    expect(transcriptScopeFromQuery(query('?scope=shared'))).toBe('shared');
  });

  it('reads ?scope=owned', () => {
    expect(transcriptScopeFromQuery(query('?scope=owned'))).toBe('owned');
  });

  it('falls back to the user’s own transcripts for anything else', () => {
    // A broken link should land somebody on their own library, which is the
    // tab the page opens on anyway — never on an error.
    expect(transcriptScopeFromQuery(query(''))).toBe('owned');
    expect(transcriptScopeFromQuery(query('?scope=everything'))).toBe('owned');
    expect(transcriptScopeFromQuery(query('?scope='))).toBe('owned');
    // `all` is a real API scope with no tab to select. It is not a tab value.
    expect(transcriptScopeFromQuery(query('?scope=all'))).toBe('owned');
  });
});

describe('transcriptStatusFromQuery', () => {
  it('reads every status the page actually offers', () => {
    for (const option of TRANSCRIPT_STATUS_FILTERS) {
      expect(transcriptStatusFromQuery(query(`?status=${option.value}`))).toBe(option.value);
    }
  });

  it('falls back to "all" for an unknown status', () => {
    expect(transcriptStatusFromQuery(query('?status=bogus'))).toBe('all');
  });

  it('falls back to "all" when there is no status at all', () => {
    expect(transcriptStatusFromQuery(query(''))).toBe('all');
    expect(transcriptStatusFromQuery(query('?status='))).toBe('all');
  });
});

describe('noteStatusFromQuery', () => {
  it('reads every status the page actually offers', () => {
    for (const option of NOTE_STATUS_FILTERS) {
      expect(noteStatusFromQuery(query(`?status=${option.value}`))).toBe(option.value);
    }
  });

  it('refuses a real NoteStatus the page does not offer', () => {
    // ⚠ THE CASE THIS VALIDATION EXISTS FOR. `draft` is a legitimate API
    // status and deliberately absent from the filter list, so seeding it would
    // leave the `<Select>` holding a value that matches no `<MenuItem>` — a
    // control rendered blank, filtering the list by something the reader can
    // neither see nor undo.
    expect(noteStatusFromQuery(query('?status=draft'))).toBe('all');
  });

  it('falls back to "all" for an unknown or absent status', () => {
    expect(noteStatusFromQuery(query('?status=bogus'))).toBe('all');
    expect(noteStatusFromQuery(query(''))).toBe('all');
  });
});

describe('searchFromQuery', () => {
  it('reads ?q verbatim', () => {
    expect(searchFromQuery(query('?q=budget%20review'))).toBe('budget review');
  });

  it('answers the empty string when there is no ?q', () => {
    expect(searchFromQuery(query(''))).toBe('');
  });

  it('does not trim — the box shows what the URL said', () => {
    // Seeding a text input with something other than what the link carried
    // would make the user's first edit look like a correction they did not
    // make. Emptiness is decided where it is asked (`isFiltered`), not here.
    expect(searchFromQuery(query('?q=%20%20'))).toBe('  ');
  });

  it('is ONE function, reachable under the same name from both filter modules', () => {
    // Two libraries whose deep links disagreed about the name of the search
    // parameter is the failure this re-export prevents.
    expect(notesSearchFromQuery).toBe(searchFromQuery);
  });
});
