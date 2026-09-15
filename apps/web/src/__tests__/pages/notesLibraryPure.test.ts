import { describe, it, expect } from 'vitest';

import {
  NOTE_SOURCE_KINDS,
  buildNoteSource,
  emptyNewNoteDraft,
  isNewNoteReady,
} from '../../pages/newNote';
import { NOTE_STATUS_FILTERS } from '../../pages/notesLibraryFilters';
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
