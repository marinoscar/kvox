/**
 * Persisted pane widths and collapse state of the Insight Canvas (GIC-08,
 * #669). `localStorage` per user and per window class, every read and write in
 * `try/catch`: storage is absent or throws in a private window, with blocked
 * site data, and in previews, and the layout must render without it.
 */

import type { WindowClass } from './useWindowClass.js';

/** Width limits (px) of the resizable panes. */
export const PANE_LIMITS = {
  facets: { default: 280, min: 220, max: 400 },
  inspector: { default: 360, min: 300, max: 520 },
} as const;

/**
 * What persists of the panes.
 *
 * @stability experimental
 */
export interface PaneState {
  facetsWidth: number;
  inspectorWidth: number;
  facetsCollapsed: boolean;
  inspectorCollapsed: boolean;
}

export const DEFAULT_PANE_STATE: PaneState = {
  facetsWidth: PANE_LIMITS.facets.default,
  inspectorWidth: PANE_LIMITS.inspector.default,
  facetsCollapsed: false,
  inspectorCollapsed: false,
};

/** Prefix of every key; the user id and the window class follow. */
export const PANE_STORAGE_PREFIX = 'kvox.explorer.panes.v1';

/** The storage key of one user's panes in one window class. */
export function paneStorageKey(userId: string | null | undefined, windowClass: WindowClass): string {
  return `${PANE_STORAGE_PREFIX}.${userId ?? 'anonymous'}.${windowClass}`;
}

/** `value` held inside `[min, max]`; a non-number is the `fallback`. */
export function clampWidth(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Validates whatever was stored: a bad or foreign value falls back to the default. */
export function sanitizePaneState(raw: unknown): PaneState {
  if (!raw || typeof raw !== 'object') return DEFAULT_PANE_STATE;
  const value = raw as Record<string, unknown>;
  return {
    facetsWidth: clampWidth(
      value.facetsWidth,
      PANE_LIMITS.facets.min,
      PANE_LIMITS.facets.max,
      PANE_LIMITS.facets.default,
    ),
    inspectorWidth: clampWidth(
      value.inspectorWidth,
      PANE_LIMITS.inspector.min,
      PANE_LIMITS.inspector.max,
      PANE_LIMITS.inspector.default,
    ),
    facetsCollapsed: value.facetsCollapsed === true,
    inspectorCollapsed: value.inspectorCollapsed === true,
  };
}

/** Reads the stored panes; the defaults when storage is unavailable, empty or corrupt. */
export function readPaneState(key: string): PaneState {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? sanitizePaneState(JSON.parse(raw)) : DEFAULT_PANE_STATE;
  } catch {
    return DEFAULT_PANE_STATE;
  }
}

/** Stores the panes; silently does nothing when storage is unavailable. */
export function writePaneState(key: string, state: PaneState): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Storage is a convenience: the panes just forget their size on reload.
  }
}
