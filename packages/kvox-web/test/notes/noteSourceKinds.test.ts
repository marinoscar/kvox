/**
 * The source choices of the new-note form, worded for the host (#731): a host
 * without transcription keeps the transcript choice (a KVox transcript JSON
 * import is still a source) but never says the application transcribed it.
 */

import { describe, expect, it } from 'vitest';

import {
  IMPORTED_TRANSCRIPT_SOURCE_HINT,
  NOTE_SOURCE_KINDS,
  noteSourceKindsFor,
} from '../../src/notes/headless/utils/newNote.js';

describe('noteSourceKindsFor', () => {
  it('is the classic list, unchanged, with transcription on', () => {
    expect(noteSourceKindsFor(true)).toBe(NOTE_SOURCE_KINDS);
  });

  it('keeps every choice in order and words them for imports with transcription off', () => {
    const kinds = noteSourceKindsFor(false);
    expect(kinds.map((kind) => kind.value)).toEqual(NOTE_SOURCE_KINDS.map((kind) => kind.value));
    expect(kinds.find((kind) => kind.value === 'transcript')?.hint).toBe(IMPORTED_TRANSCRIPT_SOURCE_HINT);
    expect(IMPORTED_TRANSCRIPT_SOURCE_HINT).toBe('A transcript you imported (KVox transcript JSON).');
    for (const kind of kinds) {
      expect(`${kind.label} ${kind.hint}`).not.toMatch(/record|audio|transcribed|upload a/i);
    }
  });
});
