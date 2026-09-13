import { APP_NAME } from '@app/shared';

import {
  ACTIVE_STORAGE_PROVIDER_ID,
  BACKUP_ARCHIVE_FORMAT,
  BACKUP_KEY_PREFIX,
  BACKUP_NAME_SLUG,
  assertUsableStorageProvider,
  buildBackupStorageKey,
  compactTimestamp,
  isUsableStorageProvider,
} from './db-backup-storage';
import { DatabaseBackupStorageProviderError } from './db-backup.errors';

describe('backup storage keys', () => {
  const at = new Date('2026-09-07T02:00:00.000Z');
  const runId = '11111111-2222-3333-4444-555555555555';

  it('derives a key under the documented prefix, partitioned by year and month', () => {
    expect(buildBackupStorageKey(at, runId)).toBe(
      `${BACKUP_KEY_PREFIX}${BACKUP_NAME_SLUG}/2026/09/` +
        `${BACKUP_NAME_SLUG}-20260907T020000Z-${runId}.dump`
    );
  });

  it('contains the run id, so two runs in the same second cannot collide', () => {
    const a = buildBackupStorageKey(at, 'aaaaaaaa-0000-0000-0000-000000000000');
    const b = buildBackupStorageKey(at, 'bbbbbbbb-0000-0000-0000-000000000000');

    expect(a).not.toBe(b);
  });

  it('sorts lexicographically in time order', () => {
    const earlier = buildBackupStorageKey(new Date('2026-09-07T01:59:59.000Z'), runId);
    const later = buildBackupStorageKey(new Date('2026-09-07T02:00:01.000Z'), runId);

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('formats the timestamp in UTC, never in local time', () => {
    // A local-time key would repeat an hour every autumn; see the module header.
    expect(compactTimestamp(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z');
  });

  it('hard-codes no application, product or repository name', () => {
    // The slug is DERIVED, so a fork that rebrands gets a rebranded key space
    // and two applications from this template can share one bucket. The
    // assertion is deliberately about derivation, not about a literal.
    const expected = APP_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    expect(BACKUP_NAME_SLUG).toBe(expected.length > 0 ? expected : 'app');
    expect(BACKUP_KEY_PREFIX).toBe('database-backups/');
  });

  it('records the custom archive format pg_restore can list and parallel-restore', () => {
    expect(BACKUP_ARCHIVE_FORMAT).toBe('custom');
  });
});

describe('the databaseBackup.storageProvider constraint', () => {
  it('accepts an empty or absent value as "whatever provider is active"', () => {
    expect(isUsableStorageProvider('')).toBe(true);
    expect(isUsableStorageProvider('   ')).toBe(true);
    expect(isUsableStorageProvider(null)).toBe(true);
    expect(isUsableStorageProvider(undefined)).toBe(true);
  });

  it('accepts the active provider, trimmed and case-insensitively', () => {
    expect(isUsableStorageProvider(ACTIVE_STORAGE_PROVIDER_ID)).toBe(true);
    expect(isUsableStorageProvider(`  ${ACTIVE_STORAGE_PROVIDER_ID.toUpperCase()}  `)).toBe(true);
  });

  it('rejects a value naming a provider this deployment does not have', () => {
    expect(isUsableStorageProvider('gcs')).toBe(false);
    expect(() => assertUsableStorageProvider('gcs')).toThrow(DatabaseBackupStorageProviderError);
  });

  it('names both the configured and the active provider in the failure', () => {
    // The operator has to be able to tell what they set from what exists;
    // "invalid storage provider" would send them to the wrong place.
    try {
      assertUsableStorageProvider('azure-blob');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseBackupStorageProviderError);
      const typed = error as DatabaseBackupStorageProviderError;
      expect(typed.configured).toBe('azure-blob');
      expect(typed.active).toBe(ACTIVE_STORAGE_PROVIDER_ID);
      expect(typed.message).toContain('azure-blob');
      expect(typed.message).toContain(ACTIVE_STORAGE_PROVIDER_ID);
    }
  });

  it('survives downlevelling: instanceof still works on the thrown error', () => {
    // Not ceremonial — see the header of db-backup.errors.ts.
    const error = new DatabaseBackupStorageProviderError('gcs', 's3');

    expect(error instanceof DatabaseBackupStorageProviderError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });
});
