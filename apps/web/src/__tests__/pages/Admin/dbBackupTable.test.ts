/**
 * Admin → Operations → Database Backup: the column contract (issue #287, epic #254).
 *
 * The table's MECHANICS — pagination, the column picker, CSV escaping, the
 * renderer switch, the axe pass — are asserted once for every table in
 * `runDataTableConformanceSuite` and are not repeated here. What this file
 * covers is the part of the contract that is specific to a BACKUP history and
 * could be wrong while the DataTable is perfectly fine:
 *
 *   * that the byte counts, which arrive as DECIMAL STRINGS because they are
 *     `BigInt` columns, are rendered as sizes and not as raw digits or `NaN`;
 *   * that a run still writing shows what it has streamed rather than a final
 *     size of zero;
 *   * that no column advertises a filter the endpoint cannot answer, and that
 *     the two it can are declared;
 *   * that the row-unique scalar really is unique, since it becomes the
 *     accessible name of a button that deletes an archive and of one that
 *     replaces the production database;
 *   * that `null` is rendered as the real answer it is ("Not verified") rather
 *     than as a gap.
 */

import { describe, it, expect } from 'vitest';
import {
  RESTORE_STATUS_LABELS,
  RUN_STATUS_CHIPS,
  STATUS_COLUMN_ID,
  TABLE_ID,
  TRIGGER_COLUMN_ID,
  TRIGGER_LABELS,
  asRunStatus,
  asRunTrigger,
  buildBackupRunColumns,
  formatBytes,
  formatRunDuration,
  formatRunSize,
  readIsFilter,
  shortChecksum,
} from '../../../pages/Admin/dbBackupTable';
import {
  DB_BACKUP_RUN_STATUSES,
  DB_BACKUP_TRIGGERS,
  RESTORE_STATUSES,
} from '../../../services/dbBackup';
import type { DbBackupRun } from '../../../services/dbBackup';
import type { DataTableColumn } from '../../../components/datatable';

const NOW = new Date('2026-01-01T12:00:00.000Z');

export function run(overrides: Partial<DbBackupRun> = {}): DbBackupRun {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'completed',
    trigger: 'scheduled',
    bytesWritten: '1288490188',
    sizeBytes: '1288490188',
    storageProvider: 's3',
    storageKey: 'backups/2026-01-01.dump',
    bucket: 'app-backups',
    format: 'custom',
    checksumSha256: 'a1b2c3d4e5f6a7b8c9d0',
    verifiedAt: '2026-01-01T00:45:00.000Z',
    dbVersion: '17.2',
    appVersion: '1.0.0',
    migrationName: '20260101120000_init',
    lastError: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:40:00.000Z',
    lastHeartbeatAt: null,
    createdById: null,
    restoreStatus: null,
    restoreError: null,
    restoredAt: null,
    restoredById: null,
    restoreScratchDb: null,
    restoreOldDb: null,
    swappedAt: null,
    preRestoreBackupId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:40:00.000Z',
    ...overrides,
  };
}

const columns = buildBackupRunColumns(NOW);

function column(id: string): DataTableColumn<DbBackupRun> {
  const found = columns.find((candidate) => candidate.id === id);
  expect(found, `column ${id} must exist`).toBeDefined();
  return found as DataTableColumn<DbBackupRun>;
}

describe('the table id', () => {
  it('is a stable storage key, not derived from the route or the heading', () => {
    expect(TABLE_ID).toBe('admin-db-backup-runs');
  });
});

describe('what the endpoint can actually serve', () => {
  it('declares a filter on exactly the two query parameters the API takes', () => {
    const filterable = columns.filter((entry) => entry.filterable).map((entry) => entry.id);
    expect(filterable.sort()).toEqual([STATUS_COLUMN_ID, TRIGGER_COLUMN_ID].sort());
  });

  it('offers every status and every trigger the API accepts, and nothing else', () => {
    expect(column(STATUS_COLUMN_ID).enumValues?.map((entry) => entry.value)).toEqual([
      ...DB_BACKUP_RUN_STATUSES,
    ]);
    expect(column(TRIGGER_COLUMN_ID).enumValues?.map((entry) => entry.value)).toEqual([
      ...DB_BACKUP_TRIGGERS,
    ]);
  });

  it('declares NO sortable column, because the endpoint offers no sort key', () => {
    // A sortable header the server cannot honour either silently does nothing
    // or 400s, and both are worse than a table that is honestly newest-first.
    expect(columns.filter((entry) => entry.sortable)).toEqual([]);
  });

  it('declares NO searchable column, because there is no free-text parameter', () => {
    expect(columns.filter((entry) => entry.searchable)).toEqual([]);
  });
});

describe('the row-unique scalar', () => {
  it('appends a short id, because two scheduled backups can start in the same minute', () => {
    // This scalar becomes the accessible name of the delete and restore
    // buttons. Two rows announced identically, on those actions, is not
    // acceptable.
    const first = run({ id: 'aaaaaaaa-1111-4111-8111-111111111111' });
    const second = run({ id: 'bbbbbbbb-2222-4222-8222-222222222222' });
    const scalar = column('startedAt').value!;

    expect(scalar(first)).not.toEqual(scalar(second));
    expect(String(scalar(first))).toContain('aaaaaaaa');
  });

  it('falls back to `createdAt` for a pending run that has not started', () => {
    const pending = run({ status: 'pending', startedAt: null });
    expect(String(column('startedAt').value!(pending))).not.toContain('—');
  });

  it('cannot be hidden, since hiding it would rename every control on the page', () => {
    expect(column('startedAt').hideable).toBe(false);
  });
});

