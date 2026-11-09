import { describe, expect, it } from 'vitest';

import {
  evidenceInputSchema,
  evidenceLinkSchema,
  evidenceSpanInputSchema,
  evidenceViewSchema,
} from '../src/graph/index.js';

// The source-text evidence anchor (#789): a span of the full text of the document a note
// was generated from. Invented ids only.

const NOTE = '22222222-2222-4222-8222-222222222222';
const TEXT = '77777777-7777-4777-8777-777777777777';
const SUBJECT = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';

const cited = {
  noteId: NOTE,
  noteVersion: 2,
  sourceObjectId: TEXT,
  sourceTextLength: 1000,
  charStart: 10,
  charEnd: 60,
  quote: 'Person K1 leads Project P1',
};

describe('evidenceInputSchema, source-text anchor', () => {
  it('accepts a span inside the text, with the note for the deep link', () => {
    expect(evidenceInputSchema.safeParse(cited).success).toBe(true);
  });

  it('defaults both fields to null on every other citation', () => {
    const parsed = evidenceInputSchema.parse({ noteId: NOTE, noteVersion: 2, charStart: 1, charEnd: 4, quote: 'abc' });
    expect(parsed.sourceObjectId).toBeNull();
    expect(parsed.sourceTextLength).toBeNull();
  });

  it.each([
    ['a span past the end of the text', { charEnd: 1001 }],
    ['an object without its length', { sourceTextLength: null }],
    ['a length without its object', { sourceObjectId: null }],
    ['no offsets', { charStart: null, charEnd: null }],
    ['no note', { noteId: null, noteVersion: null }],
  ])('refuses %s', (_name, over) => {
    expect(evidenceInputSchema.safeParse({ ...cited, ...over }).success).toBe(false);
  });
});

describe('the read shapes', () => {
  it('an evidence link may be a source_text source', () => {
    const link = {
      id: ID,
      subjectKind: 'entity',
      subjectId: SUBJECT,
      quote: 'Person K1 leads Project P1',
      createdAt: '2026-11-07T12:00:00.000Z',
      source: {
        kind: 'source_text',
        noteId: NOTE,
        noteTitle: 'Plan summary',
        noteVersion: 2,
        sourceObjectId: TEXT,
        charStart: 10,
        charEnd: 60,
        sourceTextLength: 1000,
        available: true,
        href: `/notes/${NOTE}?source=10-60`,
      },
    };
    expect(evidenceLinkSchema.parse(link)).toEqual(link);
    // The purged shape: no object, no link, the quote and the length stay.
    expect(
      evidenceLinkSchema.safeParse({ ...link, source: { ...link.source, sourceObjectId: null, available: false, href: null } }).success,
    ).toBe(true);
  });

  it('a proposal evidence view may be source_text and carries the two new fields', () => {
    const view = {
      id: ID,
      source: 'source_text',
      transcriptId: null,
      segmentId: null,
      segmentRev: null,
      startMs: null,
      endMs: null,
      noteId: NOTE,
      noteVersion: 2,
      charStart: 10,
      charEnd: 60,
      quote: 'q',
      importObjectId: null,
      sourceIri: null,
      sourceObjectId: TEXT,
      sourceTextLength: 1000,
      speakerName: null,
      hasAudio: false,
      stale: false,
    };
    expect(evidenceViewSchema.parse(view)).toEqual(view);
  });

  it('a reviewer can select a span of the source text', () => {
    expect(evidenceSpanInputSchema.safeParse({ source: 'source_text', charStart: 0, charEnd: 5, quote: 'Hello' }).success).toBe(true);
    // No stray keys: the text is the proposal note's own, never named by the client.
    expect(
      evidenceSpanInputSchema.safeParse({ source: 'source_text', charStart: 0, charEnd: 5, quote: 'Hello', sourceObjectId: TEXT }).success,
    ).toBe(false);
  });
});
