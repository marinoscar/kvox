/**
 * Open an `https` address through the host's opener, or in a new tab.
 *
 * @remarks
 * Anything but `https` is ignored: the address comes from the host or from the
 * Copilot runtime and is never trusted to be a safe scheme. This is not a
 * network call of the component; it hands the address to the browser or to the
 * host (KVox Desktop: `shell.openExternal` over IPC).
 */
export function openExternalUrl(url: string, onOpenExternal?: (url: string) => void): void {
  if (!/^https:\/\//i.test(url)) return;
  if (onOpenExternal) {
    onOpenExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
