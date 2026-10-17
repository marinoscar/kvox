import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import {
  KvoxHostMissingError,
  KvoxWebHostProvider,
  useHasPermission,
  useKvoxHost,
  useKvoxPermissionCheck,
  useKvoxViewer,
} from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';

function wrapperFor(host: ReturnType<typeof createFakeKvoxWebHost>) {
  return ({ children }: { children: ReactNode }) => (
    <KvoxWebHostProvider host={host}>{children}</KvoxWebHostProvider>
  );
}

describe('KvoxWebHostProvider', () => {
  it('provides the host to every hook below it', () => {
    const host = createFakeKvoxWebHost();
    const { result } = renderHook(() => useKvoxHost(), { wrapper: wrapperFor(host) });

    expect(result.current).toBe(host);
  });

  it('refuses to run a hook without a provider, with a named error', () => {
    // React logs the error it re-throws; keep the test output quiet.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => renderHook(() => useKvoxHost())).toThrow(KvoxHostMissingError);
      expect(() => renderHook(() => useKvoxHost())).toThrow(/KvoxWebHostProvider/);
      expect(() => renderHook(() => useHasPermission('x'))).toThrow(KvoxHostMissingError);
    } finally {
      spy.mockRestore();
    }
  });

  it('names the error so a stack trace says what is missing', () => {
    expect(new KvoxHostMissingError().name).toBe('KvoxHostMissingError');
  });
});

describe('viewer and permission hooks', () => {
  it('reads the viewer from the host', () => {
    const host = createFakeKvoxWebHost({ viewer: { userId: 'u-9', permissions: ['a:read'] } });
    const { result } = renderHook(() => useKvoxViewer(), { wrapper: wrapperFor(host) });

    expect(result.current?.userId).toBe('u-9');
    expect(result.current?.permissions.has('a:read')).toBe(true);
  });

  it('answers whether the viewer holds a permission', () => {
    const host = createFakeKvoxWebHost({ viewer: { permissions: ['a:read'] } });
    const held = renderHook(() => useHasPermission('a:read'), { wrapper: wrapperFor(host) });
    const missing = renderHook(() => useHasPermission('a:write'), { wrapper: wrapperFor(host) });

    expect(held.result.current).toBe(true);
    expect(missing.result.current).toBe(false);
  });

  it('holds no permission when nobody is signed in', () => {
    const host = createFakeKvoxWebHost({ viewer: null });
    const { result } = renderHook(
      () => ({ viewer: useKvoxViewer(), has: useHasPermission('a:read'), check: useKvoxPermissionCheck() }),
      { wrapper: wrapperFor(host) },
    );

    expect(result.current.viewer).toBeNull();
    expect(result.current.has).toBe(false);
    expect(result.current.check('a:read')).toBe(false);
  });
});
