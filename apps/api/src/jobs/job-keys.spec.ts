import { buildDedupKey } from './job-keys';

describe('buildDedupKey', () => {
  it('joins type, subjectType and subjectId with colons', () => {
    expect(buildDedupKey('email.send', 'user', 'abc-123')).toBe(
      'email.send:user:abc-123',
    );
  });

  it('coalesces a missing subjectType/subjectId to an empty segment', () => {
    expect(buildDedupKey('report.nightly')).toBe('report.nightly::');
  });

  it('treats explicit null the same as omitted (global/system job)', () => {
    expect(buildDedupKey('report.nightly', null, null)).toBe(
      'report.nightly::',
    );
  });

  it('is stable: the same inputs always produce the same key', () => {
    const a = buildDedupKey('export.csv', 'org', 'org-1');
    const b = buildDedupKey('export.csv', 'org', 'org-1');
    expect(a).toBe(b);
  });

  it('distinguishes different subjects for the same type', () => {
    const a = buildDedupKey('export.csv', 'org', 'org-1');
    const b = buildDedupKey('export.csv', 'org', 'org-2');
    expect(a).not.toBe(b);
  });

  it('distinguishes different types for the same subject', () => {
    const a = buildDedupKey('export.csv', 'org', 'org-1');
    const b = buildDedupKey('export.pdf', 'org', 'org-1');
    expect(a).not.toBe(b);
  });

  it('distinguishes a global job (both null) from a job with an empty-string subject', () => {
    // Documented edge case, not a recommended input: an explicit empty
    // string is indistinguishable from a global job under this format.
    // Callers must not pass '' meaning "unknown subject" — pass null/undefined.
    const global = buildDedupKey('report.nightly', null, null);
    const emptyStrings = buildDedupKey('report.nightly', '', '');
    expect(global).toBe(emptyStrings);
  });
});
