/**
 * Which folder each library is bound to ON THIS DEVICE (issue #720). The binding is
 * the file-access port's (`getLibraryFolder` / `setLibraryFolder`), never the
 * server's: the same library may live in another folder on another machine.
 */

import { useCallback, useEffect, useState } from 'react';

import { useIsMounted, useKvoxFileAccess } from '../../../core/headless/index.js';
import type { KvoxFileAccessPort, KvoxFolderRef } from '../../../core/headless/index.js';

/**
 * What {@link useLibraryFolders} returns.
 *
 * @stability experimental
 */
export interface LibraryFolders {
  /** The folder of each library id; `null` when not bound on this device; absent while loading. */
  folders: Readonly<Record<string, KvoxFolderRef | null>>;
  /** The device's file access. */
  port: KvoxFileAccessPort;
  /**
   * The folder to sync a library with: its bound folder when the port keeps folders
   * across reloads, else a fresh pick (bound before it is returned). `null` when the
   * person cancels the picker.
   */
  folderForSync: (libraryId: string) => Promise<KvoxFolderRef | null>;
  /** Asks for a folder and binds the library to it. `null` when cancelled. */
  connect: (libraryId: string) => Promise<KvoxFolderRef | null>;
  /** Records a binding made elsewhere. */
  remember: (libraryId: string, ref: KvoxFolderRef | null) => void;
}

/**
 * The device folders of a set of libraries.
 *
 * @param libraryIds - The libraries to look up.
 * @returns The bindings and the actions over them.
 *
 * @stability experimental
 */
export function useLibraryFolders(libraryIds: readonly string[]): LibraryFolders {
  const port = useKvoxFileAccess();
  const isMounted = useIsMounted();
  const [folders, setFolders] = useState<Record<string, KvoxFolderRef | null>>({});
  const key = libraryIds.join('\n');

  useEffect(() => {
    let cancelled = false;
    const ids = key === '' ? [] : key.split('\n');
    void Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await port.getLibraryFolder(id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setFolders((previous) => ({ ...previous, ...Object.fromEntries(pairs) }));
    });
    return () => {
      cancelled = true;
    };
  }, [key, port]);

  const remember = useCallback((libraryId: string, ref: KvoxFolderRef | null) => {
    setFolders((previous) => ({ ...previous, [libraryId]: ref }));
  }, []);

  const connect = useCallback(
    async (libraryId: string) => {
      const ref = await port.pickFolder();
      if (!ref) return null;
      await port.setLibraryFolder(libraryId, ref);
      if (isMounted()) remember(libraryId, ref);
      return ref;
    },
    [isMounted, port, remember],
  );

  const folderForSync = useCallback(
    async (libraryId: string) => {
      if (port.capabilities.persistentFolders) {
        const bound = folders[libraryId] ?? (await port.getLibraryFolder(libraryId).catch(() => null));
        if (bound) return bound;
      }
      return connect(libraryId);
    },
    [connect, folders, port],
  );

  return { folders, port, folderForSync, connect, remember };
}
