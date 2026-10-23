import { extractionStateOf, selectReconcileNotes } from './extraction-state.js';

describe('extractionStateOf (#716)', () => {
  const note = (currentVersion: number, extractedVersion: number | null) => ({ currentVersion, extractedVersion });

  it('pending: the current version was never extracted', () => {
    expect(extractionStateOf(note(2, 1), [])).toBe('pending');
    expect(extractionStateOf(note(1, null), [])).toBe('pending');
  });

  it('up to date: extracted_version covers the current version', () => {
    expect(extractionStateOf(note(2, 2), [])).toBe('up_to_date');
  });

  it('running wins over everything', () => {
    expect(extractionStateOf(note(2, 1), [{ noteVersion: 1, status: 'extracting' }])).toBe('running');
  });

  it('handled: a draft, committed or discarded proposal covers the current version', () => {
    for (const status of ['draft', 'committed', 'discarded', 'reverted']) {
      expect(extractionStateOf(note(2, null), [{ noteVersion: 2, status }])).toBe('handled');
    }
  });

  it('failed: only failed attempts at the current version; an older draft does not count', () => {
    expect(extractionStateOf(note(2, 1), [{ noteVersion: 2, status: 'failed' }, { noteVersion: 1, status: 'draft' }])).toBe('failed');
    expect(extractionStateOf(note(2, 1), [{ noteVersion: 1, status: 'draft' }])).toBe('pending');
  });
});

describe('selectReconcileNotes (#716)', () => {
  const versions = new Map([
    ['n1', 3],
    ['n2', 1],
    ['n3', 2],
    ['n4', 2],
  ]);

  it('picks only stale notes, once each, skipping running, failed and unknown notes', () => {
    const files = [
      { noteId: 'n1', extractedVersion: 1 }, // stale
      { noteId: 'n1', extractedVersion: 1 }, // duplicate file
      { noteId: 'n2', extractedVersion: 1 }, // up to date
      { noteId: 'n3', extractedVersion: null }, // running
      { noteId: 'n4', extractedVersion: null }, // failed
      { noteId: 'gone', extractedVersion: null }, // deleted
    ];
    const proposals = new Map([
      ['n3', [{ noteVersion: 2, status: 'extracting' }]],
      ['n4', [{ noteVersion: 2, status: 'failed' }]],
    ]);
    expect(selectReconcileNotes(files, versions, proposals, 500)).toEqual({ noteIds: ['n1'], truncated: false });
  });

  it('caps the run and reports that more remained', () => {
    const many = new Map<string, number>();
    const files = Array.from({ length: 5 }, (_, i) => {
      many.set(`m${i}`, 2);
      return { noteId: `m${i}`, extractedVersion: null };
    });
    expect(selectReconcileNotes(files, many, new Map(), 3)).toEqual({ noteIds: ['m0', 'm1', 'm2'], truncated: true });
    expect(selectReconcileNotes(files, many, new Map(), 5).truncated).toBe(false);
  });
});
