import { DigestCitationError, readDigestStatements, validateDigestCitations } from './citation-validation';

const E = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const handles = new Map<string, string[]>([
  ['F1', [E(1), E(2)]],
  ['F2', [E(2), E(3)]],
  ['F3', [E(4), E(5), E(6), E(7), E(8)]],
]);

describe('validateDigestCitations', () => {
  it('drops a statement with no refs and one naming an unknown handle, counting both', () => {
    const r = validateDigestCitations(
      [
        { text: 'Kept', factRefs: ['F1'] },
        { text: 'No refs', factRefs: [] },
        { text: 'Invented', factRefs: ['F1', 'F99'] },
      ],
      handles,
    );
    expect(r.statements).toEqual([{ text: 'Kept', evidenceIds: [E(1), E(2)] }]);
    expect(r.dropped).toBe(2);
  });

  it('maps handles to evidence ids, deduplicated and capped at eight', () => {
    const r = validateDigestCitations([{ text: 'All', factRefs: ['F1', 'F2', 'F3', 'F1'] }], handles);
    expect(r.statements[0].evidenceIds).toEqual([E(1), E(2), E(3), E(4), E(5), E(6), E(7), E(8)]);
    const long = new Map(handles).set('F4', [E(9), E(10)]);
    expect(validateDigestCitations([{ text: 'Cap', factRefs: ['F1', 'F2', 'F3', 'F4'] }], long).statements[0].evidenceIds).toHaveLength(8);
  });

  it('keeps at most twelve statements and counts the rest as dropped', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ text: `s${i}`, factRefs: ['F1'] }));
    const r = validateDigestCitations(many, handles);
    expect(r.statements).toHaveLength(12);
    expect(r.dropped).toBe(2);
  });

  it('throws when nothing survives', () => {
    expect(() => validateDigestCitations([{ text: 'x', factRefs: [] }, { text: 'y', factRefs: ['F9'] }], handles)).toThrow(
      DigestCitationError,
    );
    expect(() => validateDigestCitations([], handles)).toThrow(DigestCitationError);
  });
});

describe('readDigestStatements', () => {
  it('reads the stored version-1 shape defensively', () => {
    expect(readDigestStatements({ version: 1, statements: [{ text: 'a', evidenceIds: [E(1)] }, { text: 'b', evidenceIds: [] }, 'junk'] })).toEqual([
      { text: 'a', evidenceIds: [E(1)] },
    ]);
    expect(readDigestStatements(null)).toEqual([]);
    expect(readDigestStatements({ statements: 'nope' })).toEqual([]);
  });
});