describe('the byte columns — decimal STRINGS, because they are BigInt columns', () => {
  it('formats a string byte count as a size', () => {
    expect(formatBytes('0')).toBe('0 B');
    expect(formatBytes('999')).toBe('999 B');
    expect(formatBytes('1500')).toBe('1.5 KB');
    expect(formatBytes('1288490188')).toBe('1.3 GB');
    expect(formatBytes('45000000000')).toBe('45 GB');
  });

  it('formats a value far beyond Number.MAX_SAFE_INTEGER without producing NaN', () => {
    // The whole reason the API sends these as strings. A few bits of mantissa
    // are invisible in "9.2 PB"; the same rounding at the transport boundary
    // would corrupt a value that later gets compared.
    expect(formatBytes('9223372036854775807')).toBe('9.2 EB');
  });

  it('renders an absent or unreadable count as an em dash, never as zero', () => {
    // `freeDiskBytes` is genuinely `null` on many hosts, and a confident zero
    // there would read as "the disk is full".
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes('not a number')).toBe('—');
    expect(formatBytes('-5')).toBe('—');
  });

  it('shows a running dump’s LIVE bytes written, not its final size of zero', () => {
    const running = run({ status: 'running', sizeBytes: '0', bytesWritten: '11000000000' });
    expect(formatRunSize(running)).toBe('11 GB written');
    expect(String(column('size').value!(running))).toBe('11 GB written');
  });

  it('shows the final archive size once the run has finished', () => {
    expect(formatRunSize(run())).toBe('1.3 GB');
  });
});

describe('durations', () => {
  it('measures a finished run between its own timestamps', () => {
    expect(formatRunDuration(run(), NOW)).toBe('40m 00s');
  });

  it('measures an unfinished run against the page’s single clock', () => {
    const running = run({ status: 'running', finishedAt: null });
    expect(formatRunDuration(running, NOW)).toBe('12h 00m');
  });

  it('renders a run that never started as an em dash rather than a zero', () => {
    // A zero would state a measurement that was never taken.
    expect(formatRunDuration(run({ startedAt: null, finishedAt: null }), NOW)).toBe('—');
  });
});

describe('the status vocabulary', () => {
  it('covers every status the API can send', () => {
    expect(Object.keys(RUN_STATUS_CHIPS).sort()).toEqual([...DB_BACKUP_RUN_STATUSES].sort());
  });

  it('draws STALE differently from FAILED by palette, fill AND word', () => {
    // "Nobody knows how this ended" and "this ended badly" are different
    // problems with different next steps. Colour alone is not an accessible
    // distinction, and this table gets screenshotted into incident channels.
    const stale = RUN_STATUS_CHIPS.stale;
    const failed = RUN_STATUS_CHIPS.failed;

    expect(stale.label).toBe('Stale');
    expect(stale.color).toBe('warning');
    expect(stale.variant).toBe('filled');
    expect(failed.color).toBe('error');
    expect(stale.color).not.toBe(failed.color);
    expect(stale.Icon).not.toBe(failed.Icon);
  });

  it('draws STALE differently from COMPLETED too, since a stale archive may be truncated', () => {
    expect(RUN_STATUS_CHIPS.stale.color).not.toBe(RUN_STATUS_CHIPS.completed.color);
    expect(RUN_STATUS_CHIPS.stale.Icon).not.toBe(RUN_STATUS_CHIPS.completed.Icon);
  });

  it('names the pre-restore trigger for what it is, not by its wire value', () => {
    // It is the safety dump the restore path took on its own initiative, and an
    // operator deciding what to delete must not read it as a scheduled backup.
    expect(TRIGGER_LABELS.pre_restore).toBe('Before a restore');
    expect(Object.keys(TRIGGER_LABELS).sort()).toEqual([...DB_BACKUP_TRIGGERS].sort());
  });

  it('covers every restore status the audit can carry', () => {
    expect(Object.keys(RESTORE_STATUS_LABELS).sort()).toEqual([...RESTORE_STATUSES].sort());
  });
});

describe('null as a real answer', () => {
  it('says "Not verified" rather than leaving the cell blank', () => {
    // A blank cell reads as missing data on exactly the row where it matters
    // most: verified is the difference between "we wrote something" and "we can
    // read what we wrote".
    expect(column('verifiedAt').value!(run({ verifiedAt: null }))).toBe('Not verified');
  });

  it('truncates a checksum on screen but exports it whole', () => {
    // An operator comparing against a storage console needs all of it, and a
    // CSV is exactly the artefact for that.
    expect(shortChecksum('a1b2c3d4e5f6a7b8c9d0')).toBe('a1b2c3d4e5f6…');
    expect(column('checksumSha256').value!(run())).toBe('a1b2c3d4e5f6a7b8c9d0');
    expect(column('checksumSha256').exportable).not.toBe(false);
  });

  it('leaves the restore column as an em dash for the archives never restored', () => {
    expect(column('restoreStatus').value!(run())).toBe('—');
    expect(column('restoreStatus').value!(run({ restoreStatus: 'swapping' }))).toBe('Swapping');
  });
});

describe('reading the filter model', () => {
  it('returns a plain scalar so a refetch effect can depend on it', () => {
    const model = [{ columnId: STATUS_COLUMN_ID, operator: 'is' as const, value: 'failed' }];
    expect(readIsFilter(model, STATUS_COLUMN_ID)).toBe('failed');
    expect(readIsFilter(model, TRIGGER_COLUMN_ID)).toBeUndefined();
  });

  it('narrows a stored or URL-supplied value to something the endpoint accepts', () => {
    expect(asRunStatus('stale')).toBe('stale');
    expect(asRunStatus('nonsense')).toBeUndefined();
    expect(asRunTrigger('pre_restore')).toBe('pre_restore');
    expect(asRunTrigger('nonsense')).toBeUndefined();
  });
});
