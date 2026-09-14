/**
 * Upload session persistence — issue #22, epic #19.
 *
 * Two properties matter here and nothing else does: the record round-trips,
 * and EVERY failure mode answers "no sessions" instead of throwing. The second
 * is the one that would go unnoticed in production — a private window, blocked
 * storage or a quota-exceeded origin is not an exotic case, and an exception
 * out of this module would take down the screen that renders the resume
 * prompt rather than merely omitting it.
 *
 * jsdom implements no IndexedDB, so the fake in `../utils/fakeIndexedDB` is
 * what makes the happy path reachable at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertUploadSessionMatches,
  deleteUploadSession,
  getUploadSession,
  listUploadSessions,
  matchUploadSession,
  saveUploadSession,
  UploadSessionMismatchError,
  type UploadSessionRecord,
} from '../../services/uploadSessions';
import { installFakeIndexedDB, type FakeIndexedDbControl } from '../utils/fakeIndexedDB';

const SESSION: UploadSessionRecord = {
  objectId: 'obj-1',
  transcriptId: 'transcript-1',
  fileName: 'recording.m4a',
  size: 1_048_576,
  lastModified: 1_700_000_000_000,
  partSize: 5_242_880,
  createdAt: 1_700_000_100_000,
};

function makeFile(overrides: Partial<{ name: string; size: number; lastModified: number }> = {}) {
  const name = overrides.name ?? SESSION.fileName;
  const size = overrides.size ?? SESSION.size;
  const lastModified = overrides.lastModified ?? SESSION.lastModified;
  // A real `File` of the declared size would allocate a megabyte per test; the
  // matcher reads `size` off the object, so a stub with the right shape is the
  // honest fixture here.
  return { name, size, lastModified } as File;
}

describe('upload sessions', () => {
  let idb: FakeIndexedDbControl;

  beforeEach(() => {
    idb = installFakeIndexedDB();
  });

  afterEach(() => {
    idb.uninstall();
  });

  describe('persistence', () => {
    it('round-trips a session and deletes it again', async () => {
      await saveUploadSession(SESSION);

      expect(await getUploadSession('obj-1')).toEqual(SESSION);
      expect(await listUploadSessions()).toEqual([SESSION]);

      await deleteUploadSession('obj-1');

      expect(await getUploadSession('obj-1')).toBeNull();
      expect(await listUploadSessions()).toEqual([]);
    });

    it('never stores the file itself — only its identifying metadata', async () => {
      await saveUploadSession(SESSION);

      const stored = [...(idb.rows('sessions')?.values() ?? [])];
      expect(stored).toHaveLength(1);
      // The guard from the module header, asserted rather than trusted: a
      // second copy of a multi-gigabyte recording in IndexedDB is how a
      // resumable upload kills the upload it was making resumable.
      expect(Object.keys(stored[0] as object).sort()).toEqual([
        'createdAt',
        'fileName',
        'lastModified',
        'objectId',
        'partSize',
        'size',
        'transcriptId',
      ]);
    });

    it('lists sessions newest first', async () => {
      await saveUploadSession({ ...SESSION, objectId: 'older', createdAt: 1_000 });
      await saveUploadSession({ ...SESSION, objectId: 'newer', createdAt: 9_000 });

      expect((await listUploadSessions()).map((session) => session.objectId)).toEqual([
        'newer',
        'older',
      ]);
    });

    it('overwrites the record for an object rather than duplicating it', async () => {
      await saveUploadSession(SESSION);
      await saveUploadSession({ ...SESSION, partSize: 999 });

      const sessions = await listUploadSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].partSize).toBe(999);
    });
  });

  describe('degradation', () => {
    it('answers "no sessions" when the database refuses to open', async () => {
      idb.failOpen(true);

      await expect(saveUploadSession(SESSION)).resolves.toBeUndefined();
      await expect(listUploadSessions()).resolves.toEqual([]);
      await expect(getUploadSession('obj-1')).resolves.toBeNull();
      await expect(deleteUploadSession('obj-1')).resolves.toBeUndefined();
    });

    it('answers "no sessions" where IndexedDB does not exist at all', async () => {
      idb.uninstall();

      await expect(saveUploadSession(SESSION)).resolves.toBeUndefined();
      await expect(listUploadSessions()).resolves.toEqual([]);
      await expect(getUploadSession('obj-1')).resolves.toBeNull();

      // Reinstall so the shared `afterEach` has something to uninstall.
      idb = installFakeIndexedDB();
    });
  });

  describe('matching a re-picked file', () => {
    it('accepts the same file', () => {
      expect(matchUploadSession(SESSION, makeFile())).toBe(true);
      expect(() => assertUploadSessionMatches(SESSION, makeFile())).not.toThrow();
    });

    it.each([
      ['a different name', { name: 'other.m4a' }],
      ['a different size', { size: SESSION.size + 1 }],
      // The one a name+size check would wave through: a re-export of the same
      // recording, identical name, identical length, different bytes.
      ['a different modification time', { lastModified: SESSION.lastModified + 1 }],
    ])('rejects %s', (_label, overrides) => {
      const file = makeFile(overrides);
      expect(matchUploadSession(SESSION, file)).toBe(false);
      expect(() => assertUploadSessionMatches(SESSION, file)).toThrow(
        UploadSessionMismatchError,
      );
    });

    it('names both files in the mismatch message so the user can act on it', () => {
      try {
        assertUploadSessionMatches(SESSION, makeFile({ name: 'wrong.m4a' }));
        throw new Error('expected a mismatch');
      } catch (error) {
        expect(error).toBeInstanceOf(UploadSessionMismatchError);
        expect((error as Error).message).toContain('wrong.m4a');
        expect((error as Error).message).toContain('recording.m4a');
      }
    });
  });
});
