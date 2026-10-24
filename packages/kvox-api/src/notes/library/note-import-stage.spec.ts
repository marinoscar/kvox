import { deriveItemStage, pickProposal, recomputeBatchStatus } from './note-import-stage.js';

describe('deriveItemStage', () => {
  it.each([
    ['failed', null, 'failed'],
    ['queued', null, 'uploaded'],
    ['importing', null, 'uploaded'],
    ['imported', null, 'parsed'],
    ['imported', 'discarded', 'parsed'],
    ['imported', 'extracting', 'extracting'],
    ['imported', 'draft', 'extracted'],
    ['imported', 'committed', 'in_graph'],
    ['missing', null, 'uploaded'],
  ] as const)('%s + %s -> %s', (status, proposal, stage) => {
    expect(deriveItemStage(status, proposal)).toBe(stage);
  });

  it('reads formatting for an imported item whose note is being formatted, and only then', () => {
    expect(deriveItemStage('imported', null, true)).toBe('formatting');
    expect(deriveItemStage('failed', null, true)).toBe('failed');
    expect(deriveItemStage('queued', null, true)).toBe('uploaded');
    expect(deriveItemStage('imported', null, false)).toBe('parsed');
  });
});

describe('pickProposal', () => {
  const at = (n: number) => new Date(n);

  it('prefers the newest proposal of the note version', () => {
    const picked = pickProposal(
      [
        { id: 'new-v2', noteVersion: 2, createdAt: at(30) },
        { id: 'old-v1', noteVersion: 1, createdAt: at(10) },
        { id: 'new-v1', noteVersion: 1, createdAt: at(20) },
      ],
      1
    );
    expect(picked?.id).toBe('new-v1');
  });

  it('falls back to the latest, and to null with none', () => {
    expect(pickProposal([{ id: 'a', noteVersion: 3, createdAt: at(1) }], 1)?.id).toBe('a');
    expect(pickProposal([], 1)).toBeNull();
  });
});

describe('recomputeBatchStatus', () => {
  it('stays running while items are queued or importing', () => {
    expect(recomputeBatchStatus('running', { queued: 1, imported: 4 })).toBe('running');
    expect(recomputeBatchStatus('running', { importing: 1 })).toBe('running');
  });

  it('completes, with errors when any failed', () => {
    expect(recomputeBatchStatus('running', { imported: 2, missing: 1 })).toBe('completed');
    expect(recomputeBatchStatus('running', { imported: 2, failed: 1 })).toBe(
      'completed_with_errors'
    );
  });

  it('keeps a cancelled batch cancelled', () => {
    expect(recomputeBatchStatus('cancelled', { imported: 1 })).toBe('cancelled');
  });
});
