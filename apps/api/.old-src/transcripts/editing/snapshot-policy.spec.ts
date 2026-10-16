// =============================================================================
// The snapshot policy (issue #27, epic #19, spec §4.3)
// =============================================================================

import {
  SNAPSHOT_BYTES_INTERVAL,
  SNAPSHOT_VERSION_INTERVAL,
  shouldSnapshot,
} from './snapshot-policy';

describe('shouldSnapshot', () => {
  const base = {
    version: 10,
    kind: 'edit' as const,
    lastSnapshotVersion: 8,
    bytesSinceSnapshot: 0,
  };

  it('always snapshots version 1 — the one version ops cannot rebuild', () => {
    expect(
      shouldSnapshot({ version: 1, kind: 'ai_original', lastSnapshotVersion: null, bytesSinceSnapshot: 0 }),
    ).toBe(true);
  });

  it('always snapshots a restore', () => {
    expect(shouldSnapshot({ ...base, kind: 'restore' })).toBe(true);
  });

  it('snapshots when nothing has ever been snapshotted', () => {
    expect(shouldSnapshot({ ...base, lastSnapshotVersion: null })).toBe(true);
  });

  it('does not snapshot an ordinary save just after one', () => {
    expect(shouldSnapshot(base)).toBe(false);
  });

  it('snapshots on the version interval', () => {
    expect(
      shouldSnapshot({ ...base, version: 8 + SNAPSHOT_VERSION_INTERVAL }),
    ).toBe(true);
    expect(
      shouldSnapshot({ ...base, version: 8 + SNAPSHOT_VERSION_INTERVAL - 1 }),
    ).toBe(false);
  });

  it('snapshots on the byte interval, so a few enormous batches are bounded too', () => {
    expect(shouldSnapshot({ ...base, bytesSinceSnapshot: SNAPSHOT_BYTES_INTERVAL })).toBe(true);
    expect(shouldSnapshot({ ...base, bytesSinceSnapshot: SNAPSHOT_BYTES_INTERVAL - 1 })).toBe(
      false,
    );
  });
});
