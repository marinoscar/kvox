import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import {
  KvoxWebHostProvider,
  getBrowserFileAccess,
  useKvoxFileAccess,
} from '../../src/core/headless/index.js';
import type { KvoxFileAccessPort, KvoxWebHost } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';

function wrapperFor(host: KvoxWebHost) {
  return ({ children }: { children: ReactNode }) => (
    <KvoxWebHostProvider host={host}>{children}</KvoxWebHostProvider>
  );
}

describe('useKvoxFileAccess', () => {
  it("prefers the host's file access", () => {
    const files = { capabilities: { persistentFolders: true, watch: true, hashInHost: true } } as KvoxFileAccessPort;
    const host: KvoxWebHost = { ...createFakeKvoxWebHost(), files };
    const { result } = renderHook(() => useKvoxFileAccess(), { wrapper: wrapperFor(host) });
    expect(result.current).toBe(files);
  });

  it('falls back to one shared browser implementation', () => {
    const host = createFakeKvoxWebHost();
    const first = renderHook(() => useKvoxFileAccess(), { wrapper: wrapperFor(host) }).result.current;
    const second = renderHook(() => useKvoxFileAccess(), { wrapper: wrapperFor(host) }).result.current;
    expect(first).toBe(second);
    expect(first).toBe(getBrowserFileAccess());
    expect(first.capabilities.hashInHost).toBe(false);
  });
});
