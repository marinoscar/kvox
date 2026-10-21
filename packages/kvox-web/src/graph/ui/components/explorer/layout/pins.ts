/**
 * Pin persistence (GIC-07, #668): a pinned node stays where the user put it, and
 * the pins of the current view survive a reload of the tab.
 *
 * Stored in `sessionStorage` under a per-view key. Every access is wrapped: the
 * accessor throws in a private window, with blocked site data, or in a preview,
 * and the explorer must render and work without it.
 */

/** A pinned position. */
export interface Pin {
  x: number;
  y: number;
}

const PREFIX = 'kvox.graph.pins:';

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Reads the pins of a view.
 *
 * @param viewKey - Identifies the view (the seeds and filters the explorer shows).
 * @returns The pinned positions by node id; empty when none, or when storage is unavailable or corrupt.
 */
export function loadPins(viewKey: string): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  try {
    const raw = storage()?.getItem(PREFIX + viewKey);
    if (!raw) return pins;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return pins;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const pin = value as Partial<Pin> | null;
      if (pin && Number.isFinite(pin.x) && Number.isFinite(pin.y)) {
        pins.set(id, { x: pin.x as number, y: pin.y as number });
      }
    }
  } catch {
    return new Map();
  }
  return pins;
}

/**
 * Writes the pins of a view; an empty map removes the entry.
 *
 * @param viewKey - Identifies the view.
 * @param pins - The pinned positions by node id.
 */
export function savePins(viewKey: string, pins: ReadonlyMap<string, Pin>): void {
  try {
    const store = storage();
    if (!store) return;
    if (pins.size === 0) {
      store.removeItem(PREFIX + viewKey);
      return;
    }
    store.setItem(PREFIX + viewKey, JSON.stringify(Object.fromEntries(pins)));
  } catch {
    // Storage is a convenience; losing it only loses the persistence.
  }
}
