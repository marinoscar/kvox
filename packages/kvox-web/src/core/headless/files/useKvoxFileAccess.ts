import { useKvoxHost } from '../host.js';
import { createBrowserFileAccess } from './browser.js';
import type { KvoxFileAccessPort } from './types.js';

let browserFileAccess: KvoxFileAccessPort | null = null;

/**
 * The browser file access, created once per page and shared by every caller:
 * its in-memory folders (the directory-input fallback) must outlive the
 * component that picked them.
 *
 * @returns The singleton.
 *
 * @stability experimental
 */
export function getBrowserFileAccess(): KvoxFileAccessPort {
  browserFileAccess ??= createBrowserFileAccess();
  return browserFileAccess;
}

/**
 * The file access of the current host: `KvoxWebHost.files` when the host has
 * one (KVox Desktop), the browser implementation otherwise.
 *
 * @returns The port. Stable for the life of the host.
 *
 * @stability experimental
 */
export function useKvoxFileAccess(): KvoxFileAccessPort {
  const host = useKvoxHost();
  return host.files ?? getBrowserFileAccess();
}
