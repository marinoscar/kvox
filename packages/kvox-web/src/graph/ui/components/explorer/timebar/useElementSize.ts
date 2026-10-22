/**
 * `useElementSize` — an element's content size in px, kept current with a
 * `ResizeObserver` (GIC-15, #676). Where nothing can be measured (a test DOM
 * has no layout) the fallback is returned, so the TimeBar still draws.
 */

import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * A width and height in px.
 *
 * @stability experimental
 */
export interface ElementSize {
  width: number;
  height: number;
}

/** Measures `ref`; a zero side (not laid out) falls back to `fallback`'s. */
export function useElementSize(ref: RefObject<HTMLElement | null>, fallback: ElementSize): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setSize((previous) =>
        Math.round(previous.width) === Math.round(box.width) && Math.round(previous.height) === Math.round(box.height)
          ? previous
          : { width: box.width, height: box.height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return { width: size.width > 0 ? size.width : fallback.width, height: size.height > 0 ? size.height : fallback.height };
}
