import { evidenceInputSchema } from './graph-evidence.dto.js';

const NOTE = '22222222-2222-4222-8222-222222222222';
const TRANSCRIPT = '44444444-4444-4444-8444-444444444444';
const SEGMENT = '66666666-6666-4666-8666-666666666666';

describe('evidenceInputSchema', () => {
  const ok = (row: Record<string, unknown>) => evidenceInputSchema.safeParse(row).success;

  it('accepts a note span with both offsets', () => {
    expect(ok({ noteId: NOTE, noteVersion: 2, charStart: 3, charEnd: 9, quote: 'Hello' })).toBe(
      true
    );
  });

  it('accepts a note Context citation: both offsets null (#440)', () => {
    expect(
      ok({ noteId: NOTE, noteVersion: 2, charStart: null, charEnd: null, quote: 'OAC, Consulting' })
    ).toBe(true);
    // Omitted offsets default to null — the same Context citation.
    expect(ok({ noteId: NOTE, noteVersion: 2, quote: 'OAC, Consulting' })).toBe(true);
  });

  it('refuses a note citation with exactly one offset set', () => {
    expect(ok({ noteId: NOTE, noteVersion: 2, charStart: 3, charEnd: null, quote: 'Hello' })).toBe(
      false
    );
    expect(ok({ noteId: NOTE, noteVersion: 2, charStart: null, charEnd: 9, quote: 'Hello' })).toBe(
      false
    );
  });

  it('refuses a note citation without its version', () => {
    expect(ok({ noteId: NOTE, charStart: null, charEnd: null, quote: 'Hello' })).toBe(false);
  });

  describe('a source-text citation (#789)', () => {
    const OBJECT = '77777777-7777-4777-8777-777777777777';
    const source = {
      noteId: NOTE,
      noteVersion: 2,
      sourceObjectId: OBJECT,
      sourceTextLength: 5000,
      charStart: 40,
      charEnd: 90,
      quote: 'Person K1 leads Project P1',
    };

    it('accepts the note, the text object, its length and a span inside it', () => {
      expect(ok(source)).toBe(true);
      expect(ok({ ...source, charEnd: 5000 })).toBe(true);
    });

    it('defaults both new fields to null, so every existing citation is unchanged', () => {
      const parsed = evidenceInputSchema.parse({ noteId: NOTE, noteVersion: 2, charStart: 3, charEnd: 9, quote: 'Hello' });
      expect(parsed).toMatchObject({ sourceObjectId: null, sourceTextLength: null });
    });

    it('refuses a span that runs past the text it indexes', () => {
      expect(ok({ ...source, charEnd: 5001 })).toBe(false);
    });

    it('refuses a text object without its length, and a length without the object', () => {
      expect(ok({ ...source, sourceTextLength: null })).toBe(false);
      expect(ok({ ...source, sourceObjectId: null })).toBe(false);
    });

    it('refuses one without offsets or without the note, and one mixed with another anchor', () => {
      expect(ok({ ...source, charStart: null, charEnd: null })).toBe(false);
      expect(ok({ ...source, noteId: null, noteVersion: null })).toBe(false);
      expect(ok({ ...source, transcriptId: TRANSCRIPT, segmentId: SEGMENT })).toBe(false);
      expect(ok({ ...source, importObjectId: OBJECT })).toBe(false);
    });
  });

  it('still accepts a whole-segment citation and refuses a row with no anchor', () => {
    expect(ok({ transcriptId: TRANSCRIPT, segmentId: SEGMENT, quote: 'Hello' })).toBe(true);
    expect(ok({ quote: 'orphan' })).toBe(false);
  });
});
