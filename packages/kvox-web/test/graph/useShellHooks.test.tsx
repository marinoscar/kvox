import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useInputModality } from '../../src/graph/ui/components/explorer/shell/useInputModality.js';
import { useReducedMotion } from '../../src/graph/ui/components/explorer/shell/useReducedMotion.js';
import { useWindowClass } from '../../src/graph/ui/components/explorer/shell/useWindowClass.js';
import { setViewportWidth } from '../../src/core/testing/index.js';
import { mockMedia, mockTouchInput, REDUCED_MOTION } from './shellMedia.js';

describe('useWindowClass', () => {
  it('follows the window across the 600 and 1200 boundaries', () => {
    setViewportWidth(390);
    const { result } = renderHook(() => useWindowClass());
    expect(result.current).toBe('compact');
    for (const [width, expected] of [
      [599, 'compact'],
      [600, 'medium'],
      [1199, 'medium'],
      [1200, 'expanded'],
      [390, 'compact'],
    ] as const) {
      act(() => setViewportWidth(width));
      expect(result.current).toBe(expected);
    }
  });
});

describe('useInputModality', () => {
  it('is pointer by default, whatever the width', () => {
    setViewportWidth(390);
    const { result } = renderHook(() => useInputModality());
    expect(result.current).toBe('pointer');
  });

  it('is touch for a coarse pointer, even in a desktop-wide window', () => {
    mockMedia({ '(pointer: coarse)': true });
    setViewportWidth(1440);
    expect(renderHook(() => useInputModality()).result.current).toBe('touch');
  });

  it('is touch when the input cannot hover', () => {
    mockMedia({ '(hover: none)': true });
    expect(renderHook(() => useInputModality()).result.current).toBe('touch');
  });

  it('is touch for a phone or tablet (coarse and no hover)', () => {
    mockTouchInput();
    expect(renderHook(() => useInputModality()).result.current).toBe('touch');
  });
});

describe('useReducedMotion', () => {
  it('reads prefers-reduced-motion', () => {
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false);
    mockMedia({ [REDUCED_MOTION]: true });
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true);
  });
});
