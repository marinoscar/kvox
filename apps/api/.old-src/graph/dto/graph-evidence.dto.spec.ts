import { evidenceInputSchema } from './graph-evidence.dto';

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
      ok({ noteId: NOTE, noteVersion: 2, charStart: null, charEnd: null, quote: 'EY, Consulting' })
    ).toBe(true);
    // Omitted offsets default to null — the same Context citation.
    expect(ok({ noteId: NOTE, noteVersion: 2, quote: 'EY, Consulting' })).toBe(true);
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

  it('still accepts a whole-segment citation and refuses a row with no anchor', () => {
    expect(ok({ transcriptId: TRANSCRIPT, segmentId: SEGMENT, quote: 'Hello' })).toBe(true);
    expect(ok({ quote: 'orphan' })).toBe(false);
  });
});
