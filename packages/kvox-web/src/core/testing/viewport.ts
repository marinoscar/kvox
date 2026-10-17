// =============================================================================
// A query-aware window.matchMedia for jsdom
// =============================================================================
//
// jsdom implements no `matchMedia`, and a "always false" stub is not enough for
// a page that picks its layout with MUI's `useMediaQuery(theme.breakpoints.down
// ('sm'))`. This one parses `(min-width: Npx)` / `(max-width: Npx)` conditions
// (the form MUI emits, with or without a space, fractional values included)
// against a viewport width a test sets with `setViewportWidth`, and notifies
// every live `MediaQueryList` when a query flips, so `useMediaQuery` re-renders.
// Anything else (`prefers-color-scheme`) answers `false`.
// =============================================================================

const DEFAULT_VIEWPORT_WIDTH = 1440;
let viewportWidth = DEFAULT_VIEWPORT_WIDTH;

interface Entry {
  matches: boolean;
  listeners: Set<() => void>;
  recompute(): void;
}
const registry = new Set<Entry>();

function evaluate(query: string, width: number): boolean {
  const normalized = query.replace(/^@media\s*/, '').trim();
  const min = [...normalized.matchAll(/\(min-width:\s*([\d.]+)px\)/g)].map((m) => parseFloat(m[1]!));
  const max = [...normalized.matchAll(/\(max-width:\s*([\d.]+)px\)/g)].map((m) => parseFloat(m[1]!));
  if (min.length === 0 && max.length === 0) return false;
  return min.every((m) => width >= m) && max.every((m) => width <= m);
}

/**
 * Installs the query-aware `window.matchMedia`. Call once from the test setup file.
 *
 * @stability experimental
 */
export function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const entry: Entry = {
        matches: evaluate(query, viewportWidth),
        listeners: new Set(),
        recompute: () => {
          const next = evaluate(query, viewportWidth);
          if (next !== entry.matches) {
            entry.matches = next;
            entry.listeners.forEach((listener) => listener());
          }
        },
      };
      registry.add(entry);
      return {
        get matches() {
          return entry.matches;
        },
        media: query,
        onchange: null,
        addListener: (listener: () => void) => entry.listeners.add(listener),
        removeListener: (listener: () => void) => entry.listeners.delete(listener),
        addEventListener: (type: string, listener: () => void) => {
          if (type === 'change') entry.listeners.add(listener);
        },
        removeEventListener: (type: string, listener: () => void) => {
          if (type === 'change') entry.listeners.delete(listener);
        },
        dispatchEvent: () => false,
      };
    },
  });
}

/**
 * Sets the viewport width the mocked `matchMedia` answers against and notifies
 * live queries. Wrap the call in `act()` so React flushes the re-render.
 *
 * @param px - The width in CSS pixels.
 *
 * @stability experimental
 */
export function setViewportWidth(px: number): void {
  viewportWidth = px;
  registry.forEach((entry) => entry.recompute());
}

/**
 * Restores the default desktop width (1440px) and forgets every live query.
 *
 * @stability experimental
 */
export function resetViewportWidth(): void {
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
  registry.clear();
}
